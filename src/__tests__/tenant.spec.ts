import { BehaviorSubject } from 'rxjs';
import { DataSource } from 'typeorm/browser';
import { SqliteStore, StoreChangeLog, Tenant, TenantRegistry } from '../index';
import { changeLogs, createTestDataSource, Note, silenceLibraryLogs, Tag, User } from './fake-entities';
import { FakeCloudStore } from './fake-cloud-store';

// The registry seam: N accounts open at once, each with its own DataSource, CloudStore and port.

let registry: TenantRegistry;
let opened: string[];
let networks: Map<string, BehaviorSubject<boolean>>;

const openTenant = async (authId: string): Promise<Tenant> => {
  opened.push(authId);
  const dataSource = await createTestDataSource([User, Note, Tag, StoreChangeLog]);
  const localStore = new SqliteStore(dataSource, User);
  const network = new BehaviorSubject<boolean>(true);
  networks.set(authId, network);
  const cloud = new FakeCloudStore(User, [], [Note], network);
  await new User({ authId }).saveWithManager(dataSource.manager, {}, false);
  await cloud.initialize(localStore);
  return new Tenant(authId, localStore, cloud);
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

beforeEach(() => {
  silenceLibraryLogs();
  opened = [];
  networks = new Map();
  registry = new TenantRegistry(openTenant);
});

afterEach(async () => {
  await registry.closeAll();
});

test('opens a tenant and looks it up by authId', async () => {
  const tenant = await registry.open('auth-A');

  expect(tenant.authId).toBe('auth-A');
  expect(registry.get('auth-A')).toBe(tenant);
  expect(registry.has('auth-A')).toBe(true);
  expect(registry.list()).toEqual([tenant]);
});

test('reopening returns the same tenant rather than a second DataSource', async () => {
  const first = await registry.open('auth-A');
  const second = await registry.open('auth-A');

  expect(second).toBe(first);
  expect(opened).toEqual(['auth-A']);
});

test('concurrent opens of one account share a single tenant', async () => {
  const [first, second] = await Promise.all([registry.open('auth-A'), registry.open('auth-A')]);

  expect(second).toBe(first);
  expect(opened).toEqual(['auth-A']);
});

test('holds several accounts at once, each with its own store', async () => {
  const a = await registry.open('auth-A');
  const b = await registry.open('auth-B');

  expect(registry.list()).toHaveLength(2);
  expect(a.localStore.dataSource).not.toBe(b.localStore.dataSource);
  expect((a.cloud as FakeCloudStore).port).not.toBe((b.cloud as FakeCloudStore).port);
  expect(a.cloud.user!.authId).toBe('auth-A');
  expect(b.cloud.user!.authId).toBe('auth-B');
});

test('closing one tenant destroys its DataSource and leaves the others intact', async () => {
  const a = await registry.open('auth-A');
  const b = await registry.open('auth-B');

  await registry.close('auth-B');

  expect(registry.has('auth-B')).toBe(false);
  expect(b.localStore.dataSource.isInitialized).toBe(false);
  expect(registry.get('auth-A')).toBe(a);
  expect(a.localStore.dataSource.isInitialized).toBe(true);

  const note = await new Note({ text: 'still works' }).saveWithManager(a.localStore.manager);
  await expect(a.localStore.dataSource.getRepository(Note).findOneBy({ id: note.id })).resolves.not.toBeNull();
});

test('closing an unknown account is a no-op', async () => {
  await expect(registry.close('nobody')).resolves.toBeUndefined();
});

test('a disposed tenant stops pushing local commits to its cloud', async () => {
  const tenant = await registry.open('auth-A');
  const dataSource = tenant.localStore.dataSource;
  await waitFor(() => !(tenant.cloud as any).updatingCloudFromChangeLog);
  const push = jest.spyOn(tenant.cloud, 'updateCloudFromChangeLog');

  tenant.cloud.dispose();
  await new Note({ text: 'after dispose' }).saveWithManager(dataSource.manager);

  expect(push).not.toHaveBeenCalled();
  expect(dataSource.subscribers).toHaveLength(0);
});

test('a disposed tenant ignores an explicit drain', async () => {
  const tenant = await registry.open('auth-A');
  await waitFor(() => !(tenant.cloud as any).updatingCloudFromChangeLog);
  const network = networks.get('auth-A')!;
  // Staged offline so the only drain in play is the explicit one below.
  network.next(false);
  const note = await new Note({ text: 'queued' }).saveWithManager(tenant.localStore.manager);
  network.next(true);

  tenant.cloud.dispose();
  await tenant.cloud.updateCloudFromChangeLog();

  expect((tenant.cloud as FakeCloudStore).port.get(`User/auth-A/Note/${note.id}`)).toBeUndefined();
  await expect(changeLogs(tenant.localStore.dataSource).count()).resolves.toBe(1);
});

test('a disposed tenant does not resubscribe when its user changes', async () => {
  const tenant = await registry.open('auth-A');
  const cloud = tenant.cloud as FakeCloudStore;
  await waitFor(() => !(cloud as any).updatingCloudFromChangeLog);

  cloud.dispose();
  cloud.calls.length = 0;
  cloud.userSubject.next(new User({ authId: 'auth-C' }));

  expect(cloud.calls).toEqual([]);
});

test('closeAll disposes every open tenant', async () => {
  const a = await registry.open('auth-A');
  const b = await registry.open('auth-B');

  await registry.closeAll();

  expect(registry.list()).toEqual([]);
  expect(a.localStore.dataSource.isInitialized).toBe(false);
  expect(b.localStore.dataSource.isInitialized).toBe(false);
});
