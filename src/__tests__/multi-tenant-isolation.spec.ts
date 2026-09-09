import { BehaviorSubject } from 'rxjs';
import { SqliteStore, StoreChangeLog, Tenant, TenantRegistry } from '../index';
import { changeLogs, createTestDataSource, Note, silenceLibraryLogs, Tag, User } from './fake-entities';
import { FakeCloudStore } from './fake-cloud-store';

// NFR1: two accounts held on one device at the same time, with no cross-tenant leakage in either
// direction. Isolation here is structural — separate DataSources and separate ports — so these
// assert that nothing in the sync path reintroduces a shared channel between them.

const AUTH_A = 'auth-A';
const AUTH_B = 'auth-B';

let registry: TenantRegistry;
let networks: Map<string, BehaviorSubject<boolean>>;
let a: Tenant;
let b: Tenant;

const openTenant = async (authId: string): Promise<Tenant> => {
  const dataSource = await createTestDataSource([User, Note, Tag, StoreChangeLog]);
  const localStore = new SqliteStore(dataSource, User);
  const network = new BehaviorSubject<boolean>(true);
  networks.set(authId, network);
  const cloud = new FakeCloudStore(User, [], [Note], network);
  await new User({ authId }).saveWithManager(dataSource.manager, {}, false);
  await cloud.initialize(localStore);
  return new Tenant(authId, localStore, cloud);
};

const portOf = (tenant: Tenant) => (tenant.cloud as FakeCloudStore).port;
const notesIn = (tenant: Tenant) => tenant.localStore.dataSource.getRepository(Note);

// Stage a local change without the automatic push, so a test drives the drain itself.
const stageOffline = async <T>(tenant: Tenant, save: () => Promise<T>): Promise<T> => {
  const network = networks.get(tenant.key)!;
  network.next(false);
  try {
    return await save();
  } finally {
    network.next(true);
  }
};

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

const quiet = (tenant: Tenant) =>
  waitFor(
    async () =>
      !(tenant.cloud as any).updatingCloudFromChangeLog &&
      (await changeLogs(tenant.localStore.dataSource).count()) === 0,
  );

beforeEach(async () => {
  silenceLibraryLogs();
  networks = new Map();
  registry = new TenantRegistry(openTenant);
  a = await registry.open(AUTH_A);
  b = await registry.open(AUTH_B);
  await Promise.all([quiet(a), quiet(b)]);
});

afterEach(async () => {
  await registry.closeAll();
});

test('a write in one tenant reaches only its own database and cloud', async () => {
  const note = await new Note({ text: 'belongs to A' }).saveWithManager(a.localStore.manager);
  await quiet(a);

  expect(portOf(a).get(`User/${AUTH_A}/Note/${note.id}`)).toMatchObject({ text: 'belongs to A' });
  expect(
    portOf(a)
      .paths()
      .every((path) => path.startsWith(`User/${AUTH_A}/`)),
  ).toBe(true);

  expect(portOf(b).paths()).toEqual([]);
  await expect(notesIn(b).count()).resolves.toBe(0);
  await expect(changeLogs(b.localStore.dataSource).count()).resolves.toBe(0);
});

test('neither tenant can query the other tenant rows', async () => {
  await new Note({ text: 'A note' }).saveWithManager(a.localStore.manager);
  await new Note({ text: 'B note' }).saveWithManager(b.localStore.manager);
  await Promise.all([quiet(a), quiet(b)]);

  await expect(
    notesIn(a)
      .find()
      .then((n) => n.map((x) => x.text)),
  ).resolves.toEqual(['A note']);
  await expect(
    notesIn(b)
      .find()
      .then((n) => n.map((x) => x.text)),
  ).resolves.toEqual(['B note']);
});

