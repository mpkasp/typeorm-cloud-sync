import { DocSnap, FirestorePort, WriteTxn } from '../firestore-port';

const MAX_TRANSACTION_ATTEMPTS = 5;

// In-memory FirestorePort for unit-testing the write protocol without a Firebase emulator.
// Documents are a flat Map keyed by full path. runTransaction models Firestore's optimistic
// concurrency: writes are buffered until the callback resolves, and the commit is rejected and the
// callback retried when any document it read has been written since.
export class FakeFirestorePort implements FirestorePort {
  readonly docs = new Map<string, Record<string, any>>();
  private readonly versions = new Map<string, number>();

  private snap(path: string): DocSnap {
    const data = this.docs.get(path);
    return { exists: data !== undefined, data: data ? { ...data } : undefined, path };
  }

  private write(path: string, data: Record<string, any> | undefined) {
    if (data === undefined) {
      this.docs.delete(path);
    } else {
      this.docs.set(path, data);
    }
    this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
  }

  async getDoc(path: string): Promise<DocSnap> {
    return this.snap(path);
  }

  async setDoc(path: string, data: Record<string, any>, opts?: { merge?: boolean }): Promise<void> {
    const previous = opts?.merge ? (this.docs.get(path) ?? {}) : {};
    this.write(path, { ...previous, ...data });
  }

  async deleteDoc(path: string): Promise<void> {
    this.write(path, undefined);
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

  async runTransaction<T>(fn: (txn: WriteTxn) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const readVersions = new Map<string, number>();
      const writes: (() => void)[] = [];
      const txn: WriteTxn = {
        get: async (path) => {
          readVersions.set(path, this.versions.get(path) ?? 0);
          return this.snap(path);
        },
        set: (path, data, opts) => {
          writes.push(() => void this.setDoc(path, data, opts));
        },
        update: (path, patch) => {
          writes.push(() => {
            const previous = this.docs.get(path);
            if (previous === undefined) {
              throw new Error(`update on missing doc: ${path}`);
            }
            this.write(path, { ...previous, ...patch });
          });
        },
      };
      const result = await fn(txn);
      const conflicted = [...readVersions].some(([path, version]) => (this.versions.get(path) ?? 0) !== version);
      if (!conflicted) {
        writes.forEach((applyWrite) => applyWrite());
        return result;
      }
      if (attempt === MAX_TRANSACTION_ATTEMPTS) {
        throw new Error('transaction contention: too many attempts');
      }
    }
  }

  // Test helpers
  get(path: string): Record<string, any> | undefined {
    return this.docs.get(path);
  }

  paths(): string[] {
    return [...this.docs.keys()].sort();
  }
}
