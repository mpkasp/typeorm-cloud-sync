// tslint:disable: no-console
import { CloudStore } from '../cloud-store';
import { SqliteStore } from '../../sqlite-store';
import { CloudSubject } from '../cloud-subject';

import { v4 as uuid } from 'uuid';
import { first, take } from 'rxjs/operators';

import { FirebaseApp } from '@firebase/app';
import { Auth, onAuthStateChanged } from '@firebase/auth';
import {
  collection, doc, addDoc, setDoc, getDoc, getDocs, deleteDoc, onSnapshot, getFirestore,
  Firestore, query, where, limit, orderBy, runTransaction, CollectionReference, Unsubscribe,
} from '@firebase/firestore';
import { StoreRecord } from '../../models/store-record.model';
import { User } from '../../models/user.model';

export class CloudFirebaseFirestore extends CloudStore {
  db: Firestore;
  firestoreUnsubscribes: Unsubscribe[] = [];
  localUser: User | null = await User.findOne();

  private authenticated: boolean = false;

  constructor(readonly sqliteStore: SqliteStore, app: FirebaseApp, public UserModel: typeof User) {
    super(sqliteStore);
    this.db = getFirestore(app);
    this.subscribeNetwork();
  }

  public async create(obj: any) {
    const collectionPath = this.collectionPath(obj);
    return addDoc(collection(this.db, collectionPath), obj.raw());
  }

  public async update(obj: any) {
    const documentPath = this.documentPath(obj);
    const docRef = doc(this.db, documentPath);
    return setDoc(docRef, obj.raw(), { merge: true });
  }

  public async updateStoreRecord(obj: any) {
    console.log('[updateStoreRecord]', obj);
    const modelName = obj.constructor.name;
    const collectionPath = this.collectionPath(obj);
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
        console.log('[firestore-model] Update: document doesn\'t exist for this user, ', document);
        return await setDoc(userDocRef, obj.raw());
        // throw new Error('Document doesn\'t exist for this user');
      }
      // console.log('[updateStoreRecord] about to run transaction');
      return runTransaction(this.db, transaction => transaction.get(userDocRef).then(userDoc => {
        console.log('[updateStoreRecord, firestore-model] updating user', document.data(), userDoc, userDoc.data(), obj);
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
      })).then(val => {
        // console.log(val);
      }).catch(err => {
        console.warn(err);
      });
    }
  }

  public updatePublicStoreRecord(model: any, metaDocRef: any, collectionRef: CollectionReference): Promise<any> {
    console.log('[updatePublicStoreRecord]', model);
    return runTransaction(this.db, transaction => transaction.get(metaDocRef).then(metaDoc => {
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
    })).then(val => {
      console.log('[updatePublicStoreRecord]', val);
    }).catch(err => {
      console.error(err);
      console.warn('Make sure the collection is created. Our rules don\'t allow creation of collections, even for admins!');
    });
  }

  public async delete(obj: any, fromDb: boolean = false) {
    if (fromDb) {
      const documentPath = this.documentPath(obj);
      const documentRef = doc(this.db, documentPath);
      return deleteDoc(documentRef);
    }
    obj.isDeleted = true;
    return this.updateStoreRecord(obj);
  }

  protected async subscribeObj(obj: any, subject: CloudSubject<any>): Promise<void> {
    let latestChangeId = await obj.getLatestChangeId();
    // console.log(`Latest ${obj.name} ChangeId: ${latestChangeId}`);

    const collectionPath = this.collectionPath(new obj());
    return new Promise<void>((resolve) => {
      const collectionRef = collection(this.db, collectionPath);
      const q = query(collectionRef, where('changeId', '>', latestChangeId));
      const unsubscribe = onSnapshot(q, async (snapshot) => {
        latestChangeId = await obj.getLatestChangeId();
        const records: StoreRecord[] = [];
        snapshot.docs.forEach(docRef => {
          const d = docRef.data();
          if (d.changeId > latestChangeId) {
            records.push(new obj(this.deserialize(d, docRef.id)));
          }
        });
        // console.log(`[subscribeObj] Received object: ${collectionPath} ${records.length}`, records[0], records[1], records);
        const resolvedRecords = await this.resolveRecords(obj, records);
        if (resolvedRecords) {
          subject.next(resolvedRecords);
        }
        if (!subject.initialized) {
          resolve();
          subject.initialized = true;
          this.cloudDownloading.next(!this.subscriptionsInitialized());
        }
      });

      this.firestoreUnsubscribes.push(unsubscribe);
    });
  }

  protected unsubscribeCloudSubscriptions() {
    this.cloudSubscriptions.forEach(subscription => subscription.unsubscribe());
    this.cloudSubscriptions = [];
  }

  protected deserialize(data: any, id?: string): any {
    // console.log('[deserialize]: ', data, id);
    if (data.hasOwnProperty('created')) {
      // @ts-ignore
      delete data.created;
    }
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
    // console.log('[deserialize]: ', data);
    return data;
  }

  private collectionPath(obj: any): string {
    if (obj.isPublic) {
      return `/${obj.constructor.name}`;
    }
    return `${this.userDocument()}/${obj.constructor.name}`;
  }

  private documentPath(obj: any): string {
    return obj.constructor.name === 'User' ? this.userDocument() : `${this.collectionPath(obj)}/${obj.id}`;
  }

  protected setupCloudSubscriptions(): Promise<any> {
    // TODO: Can we subscribe to meta table, then automate setting up sync subcriptions?
    //   Can we trigger start/stopping of this based on User subscription?
    //   How do we handle user subscription local vs cloud?
    // TODO: Subscribe to public meta table
    // TODO: Subscribe to private meta table
    this.subscribeCloudUser();
    return Promise.resolve(undefined);
  }

  // User for private data
  private userDocument(): string {
    if (this.localUser) {
      return `/User/${this.localUser.firestoreAuthId}`;
    }
    throw new Error('No cloud user found.');
  }

  protected async subscribeCloudUser(): Promise<void> {
    const docPath = `${this.userDocument()}`;
    const docRef = doc(this.db, docPath);
    // For the user, since we don't use a standard UUID, for now we're just going to always update from cloud
    const userSubscription = onSnapshot(docRef, async (snapshot) => {
      const data = this.deserialize(snapshot.data(), snapshot.id);
      delete data.id; // Only do this on user...
      const currentUser = await this.sqliteStore.user;
      console.log('[subscribeCloudUser] about to assign', data, currentUser);
      const updatedUser = currentUser ? Object.assign(currentUser, data) : new this.UserModel(data);
      await updatedUser.save({}, false);

      if (updatedUser) {
        console.log('[subscribeCloudUser] resolvedUser', updatedUser);
        this.sqliteStore.updateUser();
      }
    });
    this.firestoreUnsubscribes.push(userSubscription);
  }

  // Cloud subscriptions are handled based on auth state
  private async onAuthStateChange(authenticated: boolean) {
    const lastState = this.authenticated;
    if (lastState && !authenticated) {
      this.unsubscribeSubscriptions();
    } else if (!lastState && authenticated) {
      await this.setupCloudSubscriptions();
      this.updateCloudFromChangeLog();
    }
    this.authenticated = authenticated;
  }
}
