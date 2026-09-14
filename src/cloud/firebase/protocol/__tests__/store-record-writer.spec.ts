import { FakeFirestorePort } from './fake-firestore-port';
import { PathBuilder } from '../path-builder';
import { StoreRecordWriter } from '../store-record-writer';
import { VersionedRecord } from '../firestore-port';

const AUTH = 'uid-1';

function writer(port: FakeFirestorePort) {
  return new StoreRecordWriter(port, new PathBuilder(() => AUTH));
}

// Minimal VersionedRecord mimicking StoreRecord.raw(): body carries the persistable fields plus the
// live changeId/recordChangeTimestamp, and never the `id`.
function record(init: {
  storeName: string;
  id: string;
  isPrivate?: boolean;
  authId?: string;
  fields?: Record<string, any>;
}): VersionedRecord {
  return {
    storeName: init.storeName,
    id: init.id,
    isPrivate: init.isPrivate ?? true,
    authId: init.authId,
    changeId: 0,
    recordChangeTimestamp: new Date(0),
    raw() {
      return {
        ...(init.fields ?? {}),
        isPrivate: this.isPrivate,
        changeId: this.changeId,
        recordChangeTimestamp: this.recordChangeTimestamp,
      };
    },
  };
}

describe('StoreRecordWriter — versioned records', () => {
  it('creates the Meta doc at the seed and writes the first record at seed+1', async () => {
    const port = new FakeFirestorePort();
    const rec = record({ storeName: 'MedicineLog', id: 'e1', fields: { quantity: 1 } });

    await writer(port).updateStoreRecord(rec, { seedChangeId: async () => 5 });

    expect(rec.changeId).toBe(6);
    const doc = port.get(`User/${AUTH}/MedicineLog/e1`);
    expect(doc).toMatchObject({ quantity: 1, changeId: 6 });
    expect(doc).not.toHaveProperty('id');

    expect(port.get(`User/${AUTH}/Meta/MedicineLog`)).toEqual({ collection: 'MedicineLog', changeId: 6 });
  });

  it('seeds changeId at 0 when no seed is supplied', async () => {
    const port = new FakeFirestorePort();
    const rec = record({ storeName: 'MedicineLog', id: 'e1' });

    await writer(port).updateStoreRecord(rec);

    expect(rec.changeId).toBe(1);
    expect(port.get(`User/${AUTH}/MedicineLog/e1`)!.changeId).toBe(1);
  });

  it('increments changeId on each subsequent write', async () => {
    const port = new FakeFirestorePort();
    const w = writer(port);

    await w.updateStoreRecord(record({ storeName: 'MedicineLog', id: 'e1' }));
    const second = record({ storeName: 'MedicineLog', id: 'e2' });
    await w.updateStoreRecord(second);

    expect(second.changeId).toBe(2);
    const metas = await port.queryMeta(`User/${AUTH}/Meta`, 'MedicineLog');
    expect(metas[0].data!.changeId).toBe(2);
  });

  it('converges two writes with the same id onto one document (eventId idempotency)', async () => {
    const port = new FakeFirestorePort();
    const w = writer(port);
    const path = `User/${AUTH}/MedicineLog/same-event`;

    await w.updateStoreRecord(record({ storeName: 'MedicineLog', id: 'same-event', fields: { quantity: 1 } }));
    await w.updateStoreRecord(record({ storeName: 'MedicineLog', id: 'same-event', fields: { quantity: 2 } }));

    const logDocs = port.paths().filter((p) => p.startsWith(`User/${AUTH}/MedicineLog/`));
    expect(logDocs).toEqual([path]);
    expect(port.get(path)!.quantity).toBe(2);
    expect(port.get(path)!.changeId).toBe(2);
  });

  it('continues from the highest legacy random-id Meta doc when the deterministic one is absent', async () => {
    const port = new FakeFirestorePort();
    await port.setDoc(`User/${AUTH}/Meta/low`, { collection: 'MedicineLog', changeId: 3 });
    await port.setDoc(`User/${AUTH}/Meta/high`, { collection: 'MedicineLog', changeId: 7 });

    const rec = record({ storeName: 'MedicineLog', id: 'e1' });
    await writer(port).updateStoreRecord(rec, { seedChangeId: async () => 1 });

    expect(rec.changeId).toBe(8);
    expect(port.get(`User/${AUTH}/Meta/MedicineLog`)).toEqual({ collection: 'MedicineLog', changeId: 8 });
  });

  it('allocates distinct changeIds when two writers create the first Meta doc concurrently', async () => {
    const port = new FakeFirestorePort();
    let releaseSeeds!: () => void;
    const seedsReleased = new Promise<void>((resolve) => (releaseSeeds = resolve));
    const seedChangeId = async () => {
      await seedsReleased;
      return 5;
    };
    const first = record({ storeName: 'MedicineLog', id: 'e1' });
    const second = record({ storeName: 'MedicineLog', id: 'e2' });

    const writes = Promise.all([
      writer(port).updateStoreRecord(first, { seedChangeId }),
      writer(port).updateStoreRecord(second, { seedChangeId }),
    ]);
    releaseSeeds();
    await writes;

    expect([first.changeId, second.changeId].sort()).toEqual([6, 7]);
    expect(port.get(`User/${AUTH}/Meta/MedicineLog`)!.changeId).toBe(7);
    expect(port.paths().filter((path) => path.startsWith(`User/${AUTH}/Meta/`))).toEqual([
      `User/${AUTH}/Meta/MedicineLog`,
    ]);
  });

  it('does not overwrite a newer cloud copy with an older upload', async () => {
    const port = new FakeFirestorePort();
    const w = writer(port);
    await w.updateStoreRecord(record({ storeName: 'MedicineLog', id: 'e1', fields: { quantity: 2, updatedMs: 2000 } }));

    const older = record({ storeName: 'MedicineLog', id: 'e1', fields: { quantity: 1, updatedMs: 1000 } });
    const result = await w.updateStoreRecord(older);

    expect(result.newerCloudCopy).toMatchObject({ quantity: 2, updatedMs: 2000, changeId: 1 });
    expect(older.changeId).toBe(0);
    expect(port.get(`User/${AUTH}/MedicineLog/e1`)).toMatchObject({ quantity: 2, updatedMs: 2000, changeId: 1 });
    expect(port.get(`User/${AUTH}/Meta/MedicineLog`)!.changeId).toBe(1);
  });

  it('does not overwrite a client-written record with one that carries no updatedMs', async () => {
    const port = new FakeFirestorePort();
    const w = writer(port);
    await w.updateStoreRecord(record({ storeName: 'MedicineLog', id: 'e1', fields: { quantity: 2, updatedMs: 2000 } }));

    await w.updateStoreRecord(record({ storeName: 'MedicineLog', id: 'e1', fields: { quantity: 1 } }));

    expect(port.get(`User/${AUTH}/MedicineLog/e1`)).toMatchObject({ quantity: 2, changeId: 1 });
  });

  it('keeps the local changeId when a retried transaction finds a newer cloud copy', async () => {
    const port = new FakeFirestorePort();
    const older = record({ storeName: 'MedicineLog', id: 'e1', fields: { quantity: 1, updatedMs: 1000 } });
    older.changeId = 3;
    const w = writer(port);
    let releaseSeed!: () => void;
    const seedReleased = new Promise<void>((resolve) => (releaseSeed = resolve));

    const upload = w.updateStoreRecord(older, {
      seedChangeId: async () => {
        await seedReleased;
        return 0;
      },
    });
    // The first attempt reads both documents absent and waits on the seed; this write lands before it commits.
    await Promise.resolve();
    await port.setDoc(`User/${AUTH}/MedicineLog/e1`, { quantity: 2, updatedMs: 2000, changeId: 9 });
    releaseSeed();
    await upload;

    expect(older.changeId).toBe(3);
    expect(port.get(`User/${AUTH}/MedicineLog/e1`)).toMatchObject({ quantity: 2, changeId: 9 });
  });

  it('overwrites a cloud copy that is not newer', async () => {
    const port = new FakeFirestorePort();
    const w = writer(port);
    await w.updateStoreRecord(record({ storeName: 'MedicineLog', id: 'e1', fields: { quantity: 1, updatedMs: 1000 } }));

    const newer = record({ storeName: 'MedicineLog', id: 'e1', fields: { quantity: 2, updatedMs: 2000 } });
    const result = await w.updateStoreRecord(newer);

    expect(result.newerCloudCopy).toBeUndefined();
    expect(newer.changeId).toBe(2);
    expect(port.get(`User/${AUTH}/MedicineLog/e1`)).toMatchObject({ quantity: 2, changeId: 2 });
  });

  it('writes public records at the top-level collection and Meta path', async () => {
    const port = new FakeFirestorePort();
    const rec = record({ storeName: 'Announcement', id: 'a1', isPrivate: false });

    await writer(port).updateStoreRecord(rec);

    expect(port.get('Announcement/a1')!.changeId).toBe(1);
    expect(port.get('Meta/Announcement')).toEqual({ collection: 'Announcement', changeId: 1 });
  });
});

describe('StoreRecordWriter — User record', () => {
  it('creates a missing user document without bumping changeId', async () => {
    const port = new FakeFirestorePort();
    const rec = record({ storeName: 'User', id: 'ignored', authId: AUTH, fields: { displayName: 'Ada' } });

    await writer(port).updateStoreRecord(rec);

    expect(rec.changeId).toBe(0);
    expect(port.get(`User/${AUTH}`)).toMatchObject({ displayName: 'Ada' });
  });

  it('bumps changeId against the existing user document', async () => {
    const port = new FakeFirestorePort();
    await port.setDoc(`User/${AUTH}`, { displayName: 'Ada', changeId: 4 });
    const rec = record({ storeName: 'User', id: 'ignored', authId: AUTH, fields: { displayName: 'Ada B.' } });

    await writer(port).updateStoreRecord(rec);

    expect(rec.changeId).toBe(5);
    expect(port.get(`User/${AUTH}`)).toMatchObject({ displayName: 'Ada B.', changeId: 5 });
  });
});
