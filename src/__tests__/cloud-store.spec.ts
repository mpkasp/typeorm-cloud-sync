import { BehaviorSubject } from 'rxjs';
import { DataSource } from 'typeorm/browser';
import { SqliteStore, StoreChangeLog } from '../index';
import { changeLogs, createTestDataSource, Note, silenceLibraryLogs, Tag, User } from './fake-entities';
import { FakeCloudStore } from './fake-cloud-store';

// First tests for CloudStore's orchestration. They run in bare Node, which is only possible because
// the network source is injected rather than read off `navigator`/`window`.

const AUTH_ID = 'auth-A';

let dataSource: DataSource;
let sqliteStore: SqliteStore;
let network: BehaviorSubject<boolean>;
let cloud: FakeCloudStore;

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

const changeLogCount = () => changeLogs(dataSource).count();
const seedUser = (init: Partial<any> = {}) => new User({ authId: AUTH_ID, ...init }).save({}, false);

beforeEach(async () => {
  silenceLibraryLogs();
  dataSource = await createTestDataSource([User, Note, Tag, StoreChangeLog]);
  sqliteStore = new SqliteStore(dataSource, User);
  network = new BehaviorSubject<boolean>(true);
  cloud = new FakeCloudStore(User, [Tag], [Note], network);
});

afterEach(async () => {
  await waitFor(async () => !(cloud as any).updatingCloudFromChangeLog);
  await dataSource.destroy();
});

describe('construction and network', () => {
  test('constructs outside a browser', () => {
    expect(typeof window).toBe('undefined');
    expect(cloud.network).toBe(true);
  });

  test('network follows the injected source once initialized', async () => {
    await seedUser();
    await cloud.initialize(sqliteStore);

    network.next(false);
    expect(cloud.network).toBe(false);

    network.next(true);
    expect(cloud.network).toBe(true);
  });
});

describe('_initializeBase', () => {
  test('publishes the newest undeleted user and subscribes both clouds', async () => {
    await new User({ authId: 'old', changeId: 1 }).save({}, false);
    await new User({ authId: AUTH_ID, changeId: 5 }).save({}, false);
    await new User({ authId: 'deleted', changeId: 9, isDeleted: true }).save({}, false);

    await cloud.initialize(sqliteStore);

    expect(cloud.user!.authId).toBe(AUTH_ID);
    expect(cloud.calls).toContain('subscribePublic:Tag');
    expect(cloud.calls).toContain('subscribePrivate:Note');
  });

  test('leaves the private cloud unsubscribed when there is no local user', async () => {
    await cloud.initialize(sqliteStore);

    expect(cloud.user).toBeNull();
    expect(cloud.calls).toEqual(['subscribePublic:Tag']);
  });

  test('uploads changes that were already pending before initialize', async () => {
    await seedUser();
    const note = await new Note({ text: 'queued offline' }).save();

    await cloud.initialize(sqliteStore);

    await waitFor(async () => (await changeLogCount()) === 0);
    expect(cloud.port.get(`User/${AUTH_ID}/Note/${note.id}`)).toBeDefined();
  });

  test('resetLocalUser tears down the private cloud', async () => {
    await seedUser();
    await cloud.initialize(sqliteStore);

    cloud.resetLocalUser();

    expect(cloud.user).toBeNull();
    expect(cloud.calls).toContain('unsubscribePrivateCloud');
  });
});

