// tslint:disable: no-console
import { CloudStore } from '../cloud-store';
import { SqliteStore } from '../../sqlite-store';
import { StoreRecord } from '../../models/store-record.model';
import { BaseUser } from '../../models/base-user.model';

import { v4 as uuid } from 'uuid';

import { FirebaseApp } from '@firebase/app';
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
  runTransaction,
  CollectionReference,
  Unsubscribe,
} from '@firebase/firestore';

export class CloudFirebaseFirestore extends CloudStore {
  db: Firestore;
  private firestoreUnsubscribes: Unsubscribe[] = [];

  constructor(
    readonly sqliteStore: SqliteStore,
    protected UserModel: typeof BaseUser,
    protected publicRecords: typeof StoreRecord[],
    protected privateRecords: typeof StoreRecord[],
    app: FirebaseApp,
  ) {
    super(sqliteStore, UserModel, publicRecords, privateRecords);
    this.db = getFirestore(app);
    this.initialize();
  }

  // Implement CloudStore

  public async create(obj: any) {
    const collectionPath = this.collectionPath(obj, true);
    return addDoc(collection(this.db, collectionPath), obj.raw());
  }

  public async update(obj: any) {
    const documentPath = this.documentPath(obj, true);
    const docRef = doc(this.db, documentPath);
    return setDoc(docRef, obj.raw(), { merge: true });
  }

  public async updateStoreRecord(obj: any) {
    console.log('[updateStoreRecord]', obj);
    const modelName = obj.constructor.name;
    const collectionPath = this.collectionPath(obj, true);
    const baseCollection = collection(this.db, collectionPath);
    const baseDocument = doc(this.db, this.userDocument());
    // console.log('[updateStoreRecord]', modelName, baseDocument);

    if (modelName !== 'User') {
      // console.log('[updateStoreRecord] Not User');
      const metaCollection = baseDocument.path + '/Meta';
      // console.log('[updateStoreRecord] ', metaCollection);
      const metaCollectionRef = collection(this.db, metaCollection);
      // console.log('[updateStoreRecord] ', metaCollectionRef);
      const snapshot = await getDocs(query(metaCollectionRef, where('collection', '==', modelName), limit(1)));

      if (snapshot.empty) {
        const newId = uuid();
        const metaData = {
          collection: modelName,
          changeId: 0,
          // size: 0,
        };
        const ref = doc(this.db, metaCollection, newId);
        await setDoc(ref, metaData);
        // console.log('[updateStoreRecord] about to update public store record');
        return this.updatePublicStoreRecord(obj, ref, baseCollection);
      }

      const metaDocRef = snapshot.docs[0].ref;
      return this.updatePublicStoreRecord(obj, metaDocRef, baseCollection);
    } else {
      // console.log('[updateStoreRecord] User');
      // console.log('[updateStoreRecord] User Document: ', this.userDocument());
      const userDocRef = doc(this.db, this.userDocument());
      const document = await getDoc(userDocRef);
      // console.log('[updateStoreRecord] User', document.exists);
      if (!document.exists()) {
        console.log("[firestore-model] Update: document doesn't exist for this user, ", document);
        return await setDoc(userDocRef, obj.raw());
        // throw new Error('Document doesn\'t exist for this user');
      }
      // console.log('[updateStoreRecord] about to run transaction');
      return runTransaction(this.db, (transaction) =>
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
      )
        .then((val) => {
          // console.log(val);
        })
        .catch((err) => {
          console.warn(err);
        });
    }
  }

  public updatePublicStoreRecord(model: any, metaDocRef: any, collectionRef: CollectionReference): Promise<any> {
    console.log('[updatePublicStoreRecord]', model);
    return runTransaction(this.db, (transaction) =>
      transaction.get(metaDocRef).then((metaDoc) => {
        let changeId = 0;
        if (metaDoc.exists()) {
          console.log('[updatePublicStoreRecord] metaDoc exists', metaDoc.data());
          // @ts-ignore
          changeId = metaDoc.data().changeId + 1;
          model.changeId = changeId;
          model.recordChangeTimestamp = new Date();
          console.log('[updatePublicStoreRecord] collectionRef.path: ', collectionRef.path);
          const docRef = doc(this.db, collectionRef.path + '/' + model.id);
          // const docRef = collectionRef.doc(model.id);
          console.log('[updatePublicStoreRecord]', model, model.raw());
          // Need merge = true if we want to allow migrations since it uses the uid property
          transaction.set(docRef, model.raw(), { merge: true });
          transaction.update(metaDoc.ref, { changeId });
        } else {
          throw Error('Document does not exist!');
        }
        return model;
      }),
    )
      .then((val) => {
        console.log('[updatePublicStoreRecord]', val);
      })
      .catch((err) => {
        console.error(err);
        console.warn(
          "Make sure the collection is created. Our rules don't allow creation of collections, even for admins!",
        );
      });
  }

