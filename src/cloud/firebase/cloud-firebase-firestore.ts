// tslint:disable: no-console
import { CloudStore, DeliveryStream } from '../cloud-store';
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
    protected publicRecords: typeof StoreRecord[],
    protected privateRecords: typeof StoreRecord[],
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

  public async updateStoreRecord(obj: StoreRecord): Promise<StoreRecord> {
    // The body of this method (the meta/changeId logic + updatePublicStoreRecord) moved verbatim
    // into the shared StoreRecordWriter so a Cloud Function can run the same protocol. `asVersioned`
    // writes changeId / recordChangeTimestamp back onto `obj` (live accessors), so we return the
    // same instance. `seedChangeId` is the original inline
    // `StoreRecord.getLatestChangeId(this.localStore.dataSource, ...)` call, now passed in as a
    // callback — the one piece the server can't supply (it seeds 0 instead).
    await this.writer.updateStoreRecord(this.asVersioned(obj), {
      // A single read outside any transaction, so it does not take the local transaction lock.
      seedChangeId: () =>
        StoreRecord.getLatestChangeId(
          this.localStore.dataSource,
          { type: obj as any, name: storeNameOf(obj) },
          obj.isPrivate,
        ),
    });
    return obj;
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
      // purpose; the clean insert path used to fill them via @BeforeInsert, which listeners:false
      // (see resolveRecordsLocked) now skips. Filling them here, once, keeps every cloud-origin save
      // this store performs from ending up with a null timestamp.
      if (data.createdMs == null || data.updatedMs == null) {
        const now = Date.now();
        data.createdMs = data.createdMs ?? now;
        data.updatedMs = data.updatedMs ?? now;
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
    await Promise.all(this.publicRecords.map((PublicRecord) => this.subscribeObj(PublicRecord, false)));
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
    await Promise.all(this.privateRecords.map((PrivateRecord) => this.subscribeObj(PrivateRecord, true)));
    this.privateCloudInitialized = true;
  }

  protected unsubscribePrivateCloud() {
    this.privateCloudInitialized = false;
    Object.entries(this.firestoreSubscriptions).forEach(([_, fs]) => fs.unsubscribe());
    this.firestoreSubscriptions = {};
  }

  // Done implementing CloudStore, now helper functions:
  protected async subscribeObj(obj: any, isPrivate: boolean = true) {
    const cursor = await this.readCursor(obj, isPrivate);
    const objInstance = new obj();
    objInstance.isPrivate = isPrivate;
    const collectionPath = this.collectionPath(objInstance);
    const collectionRef = collection(this.db, collectionPath);
    console.debug('[CloudFirebaseFirestore - subscribeObj]', collectionPath, isPrivate, cursor);

    // The live listener starts after the last document the catch-up applied. A catch-up that fails
    // part way leaves the anchor at the last page it did apply, so the listener streams the rest.
    let listenerAnchor = cursor;
    const stream: DeliveryStream = { failed: false };
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
          console.debug(`[CloudFirebaseFirestore - subscribeObj] Downloading ${collectionPath}, size: ${page.length}`);
          await this.resolveSnapshot(obj, page, isPrivate, collectionPath, stream);
          listenerAnchor = page[page.length - 1].data().changeId;
        }
      });
    } catch (error) {
      console.warn('[CloudFirebaseFirestore - subscribeObj] catch-up failed', collectionPath, error);
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

      this.firestoreSubscriptions[storeNameOf(objInstance)] = { record: obj, unsubscribe };
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
          try {
            if (snapshot.exists()) {
              const data = this.deserialize(snapshot.data(), snapshot.id, true);
              delete data.id; // Only do this on user...
              const currentUser = this.user;
              console.debug('[CloudFirebaseFirestore - subscribeCloudUser] about to assign', data, currentUser);
              const updatedUser = currentUser ? Object.assign(currentUser, data) : new this.UserModel(data);
              await serializeLocalTransaction(this.manager, () =>
                updatedUser.saveWithManager(this.manager, { listeners: false }, false),
              );
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
      this.firestoreSubscriptions['User'] = { record: BaseUser, unsubscribe };
    });
  }
}

interface FirestoreSubscription {
  unsubscribe: Unsubscribe;
  record: typeof StoreRecord;
}
