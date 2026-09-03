import { DocSnap, FirestorePort, WriteTxn } from '../firestore-port';

// In-memory FirestorePort for unit-testing the write protocol without a Firebase emulator.
// Documents are a flat Map keyed by full path. runTransaction just runs the callback (tests are
// single-threaded, so there is no contention to model); reads see the current map state.
export class FakeFirestorePort implements FirestorePort {
  readonly docs = new Map<string, Record<string, any>>();
  private seq = 0;

  private snap(path: string): DocSnap {
    const data = this.docs.get(path);
    return { exists: data !== undefined, data: data ? { ...data } : undefined, path };
  }

  async getDoc(path: string): Promise<DocSnap> {
    return this.snap(path);
  }

  async setDoc(path: string, data: Record<string, any>, opts?: { merge?: boolean }): Promise<void> {
    const prev = opts?.merge ? this.docs.get(path) ?? {} : {};
    this.docs.set(path, { ...prev, ...data });
  }

  async deleteDoc(path: string): Promise<void> {
    this.docs.delete(path);
  }

  async queryMeta(metaCollectionPath: string, collectionName: string): Promise<DocSnap[]> {
    const prefix = `${metaCollectionPath}/`;
    const out: DocSnap[] = [];
    for (const [path, data] of this.docs) {
      const isDirectChild = path.startsWith(prefix) && !path.slice(prefix.length).includes('/');
      if (isDirectChild && data.collection === collectionName) {
        out.push(this.snap(path));
      }
    }
    return out;
  }

  newDocPath(collectionPath: string): string {
    return `${collectionPath}/auto-${++this.seq}`;
  }

  async runTransaction<T>(fn: (txn: WriteTxn) => Promise<T>): Promise<T> {
    const txn: WriteTxn = {
      get: (path) => this.getDoc(path),
      set: (path, data, opts) => {
        void this.setDoc(path, data, opts);
      },
      update: (path, patch) => {
        const prev = this.docs.get(path);
        if (prev === undefined) {
          throw new Error(`update on missing doc: ${path}`);
        }
        this.docs.set(path, { ...prev, ...patch });
      },
    };
    return fn(txn);
  }

  // Test helpers
  get(path: string): Record<string, any> | undefined {
    return this.docs.get(path);
  }

  paths(): string[] {
    return [...this.docs.keys()].sort();
  }
}
