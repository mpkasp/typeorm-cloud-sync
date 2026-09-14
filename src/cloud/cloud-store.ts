// tslint:disable: no-console
import { SqliteStore } from '../sqlite-store';
import { StoreRecord } from '../models/store-record.model';
import { StoreChangeLog } from '../models/store-change-log.model';
import { Meta } from '../models/meta.model';
import { storeNameOf } from '../models/store-name';

import { DataSource, EntityManager, EntitySubscriberInterface, In } from 'typeorm/browser';
import { BehaviorSubject, fromEvent, mapTo, merge, Observable, of, Subject, Subscription } from 'rxjs';
import { StoreChangeLogSubscriber } from '../store-change-log.subscriber';
import { BaseUserSubscriber } from '../base-user.subscriber';
import { BaseUser } from '../models/base-user.model';
import { localTransactionsSettled, serializeLocalTransaction } from '../local-transaction-lock';

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

// One listener's deliveries. `failed` is set by the first delivery that could not be applied.
export interface DeliveryStream {
  failed: boolean;
}

class UploadTimeoutError extends Error {}

// Cloud-origin records written to the local database. Those saves run with entity listeners off, so
// this is how the app learns that rows it displays have changed.
export interface AppliedRecords {
  recordType: typeof StoreRecord;
  count: number;
}

