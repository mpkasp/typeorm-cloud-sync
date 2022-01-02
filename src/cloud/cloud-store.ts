// tslint:disable: no-console
import { SqliteStore } from '../sqlite-store';
import { StoreRecord } from '../models/store-record.model';
import { StoreChangeLog } from '../models/store-change-log.model';

import { BehaviorSubject, fromEvent, mapTo, merge, Observable, of, startWith, Subscription } from 'rxjs';
import { StoreChangeLogSubscriber } from '../store-change-log.subscriber';
import { BaseUser } from '../models/base-user.model';

// Each store needs CRUD
// A store needs to handle private & public data
//  Public data:
//    Subscribe when constructed
//  Private data:
//    Subscribe on authenticated & local user; unsubscribe on loss of either

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

// UpdateCloudFromChangeLog
//  Setting up subscriptions doesn't need to be asynchronous
//  Subscription setup can be immediate, then we immediately set some boolean to say "subscriptions are re-setting"
//  We clear that boolean once "downloading" is done.

// What starts/stops private cloud subscriptions?
// Network, and User
// If !network || !user unsubscribe
// else subscribe

export abstract class CloudStore {
  protected networkSubject: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(navigator.onLine);
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

  readonly privateCloudInitialized: boolean = false;
  private changeLogSubscriber = new StoreChangeLogSubscriber(this);
  private lastUser: BaseUser | null = this.user;

  protected constructor(
    readonly localStore: SqliteStore,
    protected UserModel: typeof BaseUser,
    protected publicRecords: typeof StoreRecord[],
    protected privateRecords: typeof StoreRecord[],
  ) {}

  protected async initialize() {
    this.subscribeNetwork();
    console.log('[CloudStore - initialize]');
    this.downloadingSubject.next(true);
    await this.subscribePublicCloud();
    console.log('[CloudStore - initialize] finished subscription to public cloud.');
    this.downloadingSubject.next(false);
    this.subscribeLocalUser(); // Handles private cloud subscription
  }

  private subscribeNetwork() {
    const networkObservable = merge(
      of(navigator.onLine),
      fromEvent(window, 'online').pipe(mapTo(true)),
      fromEvent(window, 'offline').pipe(mapTo(false)),
    );
    networkObservable.subscribe(this.networkSubject);
    this.downloading$.subscribe(async (d) => await this.updateCloudFromChangeLog());
  }

  private subscribeLocalUser() {
    this.user$.subscribe(async (user) => {
      // Private cloud subscriptions depend on auth state and local user availability so we can subscribe
      // This may mess with sign out logic... need to think...
      if (this.lastUser?.authId !== user?.authId) {
        if (user?.authId) {
          this.downloadingSubject.next(true);
          await this.subscribePrivateCloud();
          this.downloadingSubject.next(false);
        } else {
          this.unsubscribePrivateCloud();
        }
      }

      this.lastUser = user;
    });
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
  public abstract updateStoreRecord(obj: StoreRecord): Promise<any>;

  // Delete an object in the cloud
  public abstract delete(obj: StoreRecord, fromDb: boolean): Promise<any>;

  // Deserialize object from the cloud into local object in dictionary format
  protected abstract deserialize(document: any): any;

  // *
  //  Set up cloud subscriptions
  // *
  protected abstract subscribePublicCloud(): any;

  protected abstract subscribePrivateCloud(): any;

  protected abstract unsubscribePrivateCloud(): any;

  // No reason to unsubscribe from public cloud

  // *
  // Sync functions
  // *
  // Update the cloud with any local changes stored in the change log - we don't want to call this until
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

    const changes = await StoreChangeLog.find();
    // console.log(`[updateCloudFromChangeLog] Changes to update: ${changes.length}`);
    for (const change of changes) {
      console.log('updateCloudFromChangeLog], ', change);
      const record = await change.getRecord(this.localStore.connection);
      if (record != null) {
        try {
          await this.updateStoreRecord(record);
          await change.remove();
        } catch (err) {
          console.warn(err);
        }
      } else {
        console.log('[updateCloudFromChangeLog] Local record not found, deleting change', change);
        await change.remove();
      }
    }
  }

  // Resolve a list of records
  protected async resolveRecords(recordType: typeof StoreRecord, objs: StoreRecord[]) {
    const resolvedRecords = [];
    for (const obj of objs) {
      // Only need to resolve issues if there's also a local change pending...
      resolvedRecords.push(this.resolveRecord(recordType, obj));
    }
    return resolvedRecords;
  }

  // Helper to call proper resolve function when a new object is received from the cloud
  protected async resolveRecord(recordType: typeof StoreRecord, obj: StoreRecord) {
    const localChange = await StoreChangeLog.findOne({ where: { recordId: obj.id } });
    if (localChange) {
      console.log('[resolveRecords] Local change, need to resolve!');
      const localCopy = await recordType.findOne(obj.id);
      return await this.localStore.resolve(obj, localCopy);
    } else {
      console.log('[resolveRecords] No local change, resolving from cloud.');
      return await this.localStore.resolve(obj);
    }
  }
}
