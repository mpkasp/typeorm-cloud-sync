import {SqliteStoreService} from './sqlite-store.service';
import {StoreRecord} from './models/store-record.model';
import {StoreChangeLog} from './models/store-change-log.model';

import { BehaviorSubject, fromEvent, mapTo, merge, Observable, of, startWith, Subscription } from 'rxjs';

export abstract class CloudService {
  protected authenticatedSubject: BehaviorSubject<any> = new BehaviorSubject<any>(null);
  protected networkSubject: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(navigator.onLine);
  protected cloudDownloading: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);

  protected localSubjects: CloudSubject<any>[] = [];
  protected cloudSubscriptions: Subscription[] = [];

  protected constructor(public localStore: SqliteStoreService) {}

  protected abstract setupCloudSubscriptions(): Promise<any>;

  protected listenForLocalChanges() {
  }

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
    // Network.addListener('networkStatusChange', status => {
    //   console.log('[subscribeNetwork] Network status changed', status);
    //   this.networkSubject.next(status.connected);
    //   if (status.connected) {
    //     this.setupCloudSubscriptions();
    //   } else {
    //     this.unsubscribeCloudSubscriptions();
    //     this.localSubjects.forEach(s => s.initialized = false);
    //   }
    // });

    this.downloading.subscribe(async d => await this.updateCloudFromChangeLog());

    // console.log('[subscribeNetwork] initial status: ', status);
    // this.networkSubject.next((await Network.getStatus()).connected);
  }

  public get network(): Observable<boolean> {
    return this.networkSubject.asObservable();
  }

  public get downloading(): Observable<boolean> {
    return this.cloudDownloading.asObservable();
  }

  public get authenticated() {
    return this.authenticatedSubject.asObservable();
  }

  public abstract create(obj: StoreRecord): Promise<any>;

  public abstract update(obj: StoreRecord): Promise<any>;

  // Update in a transaction which bumps the changeId, etc...
  public abstract updateStoreRecord(obj: StoreRecord): Promise<any>;

  public abstract delete(obj: StoreRecord, fromDb: boolean): Promise<any>;

  protected abstract deserialize(document): any;

  public async updateCloudFromChangeLog() {

    if (!this.networkSubject.getValue()) {
      console.warn('[updateCloudFromChangeLog] No network, not updating cloud.');
      return;
    }

    if (!this.authenticatedSubject.getValue()) {
      console.warn('[updateCloudFromChangeLog] Not authenticated, not updating cloud.');
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

  protected async resolveRecords(recordType, objs) {
    const resolvedRecords = [];
    for (const obj of objs) {
      // Only need to resolve issues if there's also a local change pending...
      // TODO: Make sure if disconnected from internet, we don't try to push local changes until we receive cloud records.
      resolvedRecords.push(this.resolveRecord(recordType, obj));
    }
    return resolvedRecords;
  }

  protected async resolveRecord(recordType, obj) {
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

export class CloudSubject<T> extends BehaviorSubject<T> {
  initialized: boolean = false;

  unsubscribe(): void {
    this.initialized = false;
    super.unsubscribe();
  }
}
