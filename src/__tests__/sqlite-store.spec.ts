import { DataSource } from 'typeorm/browser';
import { BaseUser, SqliteStore, StoreChangeLog } from '../index';
import { StoreRecord } from '../models/store-record.model';
import { changeLogs, createTestDataSource, Note, silenceLibraryLogs } from './fake-entities';

// Characterization tests for SqliteStore.resolve(), the local half of a cloud round-trip. The
// branch is chosen purely on `updated` (updatedMs), so tests set it explicitly instead of racing
// the clock.

let dataSource: DataSource;
let sqliteStore: SqliteStore;

const setUpdated = (record: StoreRecord, ms: number) => Object.assign(record, { updatedMs: ms });

// A record as it arrives from the cloud: never persisted locally, carrying the cloud's id.
const cloudNote = (init: Partial<any>) => Object.assign(new Note(init), { updatedMs: init.updatedMs });

beforeEach(async () => {
  silenceLibraryLogs();
  dataSource = await createTestDataSource([BaseUser, Note, StoreChangeLog]);
  sqliteStore = new SqliteStore(dataSource, BaseUser);
});

afterEach(async () => {
  await dataSource.destroy();
});

describe('resolve with no local record', () => {
  test('inserts the cloud record without logging a local change', async () => {
    const incoming = cloudNote({ id: 'cloud-1', text: 'from cloud', changeId: 4, updatedMs: 1000 });

    const resolved = (await sqliteStore.resolve(incoming)) as Note;

    expect(resolved.id).toBe('cloud-1');
    const stored = await dataSource.getRepository(Note).findOneBy({ id: 'cloud-1' });
    expect(stored!.text).toBe('from cloud');
    expect(stored!.changeId).toBe(4);
    await expect(changeLogs(dataSource).count()).resolves.toBe(0);
  });

  test('returns null instead of throwing when the insert fails', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(sqliteStore, 'saveRecord').mockRejectedValue(new Error('db is gone'));

    await expect(sqliteStore.resolve(cloudNote({ id: 'cloud-1' }))).resolves.toBeNull();
  });
});

describe('resolve when the cloud record is newer', () => {
  test('overwrites the local record and drops its pending change', async () => {
    const local = await new Note({ text: 'local edit' }).save();
    setUpdated(local, 1000);
    await expect(changeLogs(dataSource).count()).resolves.toBe(1);

    const incoming = cloudNote({ id: local.id, text: 'cloud edit', changeId: 9, updatedMs: 2000 });
    const resolved = (await sqliteStore.resolve(incoming, local)) as Note;

    expect(resolved.text).toBe('cloud edit');
    const stored = await dataSource.getRepository(Note).findOneBy({ id: local.id });
    expect(stored!.text).toBe('cloud edit');
    expect(stored!.changeId).toBe(9);
    await expect(changeLogs(dataSource).count()).resolves.toBe(0);
  });

  test('ignores a differing cloud record that shares the local timestamp', async () => {
    const local = await new Note({ text: 'local edit' }).save({}, false);
    setUpdated(local, 1000);
    const incoming = cloudNote({ id: local.id, text: 'cloud edit', changeId: 9, updatedMs: 1000 });

    // Equal times short-circuit to the no-op branch before the cloud/local comparison is reached,
    // so a cloud edit landing in the same millisecond is dropped.
    await expect(sqliteStore.resolve(incoming, local)).resolves.toBeNull();
    const stored = await dataSource.getRepository(Note).findOneBy({ id: local.id });
    expect(stored!.text).toBe('local edit');
  });
});

describe('resolve when the local record is newer', () => {
  test('keeps the local record and re-queues it for upload', async () => {
    const local = await new Note({ text: 'local edit' }).save({}, false);
    setUpdated(local, 2000);
    const incoming = cloudNote({ id: local.id, text: 'stale cloud edit', changeId: 9, updatedMs: 1000 });

    const resolved = (await sqliteStore.resolve(incoming, local)) as Note;

    expect(resolved.text).toBe('local edit');
    const stored = await dataSource.getRepository(Note).findOneBy({ id: local.id });
    expect(stored!.text).toBe('local edit');
    const changes = await changeLogs(dataSource).find();
    expect(changes).toHaveLength(1);
    expect(changes[0].recordId).toBe(local.id);
  });
});

describe('resolve when the records match', () => {
  test('is a no-op', async () => {
    const local = await new Note({ text: 'same' }).save({}, false);
    setUpdated(local, 1000);
    const incoming = cloudNote({ id: local.id, text: 'same', changeId: 1, updatedMs: 1000 });

    await expect(sqliteStore.resolve(incoming, local)).resolves.toBeNull();
    await expect(changeLogs(dataSource).count()).resolves.toBe(0);
  });
});

describe('dropping records', () => {
  test('dropPrivateTypeOrmCloudSyncRecords clears the change log only', async () => {
    const note = await new Note({ text: 'keep me' }).save();

    await sqliteStore.dropPrivateTypeOrmCloudSyncRecords();

    await expect(changeLogs(dataSource).count()).resolves.toBe(0);
    await expect(dataSource.getRepository(Note).findOneBy({ id: note.id })).resolves.not.toBeNull();
  });

  test('dropPrivateRecords deletes private rows and keeps public ones', async () => {
    await new Note({ text: 'private' }).save({}, false);
    await new Note({ text: 'public', isPrivate: false }).save({}, false);

    await sqliteStore.dropPrivateRecords(Note as any);

    const remaining = await dataSource.getRepository(Note).find();
    expect(remaining.map((n) => n.text)).toEqual(['public']);
  });
});
