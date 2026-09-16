// tslint:disable: no-console
import { CloudStore, CloudUploadResult, DeliveryStream } from '../cloud-store';
import { SqliteStore } from '../../sqlite-store';
import { StoreRecord } from '../../models/store-record.model';
import { BaseUser } from '../../models/base-user.model';
import { storeNameOf } from '../../models/store-name';
import { PathBuilder } from './protocol/path-builder';
import { StoreRecordWriter } from './protocol/store-record-writer';
import { VersionedRecord } from './protocol/firestore-port';
import { WebFirestorePort } from './web-firestore-port';
import { serializeLocalTransaction } from '../../local-transaction-lock';
import { catchUpPages } from './catch-up-pages';

import { Observable } from 'rxjs';
import { FirebaseApp, initializeApp } from 'firebase/app';
import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDocs,
  deleteDoc,
  onSnapshot,
  getFirestore,
  Firestore,
  query,
  where,
  limit,
  orderBy,
  startAfter,
  QueryDocumentSnapshot,
  Unsubscribe,
} from 'firebase/firestore';

const CATCH_UP_PAGE_SIZE = 500;

export class CloudFirebaseFirestore extends CloudStore {
  db: Firestore;
  private firestoreSubscriptions: { [key: string]: FirestoreSubscription } = {};
  // Shared, SDK-agnostic versioned-write protocol (the same StoreRecordWriter a Cloud Function runs
  // over an Admin-SDK port), bound here to the modular web SDK. See src/cloud/firebase/protocol.
  private readonly paths = new PathBuilder(() => this.user?.authId);
  private writer!: StoreRecordWriter;

  // Construction performs no I/O: it touches no Firestore handle, opens no listener, and reaches no
  // network — it only wires up the observables (network$/user$/downloading$). getFirestore and every
  // read/subscribe happen in initialize(), the sole network step. This is the guarantee local-first
  // opening depends on: a Tenant can hold an unconnected CloudFirebaseFirestore and be fully usable
  // offline, with the cloud attached later by a single initialize() call. Pinned by
  // cloud-firebase-firestore.construction.spec.ts — keep any network touch out of this path.
  constructor(
    protected UserModel: typeof BaseUser,
    protected publicRecords: (typeof StoreRecord)[],
    protected privateRecords: (typeof StoreRecord)[],
    network$?: Observable<boolean>,
  ) {
    super(UserModel, publicRecords, privateRecords, network$);
  }

  public async initialize(sqliteStore: SqliteStore, app: FirebaseApp) {
    // TODO: How to catch "Could not reach Cloud Firestore backend."?
    //   Could not reach Cloud Firestore backend. Connection failed 1 times. Most recent error: FirebaseError: [code=unknown]: Fetching auth token failed: Firebase: Error (auth/network-request-failed).
    //   This typically indicates that your device does not have a healthy Internet connection at the moment. The client will operate in offline mode until it is able to successfully connect to the backend.
    this.db = getFirestore(app); // Must be set before initializeBase so we can set up cloud subscriptions
    this.writer = new StoreRecordWriter(new WebFirestorePort(this.db), this.paths);
    await this._initializeBase(sqliteStore);
  }

  // Implement CloudStore

  public async create(obj: StoreRecord) {
    const collectionPath = this.collectionPath(obj);
    return addDoc(collection(this.db, collectionPath), obj.raw());
  }

  public async update(obj: StoreRecord) {
    const documentPath = this.documentPath(obj);
    const docRef = doc(this.db, documentPath);
    return setDoc(docRef, obj.raw(), { merge: true });
  }

  public async updateStoreRecord(obj: StoreRecord): Promise<CloudUploadResult> {
    // The protocol lives in the shared StoreRecordWriter so a Cloud Function runs the same code.
    // `asVersioned` writes changeId / recordChangeTimestamp back onto `obj` (live accessors).
    const result = await this.writer.updateStoreRecord(this.asVersioned(obj), {
      // A single read outside any transaction, so it does not take the local transaction lock.
      seedChangeId: () =>
        StoreRecord.getLatestChangeId(
          this.localStore.dataSource,
          { type: obj as any, name: storeNameOf(obj) },
          obj.isPrivate,
        ),
    });
    return {
      record: obj,
      newerCloudCopy:
        result.newerCloudCopy &&
        new (obj.constructor as any)(this.deserialize(result.newerCloudCopy, obj.id, obj.isPrivate)),
    };
  }

