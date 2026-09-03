// tslint:disable: no-console
import { FirestorePort, VersionedRecord } from './firestore-port';
import { PathBuilder } from './path-builder';

export interface WriteOptions {
  // Seed value for a collection's Meta doc the first time it is created (before any changeId has
  // been allocated in the cloud). On the client this comes from the local store's max changeId
  // (StoreRecord.getLatestChangeId) so a collection migrating to the cloud doesn't restart at 0; on
  // the server it is simply 0 (the Meta doc is only absent when no client has ever synced the
  // collection, so there is nothing to clobber). Replaces the original inline getLatestChangeId call.
  seedChangeId?: () => Promise<number>;
}

// The versioned write protocol, moved out of CloudFirebaseFirestore so the client (web SDK) and a
// Cloud Function (Admin SDK) run the SAME code over their own FirestorePort binding. This is a
// behavior-preserving lift of the original updateStoreRecord + updatePublicStoreRecord: the ONLY
// changes are the ones needed to cross the SDK seam —
//   - obj/model are a VersionedRecord view instead of a StoreRecord (obj.raw(), obj.storeName,
//     obj.authId instead of storeNameOf(obj) / (obj as BaseUser).authId);
//   - web-SDK calls become port calls: getDocs(query(...)) -> port.queryMeta(); doc()/DocumentReference
//     -> string paths; snapshot.empty/.docs/.data()/.ref -> array length/[]/.data/.path;
//     runTransaction(this.db, ...) -> port.runTransaction(...);
//   - the newId+setDoc(doc(this.db, metaCollection, newId)) meta-create uses port.newDocPath();
//   - latestChangeId comes from opts.seedChangeId() instead of StoreRecord.getLatestChangeId().
export class StoreRecordWriter {
  constructor(private port: FirestorePort, private paths: PathBuilder) {}

  public async updateStoreRecord(obj: VersionedRecord, opts: WriteOptions = {}): Promise<VersionedRecord> {
    console.debug('[updateStoreRecord]', obj);
    const modelName = obj.storeName;
    if (modelName !== 'User') {
      const collectionPath = this.paths.collectionPath(obj);
      const metaCollection = this.paths.metaCollectionPath(obj);
      console.debug('[updateStoreRecord] Object other than "User".', collectionPath, metaCollection);

      const metaDocs = await this.port.queryMeta(metaCollection, modelName);
      console.debug('[updateStoreRecord] got meta snapshot', metaDocs);
      if (metaDocs.length === 0) {
        console.debug('[updateStoreRecord] getting latest changeId');
        const latestChangeId = opts.seedChangeId ? await opts.seedChangeId() : 0;
        console.debug('[updateStoreRecord] change id doesnt exist, latest:', latestChangeId);

        const metaData = {
          collection: modelName,
          changeId: latestChangeId,
          // size: 0,
        };
        const metaPath = this.port.newDocPath(metaCollection);
        await this.port.setDoc(metaPath, metaData);
        // console.log('[updateStoreRecord] about to update public store record');
        return this.updatePublicStoreRecord(obj, metaPath, collectionPath);
      }

      let metaDoc = metaDocs[0];
      console.debug('[updateStoreRecord] got metaDoc', metaDocs, metaDoc);
      if (metaDocs.length > 1) {
        metaDocs.slice(1).forEach((doc) => {
          console.warn('[updateStoreRecord] found more than one meta doc, comparing docs', metaDoc.path, metaDoc.data, doc.path, doc.data, metaDocs);
          if (metaDoc.data!.changeId < doc.data!.changeId) {
            console.debug('[updateStoreRecord] DELETING REF', metaDoc.path, metaDoc.data);
            this.port.deleteDoc(metaDoc.path);
            metaDoc = doc;
          } else {
            console.debug('[updateStoreRecord] DELETING REF', doc.path, doc.data);
            this.port.deleteDoc(doc.path);
          }
        });
      }

      const metaDocPath = metaDoc.path;
      return this.updatePublicStoreRecord(obj, metaDocPath, collectionPath);
    } else {
      // console.log('[updateStoreRecord] User');
      console.debug('[updateStoreRecord] User Document: ', obj);
      const user = obj;
      if (!user.authId) {
        console.warn('Trying to update user object without an auth id', user);
        return obj;
      }
      console.debug('[updateStoreRecord] User Document with valid id: ', user, user?.authId);
      const userPath = this.paths.userDocument(user.authId);
      const document = await this.port.getDoc(userPath);
      console.debug('[updateStoreRecord] User', document.exists);
      if (!document.exists) {
        console.debug("[firestore-model] Update: document doesn't exist for this user, ", document);
        await this.port.setDoc(userPath, obj.raw());
        return obj;
        // throw new Error('Document doesn\'t exist for this user');
      }
      console.debug('[updateStoreRecord] about to run transaction');
      await this.port.runTransaction((transaction) =>
        transaction.get(userPath).then((userDoc) => {
          console.debug('[updateStoreRecord, firestore-model] updating user', document.data, userDoc, userDoc.data, obj);
          let changeId = 0;
          if (userDoc.exists) {
            changeId = userDoc.data!.changeId + 1;
            obj.changeId = changeId;
            // set vs update: The set call on the other hand, will create or update the document as needed.
            transaction.set(userPath, obj.raw(), { merge: true });
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
    model: VersionedRecord,
    metaDocPath: string,
    collectionPath: string,
  ): Promise<VersionedRecord> {
    console.debug('[updatePublicStoreRecord]', model);
    await this.port.runTransaction((transaction) =>
      transaction.get(metaDocPath).then((metaDoc) => {
        let changeId = 0;
        if (metaDoc.exists) {
          // console.log('[updatePublicStoreRecord] metaDoc exists', metaDoc.data);
          changeId = metaDoc.data!.changeId + 1;
          model.changeId = changeId;
          model.recordChangeTimestamp = new Date();
          const docPath = collectionPath + '/' + model.id;
          // Need merge = true if we want to allow migrations since it uses the uid property
          transaction.set(docPath, model.raw(), { merge: true });
          transaction.update(metaDocPath, { changeId });
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
}
