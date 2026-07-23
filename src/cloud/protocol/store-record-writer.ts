import { DocSnap, FirestorePort, VersionedRecord } from './firestore-port';
import { PathBuilder } from './path-builder';

export interface WriteOptions {
  // Seed value for a collection's Meta doc the first time it is created (before any changeId has
  // been allocated in the cloud). On the client this comes from the local store's max changeId so a
  // collection migrating to the cloud doesn't restart at 0; on the server it is simply 0 (the Meta
  // doc is only absent when no client has ever synced the collection, so there is nothing to clobber).
  seedChangeId?: () => Promise<number>;
}

// The versioned write protocol, extracted verbatim (behavior-preserving) from
// CloudFirebaseFirestore.updateStoreRecord + updatePublicStoreRecord. Given a FirestorePort binding
// it is SDK-agnostic: the same code runs on the web SDK (client) and the Admin SDK (Cloud Function).
//
// Invariant kept identical to the original so existing synced clients are unaffected: same paths,
// same body (toBody()/raw()), same changeId math (Meta.changeId + 1 per write, in a transaction),
// same duplicate-Meta reconciliation, same 'User' handling.
export class StoreRecordWriter {
  constructor(private port: FirestorePort, private paths: PathBuilder) {}

  async writeRecord(rec: VersionedRecord, opts: WriteOptions = {}): Promise<VersionedRecord> {
    return rec.storeName === 'User' ? this.writeUser(rec) : this.writeVersioned(rec, opts);
  }

  private async writeVersioned(rec: VersionedRecord, opts: WriteOptions): Promise<VersionedRecord> {
    const metaCollectionPath = this.paths.metaCollectionPath(rec);
    const collectionPath = this.paths.collectionPath(rec);

    const metas = await this.port.queryMeta(metaCollectionPath, rec.storeName);

    let metaPath: string;
    if (metas.length === 0) {
      const seed = opts.seedChangeId ? await opts.seedChangeId() : 0;
      metaPath = this.port.newDocPath(metaCollectionPath);
      await this.port.setDoc(metaPath, { collection: rec.storeName, changeId: seed });
    } else {
      metaPath = await this.reconcileDuplicateMeta(metas);
    }

    return this.port.runTransaction(async (txn) => {
      const meta = await txn.get(metaPath);
      if (!meta.exists) {
        throw new Error('Document does not exist!');
      }
      const changeId = (meta.data!.changeId as number) + 1;
      rec.changeId = changeId;
      rec.recordChangeTimestamp = new Date();
      txn.set(`${collectionPath}/${rec.id}`, rec.toBody(), { merge: true });
      txn.update(metaPath, { changeId });
      return rec;
    });
  }

  // Historically more than one Meta doc could exist for a collection; keep the one with the highest
  // changeId and delete the rest (matches the original inline reconciliation).
  private async reconcileDuplicateMeta(metas: DocSnap[]): Promise<string> {
    let kept = metas[0];
    for (const other of metas.slice(1)) {
      if ((kept.data?.changeId ?? 0) < (other.data?.changeId ?? 0)) {
        await this.port.deleteDoc(kept.path);
        kept = other;
      } else {
        await this.port.deleteDoc(other.path);
      }
    }
    return kept.path;
  }

  // The 'User' record is keyed by auth id and versions against its own document (no Meta doc).
  // Preserves the original: create without a changeId bump when absent, bump inside a transaction
  // when present, and (unlike versioned records) do not touch recordChangeTimestamp.
  private async writeUser(rec: VersionedRecord): Promise<VersionedRecord> {
    if (!rec.authId) {
      return rec;
    }
    const userPath = this.paths.userPath(rec.authId);
    const existing = await this.port.getDoc(userPath);
    if (!existing.exists) {
      await this.port.setDoc(userPath, rec.toBody());
      return rec;
    }
    return this.port.runTransaction(async (txn) => {
      const snap = await txn.get(userPath);
      if (!snap.exists) {
        throw new Error('Document does not exist!');
      }
      rec.changeId = (snap.data!.changeId as number) + 1;
      txn.set(userPath, rec.toBody(), { merge: true });
      return rec;
    });
  }
}