export interface CloudUploadResult {
  record: StoreRecord;
  newerCloudCopy?: StoreRecord;
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
  private downloadsSettled: Promise<void> | null = null;
  private settleDownloads: () => void = () => undefined;
  protected downloadingSubject: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);
  public downloading$: Observable<boolean> = this.downloadingSubject.asObservable();
  public get downloading(): boolean {
    return this.downloadingSubject.getValue();
  }

  // Emits after the local transaction lock is released, so a query run from a subscriber sees the rows.
  protected readonly appliedSubject = new Subject<AppliedRecords>();
  public readonly applied$: Observable<AppliedRecords> = this.appliedSubject.asObservable();

  protected privateCloudInitialized: boolean = false;
  protected localStore: SqliteStore;
  private uploading: boolean = false;
  // Set first thing in dispose(). Work already queued on the local transaction lock checks it once it
  // runs, so nothing this store queued touches the DataSource after the tenant destroys it.
  protected disposed: boolean = false;
  private attachedSubscribers: EntitySubscriberInterface<any>[] = [];
  private readonly subscriptions = new Subscription();
  private drainInFlight: Promise<void> | null = null;
  private lastUser: BaseUser | null = null;
  private updatingCloudFromChangeLog: boolean = false;
  private queueUpdateCloudFromChangeLog: boolean = false;
  // An upload that has not settled by then is abandoned for this drain; its change-log row stays queued.
  protected uploadTimeoutMs: number = 15_000;

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
      this.downloadsSettled = new Promise<void>((resolve) => (this.settleDownloads = resolve));
      this.downloadingSubject.next(true);
    }
  }

  private endDownload() {
    if (this.downloadCount > 0 && --this.downloadCount === 0) {
      this.downloadsSettled = null;
      this.settleDownloads();
      this.downloadingSubject.next(false);
    }
  }

  // Note: Must be able to construct object to set up observables immediately at app runtime. We separate out
  //   initialzation so that we can asynchronously set up the cloud app, sqlite store, etc..
  protected constructor(
    protected UserModel: typeof BaseUser,
    protected publicRecords: (typeof StoreRecord)[],
    protected privateRecords: (typeof StoreRecord)[],
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
    // Precondition for any private sync: a local User record with an authId must already exist. It is
    // read here and it alone drives subscribePrivateCloud() → subscribeCloudUser(), which flips
    // privateCloudInitialized — the gate on the entire change-log drain (see updateCloudFromChangeLog).
    // Without it the store subscribes to nothing and queues local writes forever, silently. A managed
    // account must therefore have its User (with the minted authId) saved locally before it can sync.
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

  // Resolves once no drain, download or serialized local transaction is in flight, so a caller can tear
  // down the DataSource without pulling it out from under one. Bounded, so work stuck on a slow cloud
  // call cannot block disposal forever. Checks again while a drain or download started in the meantime.
  public async whenIdle(timeoutMs: number = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    do {
      const transactions = this.localStore ? localTransactionsSettled(this.localStore.dataSource) : null;
      const inFlight = Promise.all([this.drainInFlight, this.downloadsSettled, transactions]);
      if (!(await this.settlesBefore(inFlight, deadline))) {
        console.warn('[CloudStore] timed out waiting for sync work to finish');
        return;
      }
    } while (this.drainInFlight || this.downloadsSettled);
  }

  private async settlesBefore(work: Promise<unknown>, deadline: number): Promise<boolean> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    let timer: any;
    const timedOut = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), remaining)));
    try {
      return await Promise.race([work.then(() => true), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Release this tenant's hold on its DataSource and cloud. Leaves other tenants untouched.
  public dispose() {
    this.disposed = true;
    this.detachSubscribers();
    this.unsubscribePrivateCloud();
    this.subscriptions.unsubscribe();
    this.appliedSubject.complete();
  }

  private subscribeNetwork() {
    // Forwarding values instead of subscribing the subject itself keeps a completing source
    // (the off-browser default) from completing network$.
    this.subscriptions.add(
      this.networkSource.subscribe((online) => {
        this.networkSubject.next(online);
        if (online) {
          this.drainInBackground();
        }
      }),
    );
    // Also fires when the private cloud finishes initializing: privateCloudInitialized flips inside
    // trackDownload, so the indicator's return to false follows it.
    this.subscriptions.add(this.downloading$.subscribe(() => this.drainInBackground()));
  }

  // Fire-and-forget with its own catch: an unhandled rejection here (a drain racing a disposed
  // tenant's destroyed DataSource, say) would otherwise take down the process.
  private drainInBackground() {
    void this.updateCloudFromChangeLog().catch((e) => console.warn('[CloudStore] background cloud push failed', e));
  }

  private subscribeLocalUser() {
    console.debug('[CloudStore - subscribeLocalUser] setup.');
    const subscription = this.userSubject.subscribe((user) => {
      if (this.disposed) {
        return;
      }
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
  // metadata table etc... When the cloud copy is newer the write is skipped and that copy is returned.
  public abstract updateStoreRecord(obj: StoreRecord): Promise<CloudUploadResult>;

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

  // No reason to unsubscribe from public cloud

  // *
  // Sync functions
  // *

  // Upload every queued local change. Triggered on commit, network up, download settled (which includes
  // private cloud initialized) and by the app on resume. A call that lands while a drain is running
  // queues another pass and resolves when the running drain, including that pass, finishes.
  public drain(): Promise<void> {
    return this.updateCloudFromChangeLog();
  }

  public async updateCloudFromChangeLog(): Promise<void> {
    if (!this.canDrain()) {
      return;
    }
    if (this.updatingCloudFromChangeLog) {
      console.debug('[updateCloudFromChangeLog] Still updating previous entry, queuing to run again.');
      this.queueUpdateCloudFromChangeLog = true;
      return this.drainInFlight ?? undefined;
    }

    this.updatingCloudFromChangeLog = true;
    let drainFinished: () => void = () => undefined;
    this.drainInFlight = new Promise<void>((resolve) => (drainFinished = resolve));
    try {
      do {
        this.queueUpdateCloudFromChangeLog = false;
        await this.drainChangeLogOnce();
      } while (this.queueUpdateCloudFromChangeLog && this.canDrain());
    } finally {
      this.drainInFlight = null;
      drainFinished();
      this.updatingCloudFromChangeLog = false;
    }
  }

  private canDrain(): boolean {
    if (this.disposed) {
      return false;
    }
    if (!this.networkSubject.getValue()) {
      console.debug('[updateCloudFromChangeLog] No network, not updating cloud.');
      return false;
    }
    if (!this.privateCloudInitialized) {
      console.debug('[updateCloudFromChangeLog] Subscriptions not yet initialized, not updating cloud.');
      return false;
    }
    if (this.downloading) {
      console.debug('[updateCloudFromChangeLog] Still downloading, not updating cloud.');
      return false;
    }
    return true;
  }

  // The change log and its records are read in one hold of the local transaction lock, so the drain
  // never reads rows of a transaction that is still open and could roll back. Uploads run outside it.
  // A timeout ends the pass: the cloud is unreachable, and every remaining row would wait out its own.
  private async drainChangeLogOnce() {
    const pendingChanges = await serializeLocalTransaction(this.manager, () => this.readPendingChangesLocked());
    for (const { change, record } of pendingChanges) {
      if (this.disposed) {
        return;
      }
      try {
        const upload = await this.withTimeout(this.updateStoreRecord(record), this.uploadTimeoutMs);
        let storedNewerCloudCopy = false;
        await serializeLocalTransaction(this.manager, async () => {
          // Tenant.dispose destroys the DataSource under this lock, so the check cannot go stale.
          if (!this.localStore.dataSource.isInitialized) {
            return;
          }
          await this.manager.transaction(async (manager) => {
            if (!(await this.removeChangeIfUnchanged(manager, change))) {
              return;
            }
            // The device may have downloaded the newer copy already, with the cursor past it, so no
            // delivery would replace the local row: store the copy here or local never equals cloud.
            if (upload.newerCloudCopy) {
              await upload.newerCloudCopy.saveWithManager(manager, { listeners: false }, false);
              storedNewerCloudCopy = true;
              return;
            }
            await manager
              .createQueryBuilder()
              .update(record.constructor as typeof StoreRecord)
              .set({ changeId: upload.record.changeId })
              .where('id = :id', { id: record.id })
              .callListeners(false)
              .execute();
          });
        });
        if (storedNewerCloudCopy && !this.disposed) {
          this.appliedSubject.next({ recordType: record.constructor as typeof StoreRecord, count: 1 });
        }
      } catch (err) {
        if (err instanceof UploadTimeoutError) {
          console.warn('[updateCloudFromChangeLog] upload timed out, leaving the remaining changes queued', err);
          return;
        }
        console.warn('[updateCloudFromChangeLog] upload failed, leaving the change queued', err);
      }
    }
  }

  private async readPendingChangesLocked(): Promise<{ change: StoreChangeLog; record: StoreRecord }[]> {
    if (this.disposed) {
      return [];
    }
    const pendingChanges: { change: StoreChangeLog; record: StoreRecord }[] = [];
    for (const change of await this.manager.getRepository(StoreChangeLog).find()) {
      const record = await change.getRecordWithManager(this.manager);
      if (record == null) {
        console.debug('[updateCloudFromChangeLog] Local record not found, deleting change');
        await this.removeChangeIfUnchanged(this.manager, change);
        continue;
      }
      pendingChanges.push({ change, record });
    }
    return pendingChanges;
  }

  private async withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: any;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new UploadTimeoutError(`timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Delete a drained change-log row only if it still holds the version the drain read. A local edit
  // during the upload bumps the version, so the row stays queued and the edit uploads next drain; the
  // local record is then left untouched rather than overwritten with the uploaded snapshot.
  private async removeChangeIfUnchanged(manager: EntityManager, change: StoreChangeLog): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .delete()
      .from(StoreChangeLog)
      .where('id = :id AND version = :version', { id: change.id, version: change.version })
      .execute();
    return result.affected === 1;
  }

  // The collection's download cursor. A database with no cursor row yet (one created before cursors
  // were persisted) starts from its highest local changeId, and that value is stored as the row.
  public readCursor(recordType: typeof StoreRecord, isPrivate: boolean): Promise<number> {
    return serializeLocalTransaction(this.manager, async () => {
      if (this.disposed) {
        throw new Error('[CloudStore] readCursor on a disposed store');
      }
      const collection = storeNameOf(recordType);
      const meta = await this.manager.getRepository(Meta).findOneBy({ collection, isPrivate });
      if (meta) {
        return meta.changeId;
      }
      const changeId = await StoreRecord.getLatestChangeId(
        this.localStore.dataSource,
        { type: recordType as any, name: collection },
        isPrivate,
      );
      await this.manager.getRepository(Meta).save(new Meta(collection, isPrivate, changeId), { listeners: false });
      return changeId;
    });
  }

  // Moves the cursor forward to `changeId`, never back: deliveries can apply out of order.
  public advanceCursor(recordType: typeof StoreRecord, isPrivate: boolean, changeId: number): Promise<void> {
    return serializeLocalTransaction(this.manager, () => this.advanceCursorLocked(recordType, isPrivate, changeId));
  }

  private async advanceCursorLocked(recordType: typeof StoreRecord, isPrivate: boolean, changeId: number) {
    if (this.disposed) {
      return;
    }
    const collection = storeNameOf(recordType);
    const meta = await this.manager.getRepository(Meta).findOneBy({ collection, isPrivate });
    if (meta && meta.changeId >= changeId) {
      return;
    }
    await this.manager.getRepository(Meta).save(new Meta(collection, isPrivate, changeId), { listeners: false });
  }

  // Apply one cloud delivery (a catch-up page or a live snapshot), then advance the cursor to the
  // highest changeId it carried. The cursor moves only after the records are stored, and only here.
  // A listener hands each document over once, so once a delivery on `stream` fails, later deliveries
  // still apply but no longer move the cursor: the failed documents stay above it and the next
  // subscribe catches them up. Both steps share one lock hold, and the lock runs deliveries in arrival
  // order, so a failure is recorded before any later delivery reads it.
  protected async applyDelivery(
    recordType: typeof StoreRecord,
    isPrivate: boolean,
    records: StoreRecord[],
    stream: DeliveryStream = { failed: false },
  ) {
    if (records.length === 0) {
      return;
    }
    const appliedCount = await serializeLocalTransaction(this.manager, async () => {
      if (this.disposed) {
        return 0;
      }
      let resolvedRecords: StoreRecord[];
      try {
        resolvedRecords = await this.resolveRecordsLocked(recordType, records);
      } catch (error) {
        stream.failed = true;
        throw error;
      }
      if (!stream.failed) {
        await this.advanceCursorLocked(recordType, isPrivate, Math.max(...records.map((record) => record.changeId)));
      }
      return resolvedRecords.length;
    });
    // Every upload echoes back as a delivery that changes nothing; announcing those would make the app
    // refresh after each of its own edits.
    if (appliedCount > 0 && !this.disposed) {
      this.appliedSubject.next({ recordType, count: appliedCount });
    }
  }

  // Apply a page of records from the cloud. Records with a pending local change go through the
  // per-record conflict path; the rest have no local edit to protect, so the cloud copy simply wins
  // and they are written in a single chunked, transactional bulk save instead of one round-trip each.
  // On an initial login the change log is empty, so the whole page takes the bulk path — the
  // difference between ~2 writes and ~1000 read/write round-trips for a 500-record page.
  protected async resolveRecords(recordType: typeof StoreRecord, objs: StoreRecord[]) {
    if (objs.length === 0) {
      return [];
    }
    return serializeLocalTransaction(this.manager, () => this.resolveRecordsLocked(recordType, objs));
  }

  private async resolveRecordsLocked(recordType: typeof StoreRecord, objs: StoreRecord[]) {
    if (this.disposed) {
      return [];
    }
    // Drop anything the local row already has: a re-delivered document (a listener reopened
    // over records already stored) or a stale page. Comparing against the current changeId rather than
    // relying on the cloud to only ever send new data keeps re-delivery a true no-op.
    const localChangeIds = await this.localChangeIds(recordType, objs);
    const incoming = objs.filter((obj) => {
      const localChangeId = obj.id ? localChangeIds.get(obj.id) : undefined;
      return localChangeId == null || obj.changeId > localChangeId;
    });

    const pendingIds = await this.pendingChangeIds(incoming);
    const clean: StoreRecord[] = [];
    const conflicted: StoreRecord[] = [];
    for (const obj of incoming) {
      (pendingIds.has(obj.id as string) ? conflicted : clean).push(obj);
    }

    const resolvedRecords: StoreRecord[] = [];
    if (clean.length > 0) {
      // Cloud-origin data, so no change-log rows are written (this is not a local edit), and
      // listeners stay off: the @BeforeInsert/@BeforeUpdate hooks that populate createdMs/updatedMs
      // would otherwise stamp the local write time over the timestamps the cloud document carries.
      const saved = await this.manager.save(clean, { chunk: 500, listeners: false });
      resolvedRecords.push(...(saved as unknown as StoreRecord[]));
    }
    for (const obj of conflicted) {
      const resolvedRecord = await this.resolveRecord(recordType, obj);
      if (resolvedRecord !== null) {
        resolvedRecords.push(resolvedRecord);
      }
    }
    return resolvedRecords;
  }

  // One query for the whole page's current local changeIds, so a re-delivered or stale document can
  // be dropped before it reaches the conflict split.
  private async localChangeIds(recordType: typeof StoreRecord, objs: StoreRecord[]): Promise<Map<string, number>> {
    const ids = objs.map((obj) => obj.id).filter((id): id is string => id != null);
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.manager
      .getRepository(recordType)
      .find({ where: { id: In(ids) } as any, select: { id: true, changeId: true } as any });
    return new Map(rows.map((row) => [row.id as string, row.changeId]));
  }

  // One query for the whole page's pending change-log rows, replacing the per-record findOne that
  // dominated large initial downloads.
  private async pendingChangeIds(objs: StoreRecord[]): Promise<Set<string>> {
    const ids = objs.map((obj) => obj.id).filter((id): id is string => id != null);
    if (ids.length === 0) {
      return new Set();
    }
    const changes = await this.manager.getRepository(StoreChangeLog).find({ where: { recordId: In(ids) } });
    return new Set(changes.map((change) => change.recordId));
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
