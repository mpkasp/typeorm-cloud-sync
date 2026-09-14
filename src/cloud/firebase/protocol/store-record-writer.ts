// tslint:disable: no-console
import { FirestorePort, VersionedRecord } from './firestore-port';
import { PathBuilder } from './path-builder';

export interface WriteOptions {
  // Seed value for a collection's Meta doc the first time it is created (before any changeId has
  // been allocated in the cloud). On the client this comes from the local store's max changeId
  // (StoreRecord.getLatestChangeId) so a collection migrating to the cloud doesn't restart at 0; on
  // the server it is simply 0 (the Meta doc is only absent when no client has ever synced the
  // collection, so there is nothing to clobber).
  seedChangeId?: () => Promise<number>;
}

// The versioned write protocol, shared by the client (web SDK) and a Cloud Function (Admin SDK),
// each over its own FirestorePort binding. A record's changeId is allocated from its collection's
// Meta doc at the deterministic path `{metaCollectionPath}/{storeName}`, read and bumped in the same
// transaction as the record write, so concurrent writers — including two creating the first Meta —
// conflict and retry instead of allocating the same changeId.
export class StoreRecordWriter {
  constructor(
    private port: FirestorePort,
    private paths: PathBuilder,
  ) {}

  public async updateStoreRecord(obj: VersionedRecord, opts: WriteOptions = {}): Promise<VersionedRecord> {
    console.debug('[updateStoreRecord]', obj);
    if (obj.storeName !== 'User') {
      return this.updatePublicStoreRecord(obj, opts);
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
      await this.port
        .runTransaction((transaction) =>
          transaction.get(userPath).then((userDoc) => {
            console.debug(
              '[updateStoreRecord, firestore-model] updating user',
              document.data,
              userDoc,
              userDoc.data,
              obj,
            );
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
        )
        .catch((err) => {
          console.warn(err);
          throw err;
        });

      return obj;
    }
  }

  public async updatePublicStoreRecord(model: VersionedRecord, opts: WriteOptions = {}): Promise<VersionedRecord> {
    console.debug('[updatePublicStoreRecord]', model);
    const metaCollectionPath = this.paths.metaCollectionPath(model);
    const metaDocumentPath = this.paths.metaDocumentPath(model);
    const documentPath = this.paths.documentPath(model);
    const localChangeId = model.changeId;
    const localRecordChangeTimestamp = model.recordChangeTimestamp;
    await this.port
      .runTransaction(async (transaction) => {
        const metaDoc = await transaction.get(metaDocumentPath);
        const cloudDoc = await transaction.get(documentPath);
        // A newer cloud copy is another writer's later edit: overwriting it would lose that edit. The
        // record keeps its local changeId, which is below the cloud copy's, so the download applies it.
        // Restored rather than left alone because an earlier attempt of this transaction may have set it.
        const cloudUpdatedMs = cloudDoc.data?.updatedMs;
        if (cloudDoc.exists && typeof cloudUpdatedMs === 'number' && cloudUpdatedMs > (model.raw().updatedMs ?? 0)) {
          console.debug('[updatePublicStoreRecord] cloud copy is newer, not overwriting', documentPath);
          model.changeId = localChangeId;
          model.recordChangeTimestamp = localRecordChangeTimestamp;
          return;
        }
        const currentChangeId = metaDoc.exists
          ? metaDoc.data!.changeId
          : await this.initialChangeId(metaCollectionPath, model.storeName, opts);
        const changeId = currentChangeId + 1;
        model.changeId = changeId;
        model.recordChangeTimestamp = new Date();
        // Need merge = true if we want to allow migrations since it uses the uid property
        transaction.set(documentPath, model.raw(), { merge: true });
        if (metaDoc.exists) {
          transaction.update(metaDocumentPath, { changeId });
        } else {
          transaction.set(metaDocumentPath, { collection: model.storeName, changeId });
        }
      })
      .catch((err) => {
        console.error('[updatePublicStoreRecord]', documentPath, err);
        throw err;
      });

    return model;
  }

  // Meta docs written by earlier versions have random ids and are found by their `collection` field.
  // When one exists, the deterministic doc continues from the highest of them instead of the seed.
  // The query is not part of the transaction's read set; the transactional read of the absent
  // deterministic doc is what makes concurrent creators conflict.
  private async initialChangeId(metaCollectionPath: string, collectionName: string, opts: WriteOptions) {
    const legacyMetaDocs = await this.port.queryMeta(metaCollectionPath, collectionName);
    if (legacyMetaDocs.length > 0) {
      return Math.max(...legacyMetaDocs.map((legacyMetaDoc) => legacyMetaDoc.data!.changeId));
    }
    return opts.seedChangeId ? opts.seedChangeId() : 0;
  }
}
