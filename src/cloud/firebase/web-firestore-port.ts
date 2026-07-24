import {
  collection,
  deleteDoc,
  doc,
  Firestore,
  getDoc,
  getDocs,
  query,
  runTransaction,
  setDoc,
  where,
} from 'firebase/firestore';
import { DocSnap, FirestorePort, WriteTxn } from '../protocol/firestore-port';

// FirestorePort bound to the modular web SDK (`firebase/firestore`). The client's
// CloudFirebaseFirestore delegates all versioned writes through StoreRecordWriter over this port;
// a Cloud Function supplies an equivalent Admin-SDK port. Only string paths and plain data cross
// the interface, so this file holds no protocol logic — just SDK glue.
export class WebFirestorePort implements FirestorePort {
  constructor(private db: Firestore) {}

  async getDoc(path: string): Promise<DocSnap> {
    const snap = await getDoc(doc(this.db, path));
    return { exists: snap.exists(), data: snap.data(), path };
  }

  async setDoc(path: string, data: Record<string, any>, opts?: { merge?: boolean }): Promise<void> {
    await setDoc(doc(this.db, path), data, opts ?? {});
  }

  async deleteDoc(path: string): Promise<void> {
    await deleteDoc(doc(this.db, path));
  }

  async queryMeta(metaCollectionPath: string, collectionName: string): Promise<DocSnap[]> {
    const snap = await getDocs(
      query(collection(this.db, metaCollectionPath), where('collection', '==', collectionName)),
    );
    return snap.docs.map((d) => ({ exists: true, data: d.data(), path: d.ref.path }));
  }

  newDocPath(collectionPath: string): string {
    return doc(collection(this.db, collectionPath)).path;
  }

  runTransaction<T>(fn: (txn: WriteTxn) => Promise<T>): Promise<T> {
    return runTransaction(this.db, (t) => {
      const txn: WriteTxn = {
        get: async (path) => {
          const snap = await t.get(doc(this.db, path));
          return { exists: snap.exists(), data: snap.data(), path };
        },
        set: (path, data, opts) => {
          t.set(doc(this.db, path), data, opts ?? {});
        },
        update: (path, patch) => {
          t.update(doc(this.db, path), patch);
        },
      };
      return fn(txn);
    });
  }
}
