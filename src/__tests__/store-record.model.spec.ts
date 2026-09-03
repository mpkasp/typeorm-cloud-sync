import { DataSource } from 'typeorm/browser';
import { BaseUser, StoreChangeLog } from '../index';
import { StoreRecord } from '../models/store-record.model';
import { changeLogs, createTestDataSource, Note, silenceLibraryLogs, Tag } from './fake-entities';

// Characterization tests for the model layer: what save() / updateChangeLog() / the change-log
// round-trip do today, pinned before the multi-tenant refactor moves them off ActiveRecord.

let dataSource: DataSource;

beforeEach(async () => {
  silenceLibraryLogs();
  dataSource = await createTestDataSource([BaseUser, Note, Tag, StoreChangeLog]);
});

afterEach(async () => {
  await dataSource.destroy();
});

describe('StoreRecord.save', () => {
  test('writes a change-log row keyed by storeName and record id', async () => {
    const note = await new Note({ text: 'hello' }).save();

    const changes = await changeLogs(dataSource).find();
    expect(changes).toHaveLength(1);
    expect(changes[0].tableName).toBe('Note');
    expect(changes[0].recordId).toBe(note.id);
  });

  test('keeps only one change-log row per record across repeated saves', async () => {
    const note = await new Note({ text: 'first' }).save();
    note.text = 'second';
    await note.save();

    await expect(changeLogs(dataSource).count()).resolves.toBe(1);
  });

  test('skips the change log when updateChangeLog is false', async () => {
    await new Note({ text: 'from cloud' }).save({}, false);

    await expect(changeLogs(dataSource).count()).resolves.toBe(0);
  });

  test('logs a change for a soft-deleted record so the tombstone syncs', async () => {
    const note = await new Note({ text: 'gone' }).save({}, false);
    note.isDeleted = true;
    await note.save();

    const changes = await changeLogs(dataSource).find();
    expect(changes).toHaveLength(1);
    expect(changes[0].recordId).toBe(note.id);
  });

  test('stamps created on insert and leaves it untouched on update', async () => {
    const note = await new Note({ text: 'timestamps' }).save();
    const created = note.created!.getTime();
    expect(note.updated!.getTime()).toBe(created);

    note.text = 'changed';
    await note.save();

    expect(note.created!.getTime()).toBe(created);
    expect(note.updated!.getTime()).toBeGreaterThanOrEqual(created);
  });

  test('the static bulk save logs a change per entity', async () => {
    await Note.save([new Note({ text: 'a' }), new Note({ text: 'b' })] as any);

    await expect(changeLogs(dataSource).count()).resolves.toBe(2);
  });
});

describe('StoreRecord.updateChangeLog', () => {
  test('is idempotent and returns the existing row', async () => {
    const note = await new Note({ text: 'x' }).save({}, false);

    const first = await note.updateChangeLog();
    const second = await note.updateChangeLog();

    expect(second.id).toBe(first.id);
    await expect(changeLogs(dataSource).count()).resolves.toBe(1);
  });

  test('separates records that share an id across stores', async () => {
    const note = await new Note({ text: 'x' }).save({}, false);
    const tag = await new Tag({ id: note.id, label: 'y' }).save({}, false);

    await note.updateChangeLog();
    await tag.updateChangeLog();

    const tableNames = (await changeLogs(dataSource).find()).map((c) => c.tableName).sort();
    expect(tableNames).toEqual(['Note', 'Tag']);
  });
});

describe('StoreRecord.getLatestChangeId', () => {
  const latestChangeId = (isPrivate: boolean) =>
    StoreRecord.getLatestChangeId(dataSource, { type: Note as any, name: 'Note' }, 'Note', isPrivate);

  test('is 0 for an empty store', async () => {
    await expect(latestChangeId(true)).resolves.toBe(0);
  });

  test('returns the highest changeId of the matching privacy', async () => {
    await new Note({ text: 'a', changeId: 3 }).save({}, false);
    await new Note({ text: 'b', changeId: 7 }).save({}, false);
    await new Note({ text: 'public', changeId: 11, isPrivate: false }).save({}, false);

    await expect(latestChangeId(true)).resolves.toBe(7);
    await expect(latestChangeId(false)).resolves.toBe(11);
  });

  test('counts soft-deleted records', async () => {
    await new Note({ text: 'a', changeId: 3 }).save({}, false);
    await new Note({ text: 'tombstone', changeId: 9, isDeleted: true }).save({}, false);

    await expect(latestChangeId(true)).resolves.toBe(9);
  });
});

describe('StoreChangeLog round-trip', () => {
  test('getFromRecord finds the row a save created', async () => {
    const note = await new Note({ text: 'x' }).save();

    const changes = await StoreChangeLog.getFromRecord(note);
    expect(changes).toHaveLength(1);
    expect(changes[0].tableName).toBe('Note');
  });

  test('getRecord resolves the entity class from the stored storeName', async () => {
    const note = await new Note({ text: 'round trip' }).save();
    const [change] = await StoreChangeLog.getFromRecord(note);

    const record = (await change.getRecord(dataSource)) as Note;
    expect(record).toBeInstanceOf(Note);
    expect(record.id).toBe(note.id);
    expect(record.text).toBe('round trip');
  });

  test('getRecordWithManager resolves the same record through an EntityManager', async () => {
    const note = await new Note({ text: 'via manager' }).save();
    const [change] = await StoreChangeLog.getFromRecord(note);

    const record = (await change.getRecordWithManager(dataSource.manager)) as Note;
    expect(record.id).toBe(note.id);
  });

  test('getRecord returns null for a storeName no entity claims', async () => {
    const orphan = await new StoreChangeLog('Unregistered', 'some-id').save();

    await expect(orphan.getRecord(dataSource)).resolves.toBeNull();
  });

  test('getRecord returns null once the record is hard-deleted', async () => {
    const note = await new Note({ text: 'x' }).save();
    const [change] = await StoreChangeLog.getFromRecord(note);
    await note.remove();

    await expect(change.getRecord(dataSource)).resolves.toBeNull();
  });
});
