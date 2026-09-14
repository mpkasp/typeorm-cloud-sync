import { BehaviorSubject } from 'rxjs';
import { DataSource } from 'typeorm/browser';
import { getDocs, limit, onSnapshot, query, where } from 'firebase/firestore';
import { SqliteStore } from '../../../sqlite-store';
import { StoreChangeLog } from '../../../models/store-change-log.model';
import { Meta } from '../../../models/meta.model';
import { createTestDataSource, Note, silenceLibraryLogs, Tag, User } from '../../../__tests__/fake-entities';
import { CloudFirebaseFirestore } from '../cloud-firebase-firestore';

// The modular web SDK stands in for a real backend so the subscription bookkeeping around
// onSnapshot can be driven directly. Only the calls subscribeObj makes need real behaviour.
jest.mock('firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
  collection: jest.fn((_db: any, path: string) => ({ path })),
  doc: jest.fn((_db: any, ...segments: string[]) => ({ path: segments.join('/') })),
  query: jest.fn((ref: any) => ref),
  where: jest.fn(() => ({})),
  orderBy: jest.fn(() => ({})),
  limit: jest.fn(() => ({})),
  startAfter: jest.fn(() => ({})),
  getDocs: jest.fn(),
  onSnapshot: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  addDoc: jest.fn(),
  deleteDoc: jest.fn(),
  runTransaction: jest.fn(),
}));

let dataSource: DataSource;
let cloud: CloudFirebaseFirestore;
// Every live listener subscribeObj attached, in subscription order.
let listeners: ((snapshot: any) => void)[];

const documentOf = (data: Record<string, any>) => ({ id: data.id, data: () => ({ ...data }) });

// A delivery whose documents are all new to the listener, as Firestore reports them.
const snapshotOf = (docs: Record<string, any>[]) => ({
  size: docs.length,
  docs: docs.map(documentOf),
  docChanges: () => docs.map((data) => ({ type: 'added', doc: documentOf(data) })),
});

