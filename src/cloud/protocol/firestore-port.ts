// The SDK-agnostic seam between the sync write protocol and a concrete Firestore SDK.
//
// The protocol (StoreRecordWriter) speaks only in string document paths and plain data objects.
// Each SDK supplies a binding: the client app implements FirestorePort with the modular web SDK
// (`firebase/firestore`), a Cloud Function implements it with the Admin SDK (`firebase-admin`).
// Nothing in this file imports firebase or typeorm, so both bindings share one copy of the
// protocol and it cannot drift between them.

export interface DocSnap {
  exists: boolean;
  data?: Record<string, any>;
  // Full path of the document this snapshot came from. Needed so the caller can act on a doc it
  // discovered via a query (e.g. delete a duplicate Meta doc) without holding an SDK ref.
  path: string;
}

// The transaction handle passed to FirestorePort.runTransaction's callback. Mirrors the subset of
// Firestore transaction semantics the protocol uses: all reads must precede all writes.
export interface WriteTxn {
  get(path: string): Promise<DocSnap>;
  set(path: string, data: Record<string, any>, opts?: { merge?: boolean }): void;
  update(path: string, patch: Record<string, any>): void;
}

export interface FirestorePort {
  getDoc(path: string): Promise<DocSnap>;
  setDoc(path: string, data: Record<string, any>, opts?: { merge?: boolean }): Promise<void>;
  deleteDoc(path: string): Promise<void>;
  // Return the Meta doc(s) under `metaCollectionPath` whose `collection` field === `collectionName`.
  queryMeta(metaCollectionPath: string, collectionName: string): Promise<DocSnap[]>;
  // Allocate a fresh (not-yet-written) document path within a collection, for a new Meta doc.
  newDocPath(collectionPath: string): string;
  runTransaction<T>(fn: (txn: WriteTxn) => Promise<T>): Promise<T>;
}

// The minimal view of a record the protocol needs to version and write. Deliberately NOT
// StoreRecord: the server has no access to the app's TypeORM entity classes, so the client adapts
// its entity into this shape and the Cloud Function builds it straight from an inbox document.
// `changeId` / `recordChangeTimestamp` are written back by the protocol before `raw()` is read.
export interface VersionedRecord {
  storeName: string; // stable storage name (already resolved via storeNameOf by the caller)
  id: string;
  isPrivate: boolean;
  // Only the 'User' record uses this — its document key is the auth id, not `id`.
  authId?: string;
  changeId: number;
  recordChangeTimestamp: Date;
  // The document body to persist — same contract as StoreRecord.raw() (strips id, drops undefined);
  // must reflect the current changeId / recordChangeTimestamp when called.
  raw(): Record<string, any>;
}
