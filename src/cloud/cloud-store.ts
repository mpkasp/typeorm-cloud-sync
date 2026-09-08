// tslint:disable: no-console
import { SqliteStore } from '../sqlite-store';
import { StoreRecord } from '../models/store-record.model';
import { StoreChangeLog } from '../models/store-change-log.model';

import { DataSource, EntityManager, EntitySubscriberInterface } from 'typeorm/browser';
import { BehaviorSubject, fromEvent, mapTo, merge, Observable, of, Subscription } from 'rxjs';
import { StoreChangeLogSubscriber } from '../store-change-log.subscriber';
import { BaseUserSubscriber } from '../base-user.subscriber';
import { BaseUser } from '../models/base-user.model';

// Each store needs CRUD
// A store needs to handle private & public data
//  Public data:
//    Subscribe when constructed
//  Private data:
//    Subscribe on authenticated & local user; unsubscribe on loss of either
//
// When do you update cloud from changelog?
//     When auth state changes --> cloud subscriptions then get set up --> then downloading happens
//   After cloud subscriptions get set up, after downloading
// Public Cloud States:
//    1. Uninitialized
//    2. Initializing: setting up subscriptions, downloading
//    3. Initialized: public subscriptions set up, syncing to/from local store (READ ONLY, no changelog)
// Private Cloud States:
//    1. Uninitialized
//    2. Initializing: setting up subscriptions, downloading, user has been authenticated
//    3. Initialized: we are subscribed to local data
//
// UpdateCloudFromChangeLog
//  Setting up subscriptions doesn't need to be asynchronous
//  Subscription setup can be immediate, then we immediately set some boolean to say "subscriptions are re-setting"
//  We clear that boolean once "downloading" is done.
//
// What starts/stops private cloud subscriptions?
// Network, and User
// If !network || !user unsubscribe
// else subscribe

// Network state reaches a CloudStore as an observable rather than being read off `navigator`/
// `window` directly, so a store can be constructed off-browser (unit tests, SSR). The default
// source is the original browser behaviour.
function isOnline(): boolean {
  // Node >= 21 defines `navigator` but no `onLine`, so presence of the global is not enough.
  const online = typeof navigator === 'undefined' ? undefined : navigator.onLine;
  return typeof online === 'boolean' ? online : true;
}

export function browserNetwork$(): Observable<boolean> {
  if (typeof window === 'undefined') {
    return of(isOnline());
  }
  return merge(
    of(isOnline()),
    fromEvent(window, 'online').pipe(mapTo(true)),
    fromEvent(window, 'offline').pipe(mapTo(false)),
  );
}

export abstract class CloudStore {
  protected networkSubject: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(isOnline());
  public network$: Observable<boolean> = this.networkSubject.asObservable();
  public get network(): boolean {
    return this.networkSubject.getValue();
  }

  public userSubject: BehaviorSubject<BaseUser | null> = new BehaviorSubject<BaseUser | null>(null);
  public user$: Observable<BaseUser | null> = this.userSubject.asObservable();
  public get user(): BaseUser | null {
    return this.userSubject.getValue();
  }