const tagDoc = (id: string, changeId: number) => ({
  id,
  label: `tag ${id}`,
  changeId,
  isDeleted: false,
  isPrivate: false,
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

beforeEach(async () => {
  silenceLibraryLogs();
  listeners = [];
  dataSource = await createTestDataSource([User, Note, Tag, StoreChangeLog, Meta]);

  (getDocs as jest.Mock).mockResolvedValue(snapshotOf([]));
  // Firestore hands a new listener the current result set immediately, then streams later changes
  // (including the backlog it buffered while the connection was down) through the same callback.
  (onSnapshot as jest.Mock).mockImplementation((_query: any, onNext: (snapshot: any) => void) => {
    listeners.push(onNext);
    onNext(snapshotOf([]));
    return () => undefined;
  });

  // One public record and no local user, so setup takes the public path only and every listener in
  // `listeners` belongs to a collection rather than the user document.
  cloud = new CloudFirebaseFirestore(User, [Tag], [], new BehaviorSubject<boolean>(true));
  await cloud.initialize(new SqliteStore(dataSource, User), {} as any);
});

afterEach(async () => {
  await cloud.whenIdle();
  cloud.dispose();
  await dataSource.destroy();
});

describe('subscribeObj live deliveries', () => {
  test('setup leaves the indicator down', () => {
    expect(listeners).toHaveLength(1);
    expect(cloud.downloading).toBe(false);
  });

  // The reported bug: after the screen came back, Firestore streamed the rest of the records through
  // the listener setup had already attached, so records kept landing with the indicator down.
  test('raises the indicator for records that arrive after setup', async () => {
    const seen: boolean[] = [];
    cloud.downloading$.subscribe((value) => seen.push(value));

    listeners[0](snapshotOf([tagDoc('tag-1', 7), tagDoc('tag-2', 8)]));

    expect(cloud.downloading).toBe(true);
    await waitFor(() => !cloud.downloading);

    expect(seen).toEqual([false, true, false]);
  });

  test('keeps the indicator up until the delivered records are written locally', async () => {
    listeners[0](snapshotOf([tagDoc('tag-1', 7)]));

    // Still downloading means still writing: the record must not already be readable.
    expect(cloud.downloading).toBe(true);
    expect(await dataSource.getRepository(Tag).count()).toBe(0);

    await waitFor(() => !cloud.downloading);
    expect(await dataSource.getRepository(Tag).findOneBy({ id: 'tag-1' })).not.toBeNull();
  });

  test('overlapping deliveries hold the indicator until the last one lands', async () => {
    const seen: boolean[] = [];
    cloud.downloading$.subscribe((value) => seen.push(value));

    listeners[0](snapshotOf([tagDoc('tag-1', 7)]));
    listeners[0](snapshotOf([tagDoc('tag-2', 8)]));
    await waitFor(() => !cloud.downloading);

    expect(seen).toEqual([false, true, false]);
    expect(await dataSource.getRepository(Tag).count()).toBe(2);
  });

  // F5: the clean insert path now saves with listeners off (see resolveRecordsLocked), so the
  // @BeforeInsert hook that used to fill these in no longer runs. deserialize is the one place left
  // that backfills a server-written document (the inbox projection Cloud Function omits them).
  test('fills in createdMs/updatedMs for a cloud document that omits them', async () => {
    listeners[0](snapshotOf([tagDoc('tag-1', 7)]));
    await waitFor(() => !cloud.downloading);

    const stored = (await dataSource.getRepository(Tag).findOneBy({ id: 'tag-1' })) as any;
    expect(stored.createdMs).toEqual(expect.any(Number));
    expect(stored.updatedMs).toEqual(expect.any(Number));
  });

  test('applies only the documents a delivery changed', async () => {
    listeners[0]({
      docChanges: () => [
        { type: 'modified', doc: documentOf(tagDoc('tag-1', 9)) },
        { type: 'removed', doc: documentOf(tagDoc('tag-2', 8)) },
      ],
    });
    await waitFor(() => !cloud.downloading);

    expect((await dataSource.getRepository(Tag).find()).map((tag) => tag.id)).toEqual(['tag-1']);
  });

  test('a delivery with no changes leaves the indicator down', () => {
    listeners[0]({ docChanges: () => [] });
    expect(cloud.downloading).toBe(false);
  });

  test('advances the collection cursor to the highest changeId a delivery carried', async () => {
    listeners[0](snapshotOf([tagDoc('tag-1', 8), tagDoc('tag-2', 7)]));
    await waitFor(() => !cloud.downloading);

    await expect(cloud.readCursor(Tag, false)).resolves.toBe(8);
  });

  // A listener never re-sends a document, so moving the cursor past a failed delivery would skip it
  // for good. The later delivery still lands; the failed documents are caught up on the next subscribe.
  test('a failed delivery keeps later deliveries from moving the cursor past it', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const resolveRecordsLocked = (cloud as any).resolveRecordsLocked.bind(cloud);
    jest
      .spyOn(cloud as any, 'resolveRecordsLocked')
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockImplementation((...args: any[]) => resolveRecordsLocked(...args));

    listeners[0](snapshotOf([tagDoc('tag-1', 7)]));
    listeners[0](snapshotOf([tagDoc('tag-2', 8)]));
    await waitFor(() => !cloud.downloading);

    expect(await dataSource.getRepository(Tag).findOneBy({ id: 'tag-1' })).toBeNull();
    expect(await dataSource.getRepository(Tag).findOneBy({ id: 'tag-2' })).not.toBeNull();
    await expect(cloud.readCursor(Tag, false)).resolves.toBe(0);
  });

  // A delivery that throws must not pin the indicator on: `downloading` gates updateCloudFromChangeLog,
  // so a stuck indicator would silently stop every later upload for the rest of the session.
  test('releases the indicator when a delivery fails to apply', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(cloud as any, 'resolveSnapshot').mockRejectedValue(new Error('database is closed'));

    listeners[0](snapshotOf([tagDoc('tag-1', 7)]));
    expect(cloud.downloading).toBe(true);

    await waitFor(() => !cloud.downloading);
    expect(warn).toHaveBeenCalled();
  });
});

