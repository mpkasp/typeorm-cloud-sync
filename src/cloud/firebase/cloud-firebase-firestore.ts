// tslint:disable: no-console
import { CloudStore } from '../cloud-store';
import { SqliteStore } from '../../sqlite-store';
import { StoreRecord } from '../../models/store-record.model';
import { BaseUser } from '../../models/base-user.model';

import { v4 as uuid } from 'uuid';

import { FirebaseApp, initializeApp } from 'firebase/app';
import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
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
  runTransaction,
  CollectionReference,
  Unsubscribe,
} from 'firebase/firestore';

export class CloudFirebaseFirestore extends CloudStore {
  db: Firestore;
  private firestoreSubscriptions: { [key: string]: FirestoreSubscription } = {};

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
    console.log('[updateStoreRecord]', obj);
    const modelName = obj.constructor.name;
    // console.log('[updateStoreRecord]', modelName);
    if (modelName !== 'User') {
      const collectionPath = this.collectionPath(obj);
      const baseCollection = collection(this.db, collectionPath);
      const metaCollection = this.metaCollectionPath(obj);
      console.log('[updateStoreRecord] Object other than "User".', collectionPath, metaCollection);
      const metaCollectionRef = collection(this.db, metaCollection);

      const snapshot = await getDocs(query(metaCollectionRef, where('collection', '==', modelName)));
      console.log('[updateStoreRecord] got meta snapshot', snapshot);
      if (snapshot.empty) {
        const newId = uuid();
        console.log('[updateStoreRecord] getting latest changeId');
        let latestChangeId = await StoreRecord.getLatestChangeId(this.localStore.dataSource, {type: obj, name: modelName}, modelName, obj.isPrivate);
        console.log('[updateStoreRecord] change id doesnt exist, latest:', latestChangeId);

        const metaData = {
          collection: modelName,
          changeId: latestChangeId,
          // size: 0,
        };
        const ref = doc(this.db, metaCollection, newId);
        await setDoc(ref, metaData);
        // console.log('[updateStoreRecord] about to update public store record');
        return this.updatePublicStoreRecord(obj, ref, baseCollection);
      }


      let metaDoc = snapshot.docs[0];
      console.log('[updateStoreRecord] got metaDoc', snapshot, metaDoc);
      if (snapshot.docs.length > 1) {
        snapshot.docs.slice(1).forEach(doc => {
          console.log('[updateStoreRecord] found more than one meta doc, comparing docs', metaDoc.id, metaDoc.data(), doc.id, doc.data(), snapshot.docs);
          if (metaDoc.data().changeId < doc.data().changeId) {
            console.log('[updateStoreRecord] DELETING REF', metaDoc.id, metaDoc.data());
            deleteDoc(metaDoc.ref);
            metaDoc = doc;
          } else {
            console.log('[updateStoreRecord] DELETING REF', doc.id, doc.data());
            deleteDoc(doc.ref);
          }
        });
      }

      let metaDocRef = metaDoc.ref;
      return this.updatePublicStoreRecord(obj, metaDocRef, baseCollection);
    } else {
      // console.log('[updateStoreRecord] User');
      console.log('[updateStoreRecord] User Document: ', obj);
      const user = obj as BaseUser;
      if (!user.authId) {
        console.warn('Trying to update user object without an auth id', user);
        return obj;
      }
      console.log('[updateStoreRecord] User Document with valid id: ', user, user?.authId, this.db);
      const userDocRef = doc(this.db, this.userDocument(user.authId));
      console.log('[updateStoreRecord] got doc ref: ', userDocRef);
      const document = await getDoc(userDocRef);
      console.log('[updateStoreRecord] User', document.exists);
      if (!document.exists()) {
        console.log("[firestore-model] Update: document doesn't exist for this user, ", document);
        await setDoc(userDocRef, obj.raw());
        return obj;
        // throw new Error('Document doesn\'t exist for this user');
      }
      console.log('[updateStoreRecord] about to run transaction');
      await runTransaction(this.db, (transaction) =>
        transaction.get(userDocRef).then((userDoc) => {
          console.log(
            '[updateStoreRecord, firestore-model] updating user',
            document.data(),
            userDoc,
            userDoc.data(),
            obj,
          );
          let changeId = 0;
          if (userDoc.exists()) {
            changeId = userDoc.data().changeId + 1;
            obj.changeId = changeId;
            // const doc = db.doc(this.userDocument());
            // set vs update: The set call on the other hand, will create or update the document as needed.
            transaction.set(userDocRef, obj.raw(), { merge: true });
          } else {
            throw Error('Document does not exist!');
          }
          return obj;
        }),
      ).catch((err) => {
        console.warn(err);
        throw err;
      });

      return obj;
    }
  }

  public async updatePublicStoreRecord(
    model: StoreRecord,
    metaDocRef: any,
    collectionRef: CollectionReference,
  ): Promise<StoreRecord> {
    console.log('[updatePublicStoreRecord]', model);
    await runTransaction(this.db, (transaction) =>
      transaction.get(metaDocRef).then((metaDoc) => {
        let changeId = 0;
        if (metaDoc.exists()) {
          // console.log('[updatePublicStoreRecord] metaDoc exists', metaDoc.data());
          // @ts-ignore
          changeId = metaDoc.data().changeId + 1;
          model.changeId = changeId;
          model.recordChangeTimestamp = new Date();
          // console.log('[updatePublicStoreRecord] collectionRef.path: ', collectionRef.path);
          const docRef = doc(this.db, collectionRef.path + '/' + model.id);
          // const docRef = collectionRef.doc(model.id);
          // console.log('[updatePublicStoreRecord]', model, model.raw());
          // Need merge = true if we want to allow migrations since it uses the uid property
          transaction.set(docRef, model.raw(), { merge: true });
          transaction.update(metaDoc.ref, { changeId });
        } else {
          throw Error('Document does not exist!');
        }
        return model;
      }),
    ).catch((err) => {
      console.error(err);
      console.warn(
        "Make sure the collection is created. Our rules don't allow creation of collections, even for admins!",
      );
      throw err;
    });

    return model;
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
      console.log('[CloudFirebaseFirestore - subscribePublicCloud]', PublicRecord.name);
      await this.subscribeObj(PublicRecord, false);
      // console.log('[CloudFirebaseFirestore - subscribePublicCloud] done', PublicRecord.name);
    }
  }

  protected async subscribePrivateCloud() {
    // console.log('[CloudFirebaseFirestore - subscribePrivateCloud] subscribing to private records!');
    if (this.privateCloudInitialized) {
      console.log('[CloudFirebaseFirestore - subscribePrivateCloud] already initialized');
      return;
    }
    console.log('[CloudFirebaseFirestore - subscribePrivateCloud] User');
    await this.subscribeCloudUser();
    // console.log('[CloudFirebaseFirestore - subscribePrivateCloud] done User');
    // for (let i = 0; i < this.privateRecords.length; i++) {
    //   const PrivateRecord = this.privateRecords[i];
    for (const PrivateRecord of this.privateRecords) {
      console.log('[CloudFirebaseFirestore - subscribePrivateCloud]', PrivateRecord.name);
      await this.subscribeObj(PrivateRecord, true);
      console.log('[CloudFirebaseFirestore - subscribePrivateCloud] done', PrivateRecord.name);
    }
    this.privateCloudInitialized = true;
  }

  protected unsubscribePrivateCloud() {
    this.privateCloudInitialized = false;
    Object.entries(this.firestoreSubscriptions).forEach(([_, fs]) => fs.unsubscribe());
    this.firestoreSubscriptions = {};
  }

  protected async subscribeRecord(record: typeof StoreRecord, isPrivate: boolean): Promise<any> {
    console.log('[subscribeRecord]', record.constructor.name);
    if (!this.firestoreSubscriptions.hasOwnProperty(record.constructor.name)) {
      console.log('[subscribeRecord] subscribing');
      await this.subscribeObj(record.constructor, isPrivate);
      // console.log('[subscribeRecord] done subscribing');
    } else {
      console.warn('Already subscribed', record);
    }
  }

  protected unsubscribeRecord(record: typeof StoreRecord): any {
    const recordName = record.constructor.name;
    console.log('[unsubscribeRecord]', record.constructor.name);
    if (this.firestoreSubscriptions.hasOwnProperty(recordName)) {
      this.firestoreSubscriptions[recordName].unsubscribe();
      delete this.firestoreSubscriptions[recordName];
    } else {
      console.warn('Trying to unsubscribe from a subscription that doesnt exist', record);
    }
  }

  // Done implementing CloudStore, now helper functions:
  protected async subscribeObj(obj: any, isPrivate: boolean = true) {
    console.log('[CloudFirebaseFirestore - subscribeObj]', obj, isPrivate, obj.constructor.name, obj.name);
    const queryLimit = 500;
    const objectName = obj.name;
    let latestChangeId = await StoreRecord.getLatestChangeId(this.localStore.dataSource, obj, objectName, isPrivate);
    const objInstance = new obj();
    objInstance.isPrivate = isPrivate;
    const collectionPath = this.collectionPath(objInstance);
    console.log('[CloudFirebaseFirestore - subscribeObj]', collectionPath, isPrivate, latestChangeId);
    return new Promise<void>(async (resolve) => {
      let unresolved = true;
      const collectionRef = collection(this.db, collectionPath);

      let q = query(collectionRef, where('changeId', '>', latestChangeId), orderBy('changeId'), limit(queryLimit));
      let documentSnapshots = await getDocs(q);
      console.log(
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
        console.log(
          `[CloudFirebaseFirestore - subscribeObj] Downloading ${collectionPath}, size: ${documentSnapshots.size}, changeId: ${latestChangeId}`,
        );
        await this.resolveSnapshot(obj, documentSnapshots, latestChangeId, isPrivate, collectionPath);
      }

      const unsubscribe = onSnapshot(q, async (snapshot) => {
        latestChangeId = await StoreRecord.getLatestChangeId(this.localStore.dataSource, obj, objectName, isPrivate);
        await this.resolveSnapshot(obj, snapshot, latestChangeId, isPrivate, collectionPath);
        // TODO: Handle downloading status
        if (unresolved) {
          console.log('[CloudFirebaseFirestore - subscribeObj] resolved', collectionPath);
          resolve();
          unresolved = false;
        }
      });

      this.firestoreSubscriptions[objInstance.constructor.name] = { record: obj, unsubscribe };
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
    console.log(
      `[subscribeObj] Received object: ${collectionPath} ${records.length}; latest changeId: ${latestChangeId}, isPrivate: ${isPrivate}`,
      records[0],
      records[1],
      records,
    );
    await this.resolveRecords(obj, records);
  }

  private collectionPath(obj: StoreRecord): string {
    if (!obj.isPrivate) {
      return `${obj.constructor.name}`;
    }
    return `${this.userDocument()}/${obj.constructor.name}`;
  }

  private metaCollectionPath(obj: StoreRecord): string {
    if (!obj.isPrivate) {
      return `Meta`;
    }
    return doc(this.db, this.userDocument()).path + '/Meta';
  }

  private documentPath(obj: StoreRecord): string {
    return obj.constructor.name === 'User' ? this.userDocument() : `${this.collectionPath(obj)}/${obj.id}`;
  }

  // User for private data
  private userDocument(authId?: string | null): string {
    // console.log('[userDocument] ', this.user);
    if (!authId) {
      authId = this.user?.authId;
    }
    if (authId) {
      return `/User/${authId}`;
    }
    throw new Error('No cloud user found.');
  }

  private async subscribeCloudUser() {
    console.log('[CloudFirebaseFirestore - subscribeCloudUser] 1');
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
        console.log('[CloudFirebaseFirestore - subscribeCloudUser] about to assign', data, currentUser);
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
