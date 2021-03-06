// tslint:disable: no-console
import { SqliteStore } from '../sqlite-store';
import { StoreRecord } from '../models/store-record.model';
import { StoreChangeLog } from '../models/store-change-log.model';

import { BehaviorSubject, fromEvent, mapTo, merge, Observable, of } from 'rxjs';
import { StoreChangeLogSubscriber } from '../store-change-log.subscriber';
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

export abstract class CloudStore {
  // @ts-ignore
  protected networkSubject: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(global.navigator.onLine);
  public network$: Observable<boolean> = this.networkSubject.asObservable();
  public get network(): boolean {
    return this.networkSubject.getValue();
  }

  public userSubject: BehaviorSubject<BaseUser | null> = new BehaviorSubject<BaseUser | null>(null);
  public user$: Observable<BaseUser | null> = this.userSubject.asObservable();
  public get user(): BaseUser | null {
    return this.userSubject.getValue();
  }

  protected downloadingSubject: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);
  public downloading$: Observable<boolean> = this.downloadingSubject.asObservable();
  public get downloading(): boolean {
    return this.downloadingSubject.getValue();
  }

  protected privateCloudInitialized: boolean = false;
  protected localStore: SqliteStore;
  private uploading: boolean = false;
  private changeLogSubscriber = new StoreChangeLogSubscriber(this);
  private lastUser: BaseUser | null = null;
  private updatingCloudFromChangeLog: boolean = false;
  private queueUpdateCloudFromChangeLog: boolean = false;

  // Note: Must be able to construct object to set up observables immediately at app runtime. We separate out
  //   initialzation so that we can asynchronously set up the cloud app, sqlite store, etc..
  protected constructor(
    protected UserModel: typeof BaseUser,
    protected publicRecords: typeof StoreRecord[],
    protected privateRecords: typeof StoreRecord[],
  ) {}

  protected async _initializeBase(localStore: SqliteStore) {
    this.localStore = localStore;
    const user = await this.UserModel.findOne({where: {isDeleted: false}, order: { changeId: 'DESC' } });
    // console.log('[CloudStore - initialize]', this.UserModel, user);
    this.userSubject.next(user);
    this.subscribeNetwork();
    this.downloadingSubject.next(true);
    await this.subscribePublicCloud();
    if (user) {
      await this.subscribePrivateCloud();
    }
    this.downloadingSubject.next(false);
    this.subscribeLocalUser(); // Handles private cloud subscription
  }

  private subscribeNetwork() {
    const networkObservable = merge(
      of(global.navigator.onLine),
      fromEvent(global.window, 'online').pipe(mapTo(true)),
      fromEvent(global.window, 'offline').pipe(mapTo(false)),
    );
    networkObservable.subscribe(this.networkSubject);
    this.downloading$.subscribe(async (d) => await this.updateCloudFromChangeLog());
  }

  private subscribeLocalUser() {
    console.log('[CloudStore - subscribeLocalUser] setup.');
    this.userSubject.subscribe((user) => {
      // Private cloud subscriptions depend on auth state and local user availability so we can subscribe
      // This may mess with sign out logic... need to think...
      console.log('[CloudStore - subscribeLocalUser] ', this.lastUser, user);
      if (this.lastUser?.authId !== user?.authId) {
        if (user?.authId) {
          console.log('[CloudStore - subscribeLocalUser] subscribing to private cloud...');
          this.downloadingSubject.next(true);
          this.subscribePrivateCloud().then((_) => {
            this.downloadingSubject.next(false);
          });
        } else {
          this.unsubscribePrivateCloud();
        }
      } else {
        console.log('[CloudStore - subscribeLocalUser] already subscribed');
      }

      this.lastUser = user;
    });
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
      console.warn('[updateCloudFromChangeLog] No network, not updating cloud.');
      return;
    }

    // Don't updateCloud until cloud subscriptions are set up and we finish downloading
    if (!this.privateCloudInitialized) {
      console.warn('[updateCloudFromChangeLog] Subscriptions not yet initialized, not updating cloud.');
      return;
    }

    if (this.downloading) {
      console.warn('[updateCloudFromChangeLog] Still downloading, not updating cloud.');
      return;
    }

    if (this.updatingCloudFromChangeLog) {
      console.log('[updateCloudFromChangeLog] Still updating previous entry, queuing to run again.');
      this.queueUpdateCloudFromChangeLog = true;
      return;
    }

    this.updatingCloudFromChangeLog = true;
    this.queueUpdateCloudFromChangeLog = false;
    // @ts-ignore
    const changes = await StoreChangeLog.find();
    // console.log(`[updateCloudFromChangeLog] Changes to update: ${changes.length}`);
    for (const change of changes) {
      console.log('[updateCloudFromChangeLog], ', change);
      const record = await change.getRecord(this.localStore.dataSource);
      console.log('[updateCloudFromChangeLog] record: ', record);
      if (record != null) {
        try {
          console.log('[updateCloudFromChangeLog] stopping subscription');
          this.unsubscribeRecord(record.constructor());

          console.log('[updateCloudFromChangeLog] update store record');
          const newRecord = await this.updateStoreRecord(record);

          console.log('[updateCloudFromChangeLog] done, now remove change');
          await change.remove();

          console.log('[updateCloudFromChangeLog] save local record');
          await newRecord.save({ listeners: false }, false);

          console.log('[updateCloudFromChangeLog] starting subscription');
          await this.subscribeRecord(record.constructor(), record.isPrivate); // TODO: This never seems to resolve

          console.log('[updateCloudFromChangeLog] done removing change');
        } catch (err) {
          console.warn(err);
        }
      } else {
        console.log('[updateCloudFromChangeLog] Local record not found, deleting change');
        await change.remove();
      }
    }

    this.updatingCloudFromChangeLog = false;
    if (this.queueUpdateCloudFromChangeLog) {
      this.updateCloudFromChangeLog();
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
    // @ts-ignore
    const localChange = await StoreChangeLog.findOne({ where: { recordId: obj.id } });
    if (localChange) {
      // console.log('[resolveRecords] Local change, need to resolve!', this.localStore);
      // @ts-ignore
      const localCopy = await recordType.findOneBy({ id: obj.id });
      return await this.localStore.resolve(obj, localCopy);
    } else {
      // console.log('[resolveRecords] No local change, resolving from cloud.', this.localStore);
      return await this.localStore.resolve(obj);
    }
  }
}