test('subscribeObj catches up from the stored cursor, not from the highest local changeId', async () => {
  const ds = await createTestDataSource([User, Note, Tag, StoreChangeLog, Meta]);
  await ds.getRepository(Meta).save(new Meta('Tag', false, 3));
  // A changeId an upload wrote back locally, above documents other devices may still be writing.
  await ds.manager.save(
    Object.assign(new Tag({ id: 'uploaded', changeId: 50, isPrivate: false }), { createdMs: 1, updatedMs: 1 }),
  );
  (where as jest.Mock).mockClear();
  const cursorCloud = new CloudFirebaseFirestore(User, [Tag], [], new BehaviorSubject<boolean>(true));

  try {
    await cursorCloud.initialize(new SqliteStore(ds, User), {} as any);

    expect(where).toHaveBeenCalledWith('changeId', '>', 3);
  } finally {
    cursorCloud.dispose();
    await ds.destroy();
  }
});

test('setup settles when the listener fails', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const ds = await createTestDataSource([User, Note, Tag, StoreChangeLog, Meta]);
  (onSnapshot as jest.Mock).mockImplementation((_query: any, _onNext: any, onError: (error: unknown) => void) => {
    onError(new Error('permission-denied'));
    return () => undefined;
  });
  const failingCloud = new CloudFirebaseFirestore(User, [Tag], [], new BehaviorSubject<boolean>(true));

  try {
    await failingCloud.initialize(new SqliteStore(ds, User), {} as any);
    expect(failingCloud.downloading).toBe(false);
  } finally {
    failingCloud.dispose();
    await ds.destroy();
  }
});

test('setup settles and still listens when the catch-up fails', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  (getDocs as jest.Mock).mockRejectedValueOnce(new Error('unavailable'));
  (where as jest.Mock).mockClear();
  const ds = await createTestDataSource([User, Note, Tag, StoreChangeLog, Meta]);
  const offlineCloud = new CloudFirebaseFirestore(User, [Tag], [], new BehaviorSubject<boolean>(true));

  try {
    await offlineCloud.initialize(new SqliteStore(ds, User), {} as any);
    expect(offlineCloud.downloading).toBe(false);
    expect(onSnapshot).toHaveBeenCalled();
    expect(where).toHaveBeenLastCalledWith('changeId', '>', 0);
  } finally {
    offlineCloud.dispose();
    await ds.destroy();
  }
});

