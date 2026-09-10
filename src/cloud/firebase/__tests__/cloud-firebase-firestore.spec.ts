import { BehaviorSubject } from 'rxjs';
import { DataSource } from 'typeorm/browser';
import { getDocs, onSnapshot } from 'firebase/firestore';
import { SqliteStore } from '../../../sqlite-store';
import { StoreChangeLog } from '../../../models/store-change-log.model';
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

const snapshotOf = (docs: Record<string, any>[]) => ({
  size: docs.length,
  docs: docs.map((data) => ({ id: data.id, data: () => ({ ...data }) })),
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
  dataSource = await createTestDataSource([User, Note, Tag, StoreChangeLog]);

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

describe('subscribeObj paged catch-up', () => {
  const QUERY_LIMIT = 500;

  // Drives an initial download over a scripted sequence of getDocs pages, recording how many getDocs
  // calls had been issued at the moment each page began writing locally.
  const runPagedDownload = async (pages: Record<string, any>[][]) => {
    (getDocs as jest.Mock).mockClear();
    for (const page of pages) {
      (getDocs as jest.Mock).mockResolvedValueOnce(snapshotOf(page));
    }

    const ds = await createTestDataSource([User, Note, Tag, StoreChangeLog]);
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
