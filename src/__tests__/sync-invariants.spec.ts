import { BehaviorSubject } from 'rxjs';
import { DataSource } from 'typeorm/browser';
import { SqliteStore, StoreChangeLog } from '../index';
import { changeLogs, createTestDataSource, Note, silenceLibraryLogs, Tag, User } from './fake-entities';
import { FakeCloudStore } from './fake-cloud-store';

// Invariant tests from the 2026-09-14 sync review (docs/sync-review-workplan.md in the daily repo).
//
// Each is declared with `test.failing` while the defect it describes is still present: Jest passes a
// failing test and FAILS once the assertion starts to hold. So the fix for a finding is done when its
// test fails here — then change `test.failing` to `test` in the same commit and the suite is green
// again. Never delete one of these to make the suite pass.

const AUTH_ID = 'auth-A';
let dataSource: DataSource;
let sqliteStore: SqliteStore;
let network: BehaviorSubject<boolean>;
let cloud: FakeCloudStore;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(5);
  }
  throw new Error('timed out waiting for condition');
}

const changeLogCount = () => changeLogs(dataSource).count();
const drainSettled = () => waitFor(async () => !(cloud as any).updatingCloudFromChangeLog);

const stageOffline = async <T>(save: () => Promise<T>): Promise<T> => {
  network.next(false);
  try {
    return await save();
  } finally {
    network.next(true);
  }
};

beforeEach(async () => {
  silenceLibraryLogs();
  dataSource = await createTestDataSource([User, Note, Tag, StoreChangeLog]);
  sqliteStore = new SqliteStore(dataSource, User);
  network = new BehaviorSubject<boolean>(true);
  cloud = new FakeCloudStore(User, [Tag], [Note], network);
  await new User({ authId: AUTH_ID }).saveWithManager(dataSource.manager, {}, false);
  await cloud.initialize(sqliteStore);
});

afterEach(async () => {
  await drainSettled();
  await dataSource.destroy();
});

// I1 — a change-log row is deleted only by the drain that observed that exact version of it. (F2)
test.failing('a local edit made while its record is mid-upload is not dropped from the change log', async () => {
  const note = await stageOffline(() => new Note({ text: 'v1' }).saveWithManager(dataSource.manager));
  await expect(changeLogCount()).resolves.toBe(1);

  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const upload = cloud.updateStoreRecord.bind(cloud);
  jest.spyOn(cloud, 'updateStoreRecord').mockImplementation(async (obj) => {
    await gate;
    return upload(obj);
  });

  const drain = cloud.updateCloudFromChangeLog();
  await sleep(20);
  const edited = (await dataSource.getRepository(Note).findOneBy({ id: note.id }))!;
  edited.text = 'v2';
  await edited.saveWithManager(dataSource.manager);

  release();
  await drain;
  await drainSettled();

  const cloudDoc = await cloud.port.getDoc(`User/${AUTH_ID}/Note/${note.id}`);
  const pending = await changeLogCount();
  // Either v2 already reached the cloud, or it is still queued. Silently dropping it is the defect.
  expect(cloudDoc.data?.text === 'v2' || pending === 1).toBe(true);
});

// I2 — cloud-origin writes never invent data: timestamps travel with the record. (F5)
test.failing('a downloaded record keeps the createdMs/updatedMs the cloud document carries', async () => {
  const cloudNote = new Note({ id: 'n1', text: 'from cloud', changeId: 7 });
  (cloudNote as any).createdMs = 1_000_000;
  (cloudNote as any).updatedMs = 2_000_000;

  await (cloud as any).resolveRecords(Note, [cloudNote]);

  const local = (await dataSource.getRepository(Note).findOneBy({ id: 'n1' })) as any;
  expect(local.createdMs).toBe(1_000_000);
  expect(local.updatedMs).toBe(2_000_000);
});

// I2 — re-delivering an identical document is a no-op locally. (F5, F6)
test.failing('re-delivery of an unchanged document does not rewrite the local row', async () => {
  const deliver = async () => {
    const doc = new Note({ id: 'n1', text: 'from cloud', changeId: 7 });
    (doc as any).createdMs = 1_000_000;
    (doc as any).updatedMs = 2_000_000;
    await (cloud as any).resolveRecords(Note, [doc]);
  };
  await deliver();
  const first = (await dataSource.getRepository(Note).findOneBy({ id: 'n1' })) as any;
  await sleep(5);
  await deliver();
  const second = (await dataSource.getRepository(Note).findOneBy({ id: 'n1' })) as any;

  expect(second.updatedMs).toBe(first.updatedMs);
});

// I5 — the drain has a fixed trigger set, and network recovery is one of them. (F4)
test.failing('coming back online drains the change log', async () => {
  network.next(false);
  await new Note({ text: 'offline edit' }).saveWithManager(dataSource.manager);
  await expect(changeLogCount()).resolves.toBe(1);

  network.next(true);
  await waitFor(async () => (await changeLogCount()) === 0, 1000).catch(() => undefined);

  await expect(changeLogCount()).resolves.toBe(0);
});