describe('subscribeObj paged catch-up', () => {
  const QUERY_LIMIT = 500;

  // Drives an initial download over a scripted sequence of getDocs pages, recording how many getDocs
  // calls had been issued at the moment each page began writing locally.
  const runPagedDownload = async (pages: Record<string, any>[][]) => {
    (getDocs as jest.Mock).mockClear();
    for (const page of pages) {
      (getDocs as jest.Mock).mockResolvedValueOnce(snapshotOf(page));
    }

    const ds = await createTestDataSource([User, Note, Tag, StoreChangeLog, Meta]);
    const pagedCloud = new CloudFirebaseFirestore(User, [Tag], [], new BehaviorSubject<boolean>(true));

    const getDocsCallsAtWrite: number[] = [];
    const resolveSnapshot = (pagedCloud as any).resolveSnapshot.bind(pagedCloud);
    jest.spyOn(pagedCloud as any, 'resolveSnapshot').mockImplementation(async (...args: any[]) => {
      getDocsCallsAtWrite.push((getDocs as jest.Mock).mock.calls.length);
      return resolveSnapshot(...args);
    });

    await pagedCloud.initialize(new SqliteStore(ds, User), {} as any);
    await pagedCloud.whenIdle();
    return { ds, pagedCloud, getDocsCallsAtWrite };
  };

  test('writes every record across pages and prefetches the next page before writing the current one', async () => {
    const fullPage = Array.from({ length: QUERY_LIMIT }, (_, i) => tagDoc(`t${i}`, i + 1));
    const lastPage = [tagDoc('t500', 501), tagDoc('t501', 502), tagDoc('t502', 503)];

    const { ds, pagedCloud, getDocsCallsAtWrite } = await runPagedDownload([fullPage, lastPage]);

    try {
      // Correctness: no records dropped or duplicated across the page boundary.
      expect(await ds.getRepository(Tag).count()).toBe(503);
      // Two pages fetched, no extra round trips.
      expect((getDocs as jest.Mock).mock.calls.length).toBe(2);
      // Pipelining: the second page was already fetched by the time the first began writing. A serial
      // read (fetch, then write, then fetch) would record 1 here.
      expect(getDocsCallsAtWrite[0]).toBe(2);
      await expect(pagedCloud.readCursor(Tag, false)).resolves.toBe(503);
    } finally {
      pagedCloud.dispose();
      await ds.destroy();
    }
  });

  test('anchors the live listener, without a limit, after the last caught-up document', async () => {
    const fullPage = Array.from({ length: QUERY_LIMIT }, (_, i) => tagDoc(`t${i}`, i + 1));
    (query as jest.Mock).mockClear();
    (where as jest.Mock).mockClear();
    (limit as jest.Mock).mockClear();
    (onSnapshot as jest.Mock).mockClear();

    const { ds, pagedCloud } = await runPagedDownload([fullPage, [tagDoc('t500', 501)]]);

    try {
      expect(await ds.getRepository(Tag).count()).toBe(501);
      const queryCalls = (query as jest.Mock).mock.calls;
      // The live query is the last one built: the collection, a where and an orderBy — no limit, no startAfter.
      expect(queryCalls[queryCalls.length - 1]).toHaveLength(3);
      expect(onSnapshot).toHaveBeenCalledTimes(1);
      expect(where).toHaveBeenLastCalledWith('changeId', '>', 501);
      expect(limit).toHaveBeenCalledTimes(2);
    } finally {
      pagedCloud.dispose();
      await ds.destroy();
    }
  });

  test('a catch-up that fails part way anchors the listener after the last page it applied', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fullPage = Array.from({ length: QUERY_LIMIT }, (_, i) => tagDoc(`t${i}`, i + 1));
    (getDocs as jest.Mock).mockClear();
    (getDocs as jest.Mock).mockResolvedValueOnce(snapshotOf(fullPage)).mockRejectedValueOnce(new Error('unavailable'));
    (where as jest.Mock).mockClear();
    const ds = await createTestDataSource([User, Note, Tag, StoreChangeLog, Meta]);
    const pagedCloud = new CloudFirebaseFirestore(User, [Tag], [], new BehaviorSubject<boolean>(true));

    try {
      await pagedCloud.initialize(new SqliteStore(ds, User), {} as any);
      expect(await ds.getRepository(Tag).count()).toBe(QUERY_LIMIT);
      expect(where).toHaveBeenLastCalledWith('changeId', '>', QUERY_LIMIT);
    } finally {
      pagedCloud.dispose();
      await ds.destroy();
    }
  });

  test('a single short page issues no extra fetch', async () => {
    const { ds, pagedCloud } = await runPagedDownload([[tagDoc('only', 1)]]);

    try {
      expect(await ds.getRepository(Tag).count()).toBe(1);
      expect((getDocs as jest.Mock).mock.calls.length).toBe(1);
    } finally {
      pagedCloud.dispose();
      await ds.destroy();
    }
  });
});