test('records sharing an id stay separate', async () => {
  const id = 'a-shared-uuid';
  await new Note({ id, text: 'A version' }).saveWithManager(a.localStore.manager);
  await new Note({ id, text: 'B version' }).saveWithManager(b.localStore.manager);
  await Promise.all([quiet(a), quiet(b)]);

  await expect(
    notesIn(a)
      .findOneBy({ id })
      .then((n) => n!.text),
  ).resolves.toBe('A version');
  await expect(
    notesIn(b)
      .findOneBy({ id })
      .then((n) => n!.text),
  ).resolves.toBe('B version');
  expect(portOf(a).get(`User/${AUTH_A}/Note/${id}`)).toMatchObject({ text: 'A version' });
  expect(portOf(b).get(`User/${AUTH_B}/Note/${id}`)).toMatchObject({ text: 'B version' });
});

test('each tenant syncs its own user to its own auth-keyed document', async () => {
  a.cloud.user!.displayName = 'Person A';
  b.cloud.user!.displayName = 'Person B';
  await a.cloud.user!.saveWithManager(a.localStore.manager);
  await b.cloud.user!.saveWithManager(b.localStore.manager);
  await Promise.all([quiet(a), quiet(b)]);

  expect(portOf(a).get(`User/${AUTH_A}`)).toMatchObject({ displayName: 'Person A', authId: AUTH_A });
  expect(portOf(b).get(`User/${AUTH_B}`)).toMatchObject({ displayName: 'Person B', authId: AUTH_B });
  expect(portOf(a).get(`User/${AUTH_B}`)).toBeUndefined();
  expect(portOf(b).get(`User/${AUTH_A}`)).toBeUndefined();
});

test('concurrent drains do not cross-write', async () => {
  const aNotes = await stageOffline(a, async () => [
    await new Note({ text: 'A one' }).saveWithManager(a.localStore.manager),
    await new Note({ text: 'A two' }).saveWithManager(a.localStore.manager),
  ]);
  const bNotes = await stageOffline(b, async () => [
    await new Note({ text: 'B one' }).saveWithManager(b.localStore.manager),
  ]);

  await Promise.all([a.cloud.updateCloudFromChangeLog(), b.cloud.updateCloudFromChangeLog()]);

  expect(portOf(a).paths().sort()).toEqual(
    [`User/${AUTH_A}/Meta/auto-1`, ...aNotes.map((n) => `User/${AUTH_A}/Note/${n.id}`)].sort(),
  );
  expect(portOf(b).paths().sort()).toEqual(
    [`User/${AUTH_B}/Meta/auto-1`, ...bNotes.map((n) => `User/${AUTH_B}/Note/${n.id}`)].sort(),
  );
  await expect(changeLogs(a.localStore.dataSource).count()).resolves.toBe(0);
  await expect(changeLogs(b.localStore.dataSource).count()).resolves.toBe(0);
});

test('a failing cloud in one tenant does not stall the other', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(b.cloud, 'updateStoreRecord').mockRejectedValue(new Error('cloud unreachable'));
  const note = await stageOffline(a, () => new Note({ text: 'A still syncs' }).saveWithManager(a.localStore.manager));
  await stageOffline(b, () => new Note({ text: 'B stuck' }).saveWithManager(b.localStore.manager));

  await Promise.all([a.cloud.updateCloudFromChangeLog(), b.cloud.updateCloudFromChangeLog()]);

  expect(portOf(a).get(`User/${AUTH_A}/Note/${note.id}`)).toBeDefined();
  await expect(changeLogs(a.localStore.dataSource).count()).resolves.toBe(0);
  await expect(changeLogs(b.localStore.dataSource).count()).resolves.toBe(1);
});

test('disposing one tenant leaves the other syncing end to end', async () => {
  await registry.close(AUTH_B);

  const note = await new Note({ text: 'after B is gone' }).saveWithManager(a.localStore.manager);
  await quiet(a);

  expect(portOf(a).get(`User/${AUTH_A}/Note/${note.id}`)).toMatchObject({ text: 'after B is gone' });
  expect(a.localStore.dataSource.isInitialized).toBe(true);
  expect(b.localStore.dataSource.isInitialized).toBe(false);
  expect(portOf(b).paths()).toEqual([]);
});
