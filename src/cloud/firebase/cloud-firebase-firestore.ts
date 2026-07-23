// tslint:disable: no-console
import { CloudStore } from '../cloud-store';
import { SqliteStore } from '../../sqlite-store';
import { StoreRecord } from '../../models/store-record.model';
import { BaseUser } from '../../models/base-user.model';
import { storeNameOf } from '../../models/store-name';
import { PathBuilder } from '../protocol/path-builder';
import { StoreRecordWriter } from '../protocol/store-record-writer';
import { VersionedRecord } from '../protocol/firestore-port';
import { WebFirestorePort } from './web-firestore-port';

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
  Unsubscribe,
} from 'firebase/firestore';

export class CloudFirebaseFirestore extends CloudStore {
  db: Firestore;
  private firestoreSubscriptions: { [key: string]: FirestoreSubscription } = {};
  // Shared, SDK-agnostic versioned-write protocol (the same StoreRecordWriter a Cloud Function runs
  // over an Admin-SDK port), bound here to the modular web SDK. See src/cloud/protocol.
  private readonly paths = new PathBuilder(() => this.user?.authId);
  private writer!: StoreRecordWriter;

  constructor(
    protected UserModel: typeof BaseUser,
    protected publicRecords: typeof StoreRecord[],
    protected privateRecords: typeof StoreRecord[],
  ) {
    super(UserModel, publicRecords, privateRecords);
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
    // Delegate to the shared, SDK-agnostic write protocol. `asVersioned` writes changeId /
    // recordChangeTimestamp back onto `obj` (live accessors), so we return the same instance.
    // `seedChangeId` supplies the local store's max changeId used when a collection's Meta doc is
    // first created — the one piece the server can't provide (it seeds 0 instead).
    await this.writer.writeRecord(this.asVersioned(obj), {
      seedChangeId: () =>
        StoreRecord.getLatestChangeId(
          this.localStore.dataSource,
          { type: obj as any, name: storeNameOf(obj) },
          storeNameOf(obj),
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
    }
    // data.isPrivate = isPrivate;
    return data;
  }

  protected async subscribePublicCloud() {
    // console.log('[CloudFirebaseFirestore - subscribePublicCloud] subscribing to public records!');
    for (const PublicRecord of this.publicRecords) {
      console.debug('[CloudFirebaseFirestore - subscribePublicCloud]', PublicRecord.name);
      await this.subscribeObj(PublicRecord, false);
      // console.log('[CloudFirebaseFirestore - subscribePublicCloud] done', PublicRecord.name);
    }
  }

  protected async subscribePrivateCloud() {
    // console.log('[CloudFirebaseFirestore - subscribePrivateCloud] subscribing to private records!');
    if (this.privateCloudInitialized) {
      console.debug('[CloudFirebaseFirestore - subscribePrivateCloud] already initialized');
      return;
    }
    console.debug('[CloudFirebaseFirestore - subscribePrivateCloud] User');
    await this.subscribeCloudUser();
    // console.log('[CloudFirebaseFirestore - subscribePrivateCloud] done User');
    // for (let i = 0; i < this.privateRecords.length; i++) {
    //   const PrivateRecord = this.privateRecords[i];
    for (const PrivateRecord of this.privateRecords) {
      console.debug('[CloudFirebaseFirestore - subscribePrivateCloud]', PrivateRecord.name);
      await this.subscribeObj(PrivateRecord, true);
      console.debug('[CloudFirebaseFirestore - subscribePrivateCloud] done', PrivateRecord.name);
    }
    this.privateCloudInitialized = true;
  }

  protected unsubscribePrivateCloud() {
    this.privateCloudInitialized = false;
    Object.entries(this.firestoreSubscriptions).forEach(([_, fs]) => fs.unsubscribe());
    this.firestoreSubscriptions = {};
  }

  protected async subscribeRecord(record: typeof StoreRecord, isPrivate: boolean): Promise<any> {
    console.debug('[subscribeRecord]', storeNameOf(record));
    if (!this.firestoreSubscriptions.hasOwnProperty(storeNameOf(record))) {
      console.debug('[subscribeRecord] subscribing');
      await this.subscribeObj(record, isPrivate);
    } else {
      console.warn('Already subscribed', record);
    }
  }

  protected unsubscribeRecord(record: typeof StoreRecord): any {
    const recordName = storeNameOf(record);
    console.debug('[unsubscribeRecord]', recordName);
    if (this.firestoreSubscriptions.hasOwnProperty(recordName)) {
      this.firestoreSubscriptions[recordName].unsubscribe();
      delete this.firestoreSubscriptions[recordName];
    } else {
      console.warn('Trying to unsubscribe from a subscription that doesnt exist', record);
    }
  }

  // Done implementing CloudStore, now helper functions:
  protected async subscribeObj(obj: any, isPrivate: boolean = true) {
    console.debug('[CloudFirebaseFirestore - subscribeObj]', obj, isPrivate, storeNameOf(obj), obj.name);
    const queryLimit = 500;
    const objectName = obj.name;
    let latestChangeId = await StoreRecord.getLatestChangeId(this.localStore.dataSource, obj, objectName, isPrivate);
    const objInstance = new obj();
    objInstance.isPrivate = isPrivate;
    const collectionPath = this.collectionPath(objInstance);
    console.debug('[CloudFirebaseFirestore - subscribeObj]', collectionPath, isPrivate, latestChangeId);
    return new Promise<void>(async (resolve) => {
      let unresolved = true;
      const collectionRef = collection(this.db, collectionPath);

      let q = query(collectionRef, where('changeId', '>', latestChangeId), orderBy('changeId'), limit(queryLimit));
      let documentSnapshots = await getDocs(q);
      console.debug(
        `[CloudFirebaseFirestore - subscribeObj] Downloading ${collectionPath}, size: ${documentSnapshots.size}, changeId: ${latestChangeId}`,
      );
      await this.resolveSnapshot(obj, documentSnapshots, latestChangeId, isPrivate, collectionPath);

      while (documentSnapshots.size === queryLimit) {
        const lastVisible = documentSnapshots.docs[documentSnapshots.docs.length - 1]; // Get cursor
        latestChangeId = await StoreRecord.getLatestChangeId(this.localStore.dataSource, obj, objectName, isPrivate);
        q = query(
          collectionRef,
          where('changeId', '>', latestChangeId),
          orderBy('changeId'),
          startAfter(lastVisible),
          limit(queryLimit),
        );

        documentSnapshots = await getDocs(q);
        console.debug(
          `[CloudFirebaseFirestore - subscribeObj] Downloading ${collectionPath}, size: ${documentSnapshots.size}, changeId: ${latestChangeId}`,
        );
        await this.resolveSnapshot(obj, documentSnapshots, latestChangeId, isPrivate, collectionPath);
      }

      const unsubscribe = onSnapshot(q, async (snapshot) => {
        latestChangeId = await StoreRecord.getLatestChangeId(this.localStore.dataSource, obj, objectName, isPrivate);
        await this.resolveSnapshot(obj, snapshot, latestChangeId, isPrivate, collectionPath);
        // TODO: Handle downloading status
        if (unresolved) {
          console.debug('[CloudFirebaseFirestore - subscribeObj] resolved', collectionPath);
          resolve();
          unresolved = false;
        }
      });

      this.firestoreSubscriptions[storeNameOf(objInstance)] = { record: obj, unsubscribe };
    });
  }

  // TODO: Correct types here
  private async resolveSnapshot(
    obj: any,
    snapshot: any,
    latestChangeId: number,
    isPrivate: boolean,
    collectionPath: string,
  ) {
    const records: StoreRecord[] = [];
    snapshot.docs.forEach((docRef: any) => {
      const d = docRef.data();
      // if (d.changeId > latestChangeId) {
      records.push(new obj(this.deserialize(d, docRef.id, isPrivate)));
      // }
    });
    console.debug(
      `[subscribeObj] Received object: ${collectionPath} ${records.length}; latest changeId: ${latestChangeId}, isPrivate: ${isPrivate}`,
      records[0],
      records[1],
      records,
    );
    await this.resolveRecords(obj, records);
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
  // live accessors so the writer's mutations land back on the entity, and toBody() defers to raw().
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
      toBody: () => obj.raw(),
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
      const unsubscribe = onSnapshot(docRef, async (snapshot) => {
        const data = this.deserialize(snapshot.data(), snapshot.id, true);
        delete data.id; // Only do this on user...
        const currentUser = this.user;
        console.debug('[CloudFirebaseFirestore - subscribeCloudUser] about to assign', data, currentUser);
        const updatedUser = currentUser ? Object.assign(currentUser, data) : new this.UserModel(data);
        await updatedUser.save({}, false);

        if (unresolved) {
          resolve();
          unresolved = false;
        }
      });
      this.firestoreSubscriptions['User'] = { record: BaseUser, unsubscribe };
    });
  }
}

interface FirestoreSubscription {
  unsubscribe: Unsubscribe;
  record: typeof StoreRecord;
}