  public async delete(obj: any, fromDb: boolean = false) {
    if (fromDb) {
      const documentPath = this.documentPath(obj, true);
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
    for (const key in data) {
      if (data.hasOwnProperty(key) && data[key] && typeof data[key].toDate === 'function') {
        data[key] = data[key].toDate();
      } else if (data.hasOwnProperty(key) && data[key] && typeof data[key].toUint8Array === 'function') {
        data[key] = data[key].toUint8Array();
      } else if (data.hasOwnProperty(key) && data[key] && typeof data[key] === 'object' && key !== 'ref') {
        data[key] = this.deserialize(data[key]);
      }
    }
    if (id) {
      data.id = id;
    }
    data.isPrivate = isPrivate;
    console.log('[CloudFirebaseFirestore - deserialize]: ', data, id);
    return data;
  }

  protected async subscribePublicCloud() {
    return this.publicRecords.forEach(async (PublicRecord) => {
      await this.subscribeObj(PublicRecord, false);
    }, Error());
  }

  protected async subscribePrivateCloud() {
    // TODO: await cloud user??
    await this.subscribeCloudUser();
    return this.privateRecords.forEach(async (PrivateRecord) => {
      console.log('[CloudFirebaseFirestore - subscribePrivateCloud] subscribing to: ', PrivateRecord);
      await this.subscribeObj(PrivateRecord, true);
    }, Error());
  }

  protected unsubscribePrivateCloud() {
    this.firestoreUnsubscribes.forEach((unsubscribe) => unsubscribe());
    this.firestoreUnsubscribes = [];
  }

  // Done implementing CloudStore, now helper functions:

  protected async subscribeObj(obj: any, isPrivate: boolean = true) {
    let latestChangeId = await obj.getLatestChangeId();
    const collectionPath = this.collectionPath(new obj(), isPrivate);

    return new Promise<void>((resolve) => {
      const collectionRef = collection(this.db, collectionPath);
      const q = query(collectionRef, where('changeId', '>', latestChangeId));
      let unresolved = true;
      const unsubscribe = onSnapshot(q, async (snapshot) => {
        latestChangeId = await obj.getLatestChangeId();
        const records: StoreRecord[] = [];
        snapshot.docs.forEach((docRef) => {
          const d = docRef.data();
          if (d.changeId > latestChangeId) {
            records.push(new obj(this.deserialize(d, docRef.id, isPrivate)));
          }

          if (unresolved) {
            resolve();
            unresolved = false;
          }
        });
        // console.log(`[subscribeObj] Received object: ${collectionPath} ${records.length}`, records[0], records[1], records);
        await this.resolveRecords(obj, records);
        // TODO: Handle downloading status
      });

      this.firestoreUnsubscribes.push(unsubscribe);
    });
  }

  private collectionPath(obj: any, isPrivate: boolean): string {
    if (!isPrivate) {
      return `/${obj.constructor.name}`;
    }
    return `${this.userDocument()}/${obj.constructor.name}`;
  }

  private documentPath(obj: any, isPrivate: boolean): string {
    return obj.constructor.name === 'User' ? this.userDocument() : `${this.collectionPath(obj, isPrivate)}/${obj.id}`;
  }

  // User for private data
  private userDocument(): string {
    if (this.user) {
      return `/User/${this.user.authId}`;
    }
    throw new Error('No cloud user found.');
  }

  private async subscribeCloudUser() {
    const docPath = `${this.userDocument()}`;
    const docRef = doc(this.db, docPath);
    // For the user, since we don't use a standard UUID, for now we're just going to always update from cloud
    return new Promise<void>((resolve) => {
      let unresolved = true;
      const unsubscribe = onSnapshot(docRef, async (snapshot) => {
        const data = this.deserialize(snapshot.data(), snapshot.id, true);
        delete data.id; // Only do this on user...
        const currentUser = this.user;
        console.log('[subscribeCloudUser] about to assign', data, currentUser);
        const updatedUser = currentUser ? Object.assign(currentUser, data) : new this.UserModel(data);
        await updatedUser.save({}, false);

        if (unresolved) {
          resolve();
          unresolved = false;
        }
      });
      this.firestoreUnsubscribes.push(unsubscribe);
    });
  }
}
