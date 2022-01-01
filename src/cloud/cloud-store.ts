// tslint:disable: no-console
import {SqliteStore} from '../sqlite-store';
import {StoreRecord} from '../models/store-record.model';
import {StoreChangeLog} from '../models/store-change-log.model';

import { BehaviorSubject, fromEvent, mapTo, merge, Observable, of, startWith, Subscription } from 'rxjs';
import { CloudSubject } from './cloud-subject';
import { StoreChangeLogSubscriber } from '../store-change-log.subscriber';

export abstract class CloudStore {
  protected networkSubject: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(navigator.onLine);
  public network$: Observable<boolean> = this.networkSubject.asObservable();
  public get network(): boolean { return this.networkSubject.getValue() }
  protected cloudDownloading: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);
  protected localSubjects: CloudSubject<any>[] = [];
  protected cloudSubscriptions: Subscription[] = [];
  private changeLogSubscriber = new StoreChangeLogSubscriber(this);

  protected constructor(readonly localStore: SqliteStore) {}

  protected abstract setupCloudSubscriptions(): Promise<any>;

  protected unsubscribeCloudSubscriptions() {
    this.cloudSubscriptions.forEach(subscription => subscription.unsubscribe());
    this.cloudSubscriptions = [];
  }

  public subscriptionsInitialized(): boolean {
    return this.localSubjects.filter(s => !s.initialized).length === 0;
  }

  protected unsubscribeSubscriptions() {
    console.log('[unsubscribeSubscriptions]');
    this.unsubscribeCloudSubscriptions();
    this.localSubjects.forEach(subject => subject.unsubscribe());
  }

  protected async subscribeNetwork() {
    const networkObservable = merge(
      of(navigator.onLine),
      fromEvent(window, 'online').pipe(mapTo(true)),
      fromEvent(window, 'offline').pipe(mapTo(false))
    );
    networkObservable.subscribe(this.networkSubject);
    networkObservable.subscribe(status => {
      if (status) {
        this.setupCloudSubscriptions();
      } else {
        this.unsubscribeCloudSubscriptions();
        this.localSubjects.forEach(s => s.initialized = false);
      }
    });

    this.downloading.subscribe(async d => await this.updateCloudFromChangeLog());
  }

  public get downloading(): Observable<boolean> {
    return this.cloudDownloading.asObservable();
  }

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

  // Update the cloud with any local changes stored in the change log
  public async updateCloudFromChangeLog() {

    if (!this.networkSubject.getValue()) {
      console.warn('[updateCloudFromChangeLog] No network, not updating cloud.');
      return;
    }

    if (!this.subscriptionsInitialized()) {
      console.warn('[updateCloudFromChangeLog] Subscriptions not yet initialized, not updating cloud.');
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
      // TODO: Make sure if disconnected from internet, we don't try to push local changes until we receive cloud records.
      resolvedRecords.push(this.resolveRecord(recordType, obj));
    }
    return resolvedRecords;
  }

  // Helper to call proper resolve function when a new object is received from the cloud
  protected async resolveRecord(recordType: typeof StoreRecord, obj: StoreRecord) {
    // TODO: How to handle user?
    const localChange = await StoreChangeLog.findOne({where: {recordId: obj.id}});
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
