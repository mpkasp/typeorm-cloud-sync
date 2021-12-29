import {CloudService, CloudSubject} from './cloud.service';
import {SqliteStoreService} from './sqlite-store.service';

import {v4 as uuid} from 'uuid';
import {first, take} from 'rxjs/operators';
import {from} from 'rxjs';

import {FirebaseApp, initializeApp} from '@firebase/app';
import {Auth, getAuth, initializeAuth, setPersistence, signInWithCredential, GoogleAuthProvider, onAuthStateChanged, browserLocalPersistence} from '@firebase/auth';
import {collection, doc, addDoc, setDoc, getDoc, getDocs, deleteDoc, onSnapshot, getFirestore,
  Firestore, query, where, limit, orderBy, runTransaction, CollectionReference, Unsubscribe} from '@firebase/firestore';

export class CloudFirestoreService extends CloudService {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  firestoreUnsubscribes: Unsubscribe[] = [];

  constructor(private sqliteStoreService: SqliteStoreService) {
    super(sqliteStoreService);
    this.db = getFirestore(this.app);
    this.initFirestoreAuth();
    this.subscribeNetwork();
  }

  public async create(obj: any) {
    const collectionPath = this.collectionPath(obj);
    return addDoc(collection(this.db, collectionPath), obj.raw());
  }

  public async update(obj: any) {
    const documentPath = this.documentPath(obj);
    const docRef = doc(this.db, documentPath);
    return setDoc(docRef, obj.raw(), {merge: true});
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
            transaction.set(userDocRef, obj.raw(), {merge: true});
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
        transaction.set(docRef, model.raw(), {merge: true});
        transaction.update(metaDoc.ref, {changeId});
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

  public async delete(obj: any, fromDb: boolean = false, old: boolean = false) {
    if (fromDb) {
      const documentPath = this.documentPath(obj, old);
      const documentRef = doc(this.db, documentPath);
      return deleteDoc(documentRef);
    }
    obj.isDeleted = true;
    return this.updateStoreRecord(obj);
  }

  protected async subscribeCloudUser(): Promise<void> {
    const docPath = `${this.userDocument()}`;
    const docRef = doc(this.db, docPath);
    // For the user, since we don't use a standard UUID, for now we're just going to always update from cloud
    const userSubscription = onSnapshot(docRef, async (snapshot) => {
      const data = this.deserialize(snapshot.data(), snapshot.id);
      delete data.id; // Only do this on user...
      const currentUser = await this.localStore.getUser().pipe(first()).toPromise();
      console.log('[subscribeCloudUser] about to assign', data, currentUser);
      const updatedUser = currentUser ? Object.assign(currentUser, data) : new User(data);
      await updatedUser.save({}, false);

      if (updatedUser) {
        console.log('[resolvedUser]', updatedUser);
        this.user.next(updatedUser);
        this.sqliteStoreService.updateUser();
        this.sqliteStoreService.getActiveRecipe();
      }
      if (!this.user.initialized) {
        this.user.initialized = true;
        return Promise.resolve();
      }
    });
    this.firestoreUnsubscribes.push(userSubscription);
  }

  protected async subscribeObj(obj, subject: CloudSubject<any>): Promise<void> {
    let latestChangeId = await obj.getLatestChangeId();
    // console.log(`Latest ${obj.name} ChangeId: ${latestChangeId}`);

    const collectionPath = this.collectionPath(new obj());
    return new Promise<void>((resolve) => {
      const collectionRef = collection(this.db, collectionPath);
      const q = query(collectionRef, where('changeId', '>', latestChangeId));
      const unsubscribe = onSnapshot(q, async (snapshot) => {
        latestChangeId = await obj.getLatestChangeId();
        const records = [];
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
      //@ts-ignore
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

  // Auth stuff
  private async initFirestoreAuth() {
    console.log('[initFirestoreAuth]');
    if (Capacitor.isNativePlatform()) {
      this.auth = initializeAuth(this.app, {persistence: browserLocalPersistence});
    } else {
      this.auth = getAuth();
    }

    onAuthStateChanged(this.auth, userResponse => {
      // console.log('[initFirestoreAuth] onAuthStateChanged: ', userResponse);
      if (userResponse) {
        this.onAuthStateChange(userResponse);
      } else {
        console.log('[initFirestoreAuth] onAuthStateChanged, user not authenticated, not setting up listeners.');
      }

    }, error => {
      console.log('[initFirestoreAuth] onAuthStateChanged error: ', error);
    });

    const idToken = await FirebaseAuthentication.getIdToken();
    if (idToken?.token) {
      const credential = GoogleAuthProvider.credential(idToken.token);
      await signInWithCredential(this.auth, credential);
    }
    return this.auth;
  }

  private async onAuthStateChange(authUser) {
    const lastState = this.authenticatedSubject.getValue();
    const user: User = authUser ? await this.userFromAuthUser(authUser) : null;
    // console.log(user, authUser);
    this.authenticatedSubject.next(user);
    // console.log('[onAuthStateChange] updated subject', lastState, authUser);
    if (user) {
      // console.log('[onAuthStateChange] update store record', user, this.authenticatedSubject.getValue());
      await this.updateStoreRecord(user);
    }
    // console.log('[onAuthStateChange] state check', lastState, authUser);
    if (lastState != null && authUser == null) {
      // console.log('[onAuthStateChange] unsub');
      this.unsubscribeSubscriptions();
    } else if (lastState == null && authUser != null) {
      // console.log('[onAuthStateChange] SET UP CLOUD!');
      await this.setupCloudSubscriptions();
      this.updateCloudFromChangeLog();
      this.listenForLocalChanges();
    }
  }

  private async userFromAuthUser(authUser) {
    const name = authUser.displayName.split(' ');
    const firstName = name.shift();
    const lastName = name.join(' ');
    const authUserData = {
      firstName,
      lastName,
      displayName: authUser.displayName,
      email: authUser.email,
      photoURL: authUser.photoURL,
      firestoreAuthId: authUser.uid,
    };
    // TODO: user existing local user for their id, etc
    const localUser = await this.localStore.getUser().pipe(take(1)).toPromise();
    if (!localUser) {
      return new User(authUserData);
    }
    // console.log('[userFromAuthUser] about to assign', localUser, authUserData);
    return Object.assign(localUser, authUserData);
  }

  // Firestore stuff
  private userDocument(old: boolean = false): string {
    if (old) {
      return `/users/${this.authenticatedSubject.getValue().firestoreAuthId}`;
    } else {
      return `/User/${this.authenticatedSubject.getValue().firestoreAuthId}`;
    }
  }

  private collectionPath(obj: any, old: boolean = false): string {
    if (old) {
      return `${this.userDocument(true)}/${obj.constructor.name.toLowerCase()}`;
    } else {
      return `${this.userDocument()}/${obj.constructor.name}`;
    }
  }

  private documentPath(obj: any, old: boolean = false): string {
    return obj.constructor.name === 'User' ? this.userDocument() : `${this.collectionPath(obj, old)}/${obj.id}`;
  }

  protected setupCloudSubscriptions(): Promise<any> {
    return Promise.resolve(undefined);
  }
}
