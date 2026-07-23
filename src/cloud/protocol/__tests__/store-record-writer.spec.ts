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
    toBody() {
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

    await writer(port).writeRecord(rec, { seedChangeId: async () => 5 });

    expect(rec.changeId).toBe(6);
    const doc = port.get(`User/${AUTH}/MedicineLog/e1`);
    expect(doc).toMatchObject({ quantity: 1, changeId: 6 });
    expect(doc).not.toHaveProperty('id');

    const metas = await port.queryMeta(`User/${AUTH}/Meta`, 'MedicineLog');
    expect(metas).toHaveLength(1);
    expect(metas[0].data!.changeId).toBe(6);
  });

  it('seeds changeId at 0 when no seed is supplied', async () => {
    const port = new FakeFirestorePort();
    const rec = record({ storeName: 'MedicineLog', id: 'e1' });

    await writer(port).writeRecord(rec);

    expect(rec.changeId).toBe(1);
    expect(port.get(`User/${AUTH}/MedicineLog/e1`)!.changeId).toBe(1);
  });

  it('increments changeId on each subsequent write', async () => {
    const port = new FakeFirestorePort();
    const w = writer(port);

    await w.writeRecord(record({ storeName: 'MedicineLog', id: 'e1' }));
    const second = record({ storeName: 'MedicineLog', id: 'e2' });
    await w.writeRecord(second);

    expect(second.changeId).toBe(2);
    const metas = await port.queryMeta(`User/${AUTH}/Meta`, 'MedicineLog');
    expect(metas[0].data!.changeId).toBe(2);
  });

  it('converges two writes with the same id onto one document (eventId idempotency)', async () => {
    const port = new FakeFirestorePort();
    const w = writer(port);
    const path = `User/${AUTH}/MedicineLog/same-event`;

    await w.writeRecord(record({ storeName: 'MedicineLog', id: 'same-event', fields: { quantity: 1 } }));
    await w.writeRecord(record({ storeName: 'MedicineLog', id: 'same-event', fields: { quantity: 2 } }));

    const logDocs = port.paths().filter((p) => p.startsWith(`User/${AUTH}/MedicineLog/`));
    expect(logDocs).toEqual([path]);
    expect(port.get(path)!.quantity).toBe(2);
    expect(port.get(path)!.changeId).toBe(2);
  });

  it('reconciles duplicate Meta docs by keeping the highest changeId', async () => {
    const port = new FakeFirestorePort();
    await port.setDoc(`User/${AUTH}/Meta/low`, { collection: 'MedicineLog', changeId: 3 });
    await port.setDoc(`User/${AUTH}/Meta/high`, { collection: 'MedicineLog', changeId: 7 });

    const rec = record({ storeName: 'MedicineLog', id: 'e1' });
    await writer(port).writeRecord(rec);

    expect(port.get(`User/${AUTH}/Meta/low`)).toBeUndefined();
    expect(port.get(`User/${AUTH}/Meta/high`)!.changeId).toBe(8);
    expect(rec.changeId).toBe(8);
  });

  it('writes public records at the top-level collection and Meta path', async () => {
    const port = new FakeFirestorePort();
    const rec = record({ storeName: 'Announcement', id: 'a1', isPrivate: false });

    await writer(port).writeRecord(rec);

    expect(port.get('Announcement/a1')!.changeId).toBe(1);
    const metas = await port.queryMeta('Meta', 'Announcement');
    expect(metas).toHaveLength(1);
  });
});

describe('StoreRecordWriter — User record', () => {
  it('creates a missing user document without bumping changeId', async () => {
    const port = new FakeFirestorePort();
    const rec = record({ storeName: 'User', id: 'ignored', authId: AUTH, fields: { displayName: 'Ada' } });

    await writer(port).writeRecord(rec);

    expect(rec.changeId).toBe(0);
    expect(port.get(`User/${AUTH}`)).toMatchObject({ displayName: 'Ada' });
  });

  it('bumps changeId against the existing user document', async () => {
    const port = new FakeFirestorePort();
    await port.setDoc(`User/${AUTH}`, { displayName: 'Ada', changeId: 4 });
    const rec = record({ storeName: 'User', id: 'ignored', authId: AUTH, fields: { displayName: 'Ada B.' } });

    await writer(port).writeRecord(rec);

    expect(rec.changeId).toBe(5);
    expect(port.get(`User/${AUTH}`)).toMatchObject({ displayName: 'Ada B.', changeId: 5 });
  });
});