describe('updateCloudFromChangeLog guards', () => {
  beforeEach(async () => {
    await seedUser();
    await cloud.initialize(sqliteStore);
    await new Note({ text: 'pending' }).save();
    await waitFor(async () => !(cloud as any).updatingCloudFromChangeLog);
    cloud.port.docs.clear();
    cloud.calls.length = 0;
  });

  test('does nothing without network', async () => {
    await new Note({ text: 'offline edit' }).save();
    network.next(false);

    await cloud.updateCloudFromChangeLog();

    expect(cloud.calls).toEqual([]);
    expect(cloud.port.paths()).toEqual([]);
  });

  test('does nothing while downloading', async () => {
    await new Note({ text: 'mid download' }).save();
    (cloud as any).downloadingSubject.next(true);

    await cloud.updateCloudFromChangeLog();

    expect(cloud.calls).toEqual([]);
    expect(await changeLogCount()).toBeGreaterThan(0);
  });

  test('does nothing before the private cloud is initialized', async () => {
    await new Note({ text: 'too early' }).save();
    (cloud as any).privateCloudInitialized = false;

    await cloud.updateCloudFromChangeLog();

    expect(cloud.calls).toEqual([]);
    expect(await changeLogCount()).toBeGreaterThan(0);
  });

  test('coalesces a concurrent drain instead of running it twice', async () => {
    await cloud.updateCloudFromChangeLog();
    expect(await changeLogCount()).toBe(0);
    await new Note({ text: 'concurrent' }).save();
    cloud.calls.length = 0;

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const upload = cloud.updateStoreRecord.bind(cloud);
    const write = jest.spyOn(cloud, 'updateStoreRecord').mockImplementation(async (record) => {
      await gate;
      return upload(record);
    });

    const first = cloud.updateCloudFromChangeLog();
    const second = cloud.updateCloudFromChangeLog();
    release();
    await Promise.all([first, second]);

    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('updateCloudFromChangeLog drain', () => {
  beforeEach(async () => {
    await seedUser();
    await cloud.initialize(sqliteStore);
    await waitFor(async () => (await changeLogCount()) === 0);
    cloud.calls.length = 0;
  });

  test('uploads a private record, bumps its changeId and clears the change log', async () => {
    const note = await new Note({ text: 'sync me' }).save({}, false);
    await note.updateChangeLog();

    await cloud.updateCloudFromChangeLog();

    const document = cloud.port.get(`User/${AUTH_ID}/Note/${note.id}`);
    expect(document).toMatchObject({ text: 'sync me', changeId: 2, isPrivate: true });
    // The local seed (changeId 1) is what the new Meta doc starts from, so the cloud lands on 2.
    expect(cloud.port.get(`User/${AUTH_ID}/Meta/auto-1`)).toMatchObject({ collection: 'Note', changeId: 2 });
    const stored = await dataSource.getRepository(Note).findOneBy({ id: note.id });
    expect(stored!.changeId).toBe(2);
    expect(await changeLogCount()).toBe(0);
  });

  test('uploads a user record to its auth-keyed document, not into a collection', async () => {
    const user = cloud.user as User;
    user.displayName = 'Renamed';
    await user.save();

    await cloud.updateCloudFromChangeLog();

    expect(cloud.port.get(`User/${AUTH_ID}`)).toMatchObject({ displayName: 'Renamed', authId: AUTH_ID });
    expect(cloud.port.paths()).toEqual([`User/${AUTH_ID}`]);
    expect(await changeLogCount()).toBe(0);
  });

  test('brackets each upload with unsubscribe/subscribe of that record type', async () => {
    await new Note({ text: 'sync me' }).save();

    await cloud.updateCloudFromChangeLog();

    expect(cloud.calls).toEqual(['unsubscribe:Note', 'update:Note', 'subscribe:Note']);
  });

  test('writes a public record outside the user document', async () => {
    const tag = await new Tag({ label: 'shared', isPrivate: false }).save();

    await cloud.updateCloudFromChangeLog();

    expect(cloud.port.get(`Tag/${tag.id}`)).toMatchObject({ label: 'shared', isPrivate: false });
    expect(cloud.port.get('Meta/auto-1')).toMatchObject({ collection: 'Tag' });
    expect(await changeLogCount()).toBe(0);
  });

  test('drains every pending change in one pass', async () => {
    await new Note({ text: 'one' }).save();
    await new Note({ text: 'two' }).save();
    await new Tag({ label: 'three' }).save();

    await cloud.updateCloudFromChangeLog();

    expect(cloud.port.paths().filter((p) => p.includes('/Note/'))).toHaveLength(2);
    expect(cloud.port.paths().filter((p) => p.includes('/Tag/'))).toHaveLength(1);
    expect(await changeLogCount()).toBe(0);
  });

  test('drops a change-log row whose record no longer exists', async () => {
    const note = await new Note({ text: 'doomed' }).save();
    await note.remove();

    await cloud.updateCloudFromChangeLog();

    expect(cloud.calls).toEqual([]);
    expect(await changeLogCount()).toBe(0);
  });

  test('keeps the change-log row when the upload fails', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(cloud, 'updateStoreRecord').mockRejectedValue(new Error('cloud unreachable'));
    await new Note({ text: 'unsent' }).save();

    await cloud.updateCloudFromChangeLog();

    expect(await changeLogCount()).toBe(1);
  });
});

describe('resolveRecord', () => {
  beforeEach(async () => {
    await seedUser();
    await cloud.initialize(sqliteStore);
    await waitFor(async () => (await changeLogCount()) === 0);
  });

  test('resolves against the local copy when a local change is pending', async () => {
    const note = await new Note({ text: 'local edit' }).save();
    const resolve = jest.spyOn(sqliteStore, 'resolve');

    const incoming = new Note({ id: note.id, text: 'cloud edit' });
    await (cloud as any).resolveRecord(Note, incoming);

    expect(resolve).toHaveBeenCalledTimes(1);
    const [cloudArg, localArg] = resolve.mock.calls[0];
    expect(cloudArg).toBe(incoming);
    expect((localArg as Note).id).toBe(note.id);
  });

  test('resolves straight from the cloud when nothing is pending', async () => {
    const note = await new Note({ text: 'clean' }).save({}, false);
    const resolve = jest.spyOn(sqliteStore, 'resolve');

    const incoming = new Note({ id: note.id, text: 'cloud edit' });
    await (cloud as any).resolveRecord(Note, incoming);

    expect(resolve).toHaveBeenCalledWith(incoming);
  });

  test('resolveRecords keeps only the records that changed', async () => {
    jest
      .spyOn(sqliteStore, 'resolve')
      .mockResolvedValueOnce(new Note({ text: 'kept' }))
      .mockResolvedValueOnce(null);

    const resolved = await (cloud as any).resolveRecords(Note, [new Note({ id: 'a' }), new Note({ id: 'b' })]);

    expect(resolved).toHaveLength(1);
  });
});