  public async delete(obj: StoreRecord, fromDb: boolean = false) {
    if (fromDb) {
      const documentPath = this.documentPath(obj);
      const documentRef = doc(this.db, documentPath);
      return deleteDoc(documentRef);
    }
    obj.isDeleted = true;
    return this.updateStoreRecord(obj);
  }

  protected deserialize(data: any, id?: string, isPrivate: boolean = true): any {
    // if (data.hasOwnProperty('created')) {
    //   delete data.created;
    // }
    // console.log('[deserialize]', data, id, isPrivate);
    for (const key in data) {
      if (data.hasOwnProperty(key) && data[key] && typeof data[key].toDate === 'function') {
        data[key] = data[key].toDate();
      } else if (data.hasOwnProperty(key) && data[key] && typeof data[key].toUint8Array === 'function') {
        data[key] = data[key].toUint8Array();
      } else if (data.hasOwnProperty(key) && data[key] && typeof data[key] === 'object' && key !== 'ref') {
        data[key] = this.deserialize(data[key]);
      }
    }
    if (data && id) {
      data.id = id;
      // Server-written records (the inbox projection Cloud Function) omit createdMs/updatedMs on
      // purpose, and cloud-origin saves run with listeners off, so the columns are filled here.
      // updatedMs is 0, never the download time: the projection carries a subset of the record a
      // device saved for the same event, and a pending local copy must win the conflict in
      // SqliteStore.resolve so its upload stays queued.
      if (data.createdMs == null || data.updatedMs == null) {
        data.createdMs = data.createdMs ?? Date.now();
        data.updatedMs = data.updatedMs ?? 0;
      }
    }
    // data.isPrivate = isPrivate;
    return data;
  }

  // Each record type is an independent collection with its own changeId cursor and conflict resolution,
  // so their catch-up round trips can run concurrently rather than one after another — the difference
  // between one network latency and the sum of them on launch. The database writes they produce are
  // still serialized (CloudStore.resolveRecords funnels them through one queue), so only the fetches
  // overlap. subscribeObj resolves once its listener's first delivery lands or the listener fails, so
  // awaiting them together preserves the same "private cloud is up" guarantee the serial loop gave.
  protected async subscribePublicCloud() {
    await this.subscribeInDeclaredOrder(this.publicRecords, false);
  }

  // Every collection's catch-up is fetched concurrently, but stored in the order the records were
  // declared: a collection's first page waits for the previous collection's catch-up to finish. A
  // record that references another collection's rows (a foreign key) is listed after it, so its rows
  // never arrive before the rows they point at. Listeners open once each catch-up is done.
  private subscribeInDeclaredOrder(records: (typeof StoreRecord)[], isPrivate: boolean): Promise<void[]> {
    let storeAfter: Promise<void> = Promise.resolve();
    return Promise.all(
      records.map((record) => {
        let catchUpDone: () => void = () => undefined;
        const done = new Promise<void>((resolve) => (catchUpDone = resolve));
        const setup = this.subscribeObj(record, isPrivate, storeAfter, catchUpDone);
        storeAfter = done;
        return setup;
      }),
    );
  }

  protected async subscribePrivateCloud() {
    if (this.privateCloudInitialized) {
      console.debug('[CloudFirebaseFirestore - subscribePrivateCloud] already initialized');
      return;
    }
    // The User record is fetched first and alone: every private collection's path is resolved through
    // the local user (its authId), so it must exist before the others subscribe.
    console.debug('[CloudFirebaseFirestore - subscribePrivateCloud] User');
    await this.subscribeCloudUser();
    await this.subscribeInDeclaredOrder(this.privateRecords, true);
    if (!this.disposed) {
      this.privateCloudInitialized = true;
    }
  }

  protected unsubscribePrivateCloud() {
    this.privateCloudInitialized = false;
    Object.entries(this.firestoreSubscriptions).forEach(([_, fs]) => fs.unsubscribe());
    this.firestoreSubscriptions = {};
  }