  // `downloading` is a refcount rather than a flag because setup and live snapshot deliveries can be
  // in flight at the same time. As a boolean, whichever finished first reported "done" while the
  // others were still writing. Subscribers only see a transition when the count leaves or reaches 0.
  private downloadCount: number = 0;
  protected downloadingSubject: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);
  public downloading$: Observable<boolean> = this.downloadingSubject.asObservable();
  public get downloading(): boolean {
    return this.downloadingSubject.getValue();
  }

  protected privateCloudInitialized: boolean = false;
  protected localStore: SqliteStore;
  private uploading: boolean = false;
  private attachedSubscribers: EntitySubscriberInterface<any>[] = [];
  private readonly subscriptions = new Subscription();
  private drainInFlight: Promise<void> | null = null;
  private lastUser: BaseUser | null = null;
  private updatingCloudFromChangeLog: boolean = false;
  private queueUpdateCloudFromChangeLog: boolean = false;

  // Hold the downloading indicator up for the duration of `work`. Nests: only the outermost pair emits.
  protected async trackDownload<T>(work: () => Promise<T>): Promise<T> {
    this.beginDownload();
    try {
      return await work();
    } finally {
      this.endDownload();
    }
  }

  private beginDownload() {
    if (this.downloadCount++ === 0) {
      this.downloadingSubject.next(true);
    }
  }

  private endDownload() {
    if (this.downloadCount > 0 && --this.downloadCount === 0) {
      this.downloadingSubject.next(false);
    }
  }

  // Note: Must be able to construct object to set up observables immediately at app runtime. We separate out
  //   initialzation so that we can asynchronously set up the cloud app, sqlite store, etc..
  protected constructor(
    protected UserModel: typeof BaseUser,
    protected publicRecords: typeof StoreRecord[],
    protected privateRecords: typeof StoreRecord[],
    private readonly networkSource: Observable<boolean> = browserNetwork$(),
  ) {}

  // The EntityManager backing this store's DataSource. Reads and writes below go through it rather
  // than the entity classes' globally bound DataSource, so a store only touches its own database.
  protected get manager(): EntityManager {
    return this.localStore.manager;
  }

  protected async _initializeBase(localStore: SqliteStore) {
    this.localStore = localStore;
    this.attachSubscribers(localStore.dataSource);
    const user = await this.manager
      .getRepository(this.UserModel)
      .findOne({ where: { isDeleted: false }, order: { changeId: 'DESC' } });
    // console.log('[CloudStore - initialize]', this.UserModel, user);
    this.userSubject.next(user);
    this.subscribeNetwork();
    await this.trackDownload(async () => {
      await this.subscribePublicCloud();
      if (user) {
        await this.subscribePrivateCloud();
      }
    });
    // Seed lastUser so the userSubject replay that subscribeLocalUser receives on subscribe is
    // recognised as the user we just subscribed for. Otherwise it re-enters subscribePrivateCloud —
    // a no-op behind its own guard — and flickers the indicator on and straight back off.
    this.lastUser = user;
    this.subscribeLocalUser(); // Handles private cloud subscription
  }

  // A tenant's subscribers live on that tenant's DataSource, so a commit routes to the CloudStore
  // owning the database it happened in rather than to whichever store registered last.
  private attachSubscribers(dataSource: DataSource) {
    this.detachSubscribers();
    this.attachedSubscribers = [new StoreChangeLogSubscriber(this), new BaseUserSubscriber(this.UserModel, this)];
    dataSource.subscribers.push(...this.attachedSubscribers);
  }

  private detachSubscribers() {
    const subscribers = this.localStore?.dataSource?.subscribers;
    if (subscribers) {
      this.attachedSubscribers.forEach((subscriber) => {
        const index = subscribers.indexOf(subscriber);
        if (index >= 0) {
          subscribers.splice(index, 1);
        }
      });
    }
    this.attachedSubscribers = [];
  }

  // Resolves once no drain is in flight, so a caller can tear down the DataSource without pulling
  // it out from under one. Bounded: a cloud call that never settles (see the subscribeRecord TODO
  // in updateCloudFromChangeLog) must not be able to block disposal forever.
  public async whenIdle(timeoutMs: number = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.drainInFlight) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        console.warn('[CloudStore] timed out waiting for the change-log drain to finish');
        return;
      }
      let timer: any;
      await Promise.race([
        this.drainInFlight,
        new Promise<void>((resolve) => (timer = setTimeout(resolve, remaining))),
      ]);
      clearTimeout(timer);
    }
  }

  // Release this tenant's hold on its DataSource and cloud. Leaves other tenants untouched.
  public dispose() {
    this.detachSubscribers();
    this.unsubscribePrivateCloud();
    this.subscriptions.unsubscribe();
  }

  private subscribeNetwork() {
    // Forwarding values instead of subscribing the subject itself keeps a completing source
    // (the off-browser default) from completing network$.
    this.subscriptions.add(this.networkSource.subscribe((online) => this.networkSubject.next(online)));
    // Fire-and-forget with its own catch: an unhandled rejection here (a drain racing a disposed
    // tenant's destroyed DataSource, say) would otherwise take down the process.
    this.subscriptions.add(
      this.downloading$.subscribe(() => {
        void this.updateCloudFromChangeLog().catch((e) =>
          console.warn('[CloudStore] background cloud push failed', e),
        );
      }),
    );
  }

  private subscribeLocalUser() {
    console.debug('[CloudStore - subscribeLocalUser] setup.');
    const subscription = this.userSubject.subscribe((user) => {
      // Private cloud subscriptions depend on auth state and local user availability so we can subscribe
      // This may mess with sign out logic... need to think...
      console.debug('[CloudStore - subscribeLocalUser] ', this.lastUser, user);
      if (this.lastUser?.authId !== user?.authId) {
        if (user?.authId) {
          console.debug('[CloudStore - subscribeLocalUser] subscribing to private cloud...');
          // Fire-and-forget with its own catch: a rejected subscribe used to leave the indicator
          // stuck on forever, which also blocked updateCloudFromChangeLog for the rest of the session.
          void this.trackDownload(() => this.subscribePrivateCloud()).catch((e) =>
            console.warn('[CloudStore - subscribeLocalUser] private cloud subscribe failed', e),
          );
        } else {
          this.unsubscribePrivateCloud();
        }
      } else {
        console.debug('[CloudStore - subscribeLocalUser] already subscribed');
      }

      this.lastUser = user;
    });
    this.subscriptions.add(subscription);
  }

  // Used when logging out and clearing database to trigger unsubscribing from cloud
  public resetLocalUser() {
    this.userSubject.next(null);
  }

  // *
  // Cloud operations
  // *

  // Create an object in the cloud from a local StoreRecord
  public abstract create(obj: StoreRecord): Promise<any>;

  // Update an object in the cloud from a local StoreRecord
  public abstract update(obj: StoreRecord): Promise<any>;

  // Logic of updating a StoreRecord in a transaction: bumps the changeId, sets record change timestamp, updates
  // metadata table etc...
  public abstract updateStoreRecord(obj: StoreRecord): Promise<StoreRecord>;

  // Delete an object in the cloud
  public abstract delete(obj: StoreRecord, fromDb: boolean): Promise<any>;

  // Deserialize object from the cloud into local object in dictionary format
  protected abstract deserialize(document: any): any;

  // *
  //  Set up cloud subscriptions
  // *
  protected abstract subscribePublicCloud(): Promise<any>;

  protected abstract subscribePrivateCloud(): Promise<any>;

  protected abstract unsubscribePrivateCloud(): any;

  protected abstract subscribeRecord(recordName: typeof StoreRecord, isPrivate: boolean): Promise<any>;

  protected abstract unsubscribeRecord(recordName: typeof StoreRecord): any;

  // No reason to unsubscribe from public cloud

  // *
  // Sync functions
  // *
  // Update the cloud with any local changes stored in the change log - we don't want to call this until
  // TODO: This could be a database write error failure point - if we receive multiple changes in a row from the cloud
  //   the local DB may get 2 updates in a row and collide. To fix this we can consider populating a queue to update the DB
  public async updateCloudFromChangeLog() {
    if (!this.networkSubject.getValue()) {
      console.debug('[updateCloudFromChangeLog] No network, not updating cloud.');
      return;
    }

    // Don't updateCloud until cloud subscriptions are set up and we finish downloading
    if (!this.privateCloudInitialized) {
      console.debug('[updateCloudFromChangeLog] Subscriptions not yet initialized, not updating cloud.');
      return;
    }

    if (this.downloading) {
      console.debug('[updateCloudFromChangeLog] Still downloading, not updating cloud.');
      return;
    }

    if (this.updatingCloudFromChangeLog) {
      console.debug('[updateCloudFromChangeLog] Still updating previous entry, queuing to run again.');
      this.queueUpdateCloudFromChangeLog = true;
      return;
    }

    this.updatingCloudFromChangeLog = true;
    this.queueUpdateCloudFromChangeLog = false;
    let drainFinished: () => void = () => undefined;
    this.drainInFlight = new Promise<void>((resolve) => (drainFinished = resolve));
    try {
      const changes = await this.manager.getRepository(StoreChangeLog).find();
      // console.log(`[updateCloudFromChangeLog] Changes to update: ${changes.length}`);
      for (const change of changes) {
        console.debug('[updateCloudFromChangeLog], ', change);
        const record = await change.getRecordWithManager(this.manager);
        console.debug('[updateCloudFromChangeLog] record: ', record);
        if (record != null) {
          try {
            console.debug('[updateCloudFromChangeLog] stopping subscription');
            this.unsubscribeRecord(record.constructor as typeof StoreRecord);

            console.debug('[updateCloudFromChangeLog] update store record');
            const newRecord = await this.updateStoreRecord(record);

            console.debug('[updateCloudFromChangeLog] done, now remove change');
            await this.manager.remove(change);

            console.debug('[updateCloudFromChangeLog] save local record');
            await newRecord.saveWithManager(this.manager, { listeners: false }, false);

            console.debug('[updateCloudFromChangeLog] starting subscription');
            await this.subscribeRecord(record.constructor as typeof StoreRecord, record.isPrivate); // TODO: This never seems to resolve

            console.debug('[updateCloudFromChangeLog] done removing change');
          } catch (err) {
            console.warn(err);
          }
        } else {
          console.debug('[updateCloudFromChangeLog] Local record not found, deleting change');
          await this.manager.remove(change);
        }
      }
    } finally {
      this.drainInFlight = null;
      drainFinished();
      this.updatingCloudFromChangeLog = false;
    }

    if (this.queueUpdateCloudFromChangeLog) {
      void this.updateCloudFromChangeLog().catch((e) =>
        console.warn('[updateCloudFromChangeLog] queued cloud push failed', e),
      );
    }
  }

  // Resolve a list of records
  protected async resolveRecords(recordType: typeof StoreRecord, objs: StoreRecord[]) {
    const resolvedRecords: StoreRecord[] = [];
    for (const obj of objs) {
      // Only need to resolve issues if there's also a local change pending...
      const resolvedRecord = await this.resolveRecord(recordType, obj);
      if (resolvedRecord !== null) {
        resolvedRecords.push(resolvedRecord);
      }
    }
    return resolvedRecords;
  }

  // Helper to call proper resolve function when a new object is received from the cloud
  protected async resolveRecord(recordType: typeof StoreRecord, obj: StoreRecord) {
    const localChange = await this.manager.getRepository(StoreChangeLog).findOne({ where: { recordId: obj.id } });
    if (localChange) {
      // console.log('[resolveRecords] Local change, need to resolve!', this.localStore);
      const localCopy = (await this.manager.getRepository(recordType).findOneBy({ id: obj.id })) as StoreRecord;
      return await this.localStore.resolve(obj, localCopy);
    } else {
      // console.log('[resolveRecords] No local change, resolving from cloud.', this.localStore);
      return await this.localStore.resolve(obj);
    }
  }
}