  // Done implementing CloudStore, now helper functions.
  // `storeAfter` gates the first page's store (the fetch runs before it); `catchUpDone` is called
  // once the catch-up has ended, however it ended, so the next collection can start storing.
  protected async subscribeObj(
    obj: any,
    isPrivate: boolean = true,
    storeAfter: Promise<void> = Promise.resolve(),
    catchUpDone: () => void = () => undefined,
  ) {
    let listenerAnchor: number;
    let collectionPath: string;
    let collectionRef: ReturnType<typeof collection>;
    const objInstance = new obj();
    objInstance.isPrivate = isPrivate;
    const stream: DeliveryStream = { failed: false };
    try {
      if (this.disposed) {
        return;
      }
      let cursor: number;
      try {
        cursor = await this.readCursor(obj, isPrivate);
      } catch (error) {
        if (this.disposed) {
          return;
        }
        throw error;
      }
      collectionPath = this.collectionPath(objInstance);
      collectionRef = collection(this.db, collectionPath);
      console.debug('[CloudFirebaseFirestore - subscribeObj]', collectionPath, isPrivate, cursor);

      // The live listener starts after the last document the catch-up applied. A catch-up that fails
      // part way leaves the anchor at the last page it did apply, so the listener streams the rest.
      listenerAnchor = cursor;
      try {
        // The paged catch-up is bounded, so the indicator is held across it.
        await this.trackDownload(async () => {
          const fetchPage = async (afterDocument: QueryDocumentSnapshot | undefined) => {
            const constraints = [where('changeId', '>', cursor), orderBy('changeId')];
            const pageQuery = afterDocument
              ? query(collectionRef, ...constraints, startAfter(afterDocument), limit(CATCH_UP_PAGE_SIZE))
              : query(collectionRef, ...constraints, limit(CATCH_UP_PAGE_SIZE));
            return (await getDocs(pageQuery)).docs;
          };
          for await (const page of catchUpPages(fetchPage, CATCH_UP_PAGE_SIZE)) {
            await storeAfter;
            if (this.disposed) {
              return;
            }
            console.debug(
              `[CloudFirebaseFirestore - subscribeObj] Downloading ${collectionPath}, size: ${page.length}`,
            );
            await this.resolveSnapshot(obj, page, isPrivate, collectionPath, stream);
            listenerAnchor = page[page.length - 1].data().changeId;
          }
        });
      } catch (error) {
        console.warn('[CloudFirebaseFirestore - subscribeObj] catch-up failed', collectionPath, error);
      }
    } finally {
      catchUpDone();
    }
    // Disposed during the catch-up: its subscriptions were already torn down, so a listener opened
    // now would never be.
    if (this.disposed) {
      return;
    }

    return new Promise<void>((resolve) => {
      let unresolved = true;
      const settle = () => {
        if (unresolved) {
          unresolved = false;
          console.debug('[CloudFirebaseFirestore - subscribeObj] resolved', collectionPath);
          resolve();
        }
      };

      // No limit: a limited listener would only ever see the first page above the anchor. Firestore
      // hands the callback the whole result set, so each delivery applies only its docChanges.
      const liveQuery = query(collectionRef, where('changeId', '>', listenerAnchor), orderBy('changeId'));
      const unsubscribe = onSnapshot(
        liveQuery,
        (snapshot) => {
          if (this.disposed) {
            settle();
            return;
          }
          const changedDocuments = snapshot
            .docChanges()
            .filter((change) => change.type === 'added' || change.type === 'modified')
            .map((change) => change.doc);
          if (changedDocuments.length === 0) {
            settle();
            return;
          }
          // Everything that arrives after setup — including the backlog Firestore streams on
          // reconnect — lands here. Counting it keeps the indicator up while that data is written.
          void this.trackDownload(() => this.resolveSnapshot(obj, changedDocuments, isPrivate, collectionPath, stream))
            .catch((error) =>
              console.warn('[CloudFirebaseFirestore - subscribeObj] failed applying snapshot', collectionPath, error),
            )
            .finally(settle);
        },
        (error) => {
          console.warn('[CloudFirebaseFirestore - subscribeObj] subscription failed', collectionPath, error);
          settle();
        },
      );

      // Unsubscribing settles setup too: a listener torn down before its first delivery never calls back.
      this.firestoreSubscriptions[storeNameOf(objInstance)] = {
        record: obj,
        unsubscribe: () => {
          unsubscribe();
          settle();
        },
      };
    });
  }

  private async resolveSnapshot(
    obj: any,
    documents: QueryDocumentSnapshot[],
    isPrivate: boolean,
    collectionPath: string,
    stream: DeliveryStream,
  ) {
    const records: StoreRecord[] = documents.map(
      (document) => new obj(this.deserialize(document.data(), document.id, isPrivate)),
    );
    console.debug(`[subscribeObj] Received object: ${collectionPath} ${records.length}, isPrivate: ${isPrivate}`);
    await this.applyDelivery(obj, isPrivate, records, stream);
  }

  private collectionPath(obj: StoreRecord): string {
    return this.paths.collectionPath({ storeName: storeNameOf(obj), isPrivate: obj.isPrivate });
  }

  private documentPath(obj: StoreRecord): string {
    return this.paths.documentPath({
      storeName: storeNameOf(obj),
      isPrivate: obj.isPrivate,
      id: obj.id as string,
      authId: (obj as any).authId,
    });
  }

  // Adapt a StoreRecord to the protocol's minimal record view. changeId / recordChangeTimestamp are
  // live accessors so the writer's mutations land back on the entity, and raw() defers to the entity raw().
  private asVersioned(obj: StoreRecord): VersionedRecord {
    return {
      storeName: storeNameOf(obj),
      id: obj.id as string,
      isPrivate: obj.isPrivate,
      authId: (obj as any).authId,
      get changeId() {
        return obj.changeId;
      },
      set changeId(v: number) {
        obj.changeId = v;
      },
      get recordChangeTimestamp() {
        return obj.recordChangeTimestamp;
      },
      set recordChangeTimestamp(v: Date) {
        obj.recordChangeTimestamp = v;
      },
      raw: () => obj.raw(),
    };
  }

  private async subscribeCloudUser() {
    console.debug('[CloudFirebaseFirestore - subscribeCloudUser] 1');
    // const docPath = `${this.userDocument()}`;
    // console.log('[subscribeCloudUser] 2', this.db, docPath);
    if (!this.user?.authId) {
      console.warn('Cant subscribe, no authId on user');
      return;
    }

    const docRef = doc(this.db, 'User', this.user.authId);
    // console.log('[subscribeCloudUser] 3', docRef);
    // For the user, since we don't use a standard UUID, for now we're just going to always update from cloud
    // console.log('[CloudFirebaseFirestore] ', docPath, docRef);
    return new Promise<void>((resolve) => {
      let unresolved = true;
      // Settle exactly once, however the snapshot turns out. initialize() awaits this promise and
      // gates privateCloudInitialized — and so the entire change-log drain — on it, so a path that
      // never resolves stalls the store's uploads permanently, not just a download. A newly created
      // account has no /User document yet, so the snapshot arrives with no data and the merge must
      // not be allowed to leave the promise pending.
      const settle = () => {
        if (unresolved) {
          unresolved = false;
          resolve();
        }
      };

      const unsubscribe = onSnapshot(
        docRef,
        async (snapshot) => {
          if (this.disposed) {
            settle();
            return;
          }
          try {
            if (snapshot.exists()) {
              const data = this.deserialize(snapshot.data(), snapshot.id, true);
              delete data.id; // Only do this on user...
              const currentUser = this.user;
              console.debug('[CloudFirebaseFirestore - subscribeCloudUser] about to assign', data, currentUser);
              const updatedUser = currentUser ? Object.assign(currentUser, data) : new this.UserModel(data);
              await serializeLocalTransaction(this.manager, async () => {
                if (!this.disposed) {
                  await updatedUser.saveWithManager(this.manager, { listeners: false }, false);
                }
              });
              if (!this.disposed) {
                this.appliedSubject.next({ recordType: this.UserModel, count: 1 });
              }
            } else {
              // Nothing in the cloud yet: the local record is the only copy, and the drain uploads it.
              console.debug('[CloudFirebaseFirestore - subscribeCloudUser] no cloud user document yet');
            }
          } catch (error) {
            console.warn('[CloudFirebaseFirestore - subscribeCloudUser] could not apply cloud user', error);
          } finally {
            settle();
          }
        },
        (error) => {
          console.warn('[CloudFirebaseFirestore - subscribeCloudUser] user subscription failed', error);
          settle();
        },
      );
      this.firestoreSubscriptions['User'] = {
        record: BaseUser,
        unsubscribe: () => {
          unsubscribe();
          settle();
        },
      };
    });
  }
}

interface FirestoreSubscription {
  unsubscribe: Unsubscribe;
  record: typeof StoreRecord;
}
