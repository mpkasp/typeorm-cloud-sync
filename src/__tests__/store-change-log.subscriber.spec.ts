import { BehaviorSubject } from 'rxjs';
import { DataSource } from 'typeorm/browser';
import { SqliteStore, StoreChangeLog, StoreChangeLogSubscriber } from '../index';
import { changeLogs, createTestDataSource, Note, silenceLibraryLogs, Tag, User } from './fake-entities';
import { FakeCloudStore } from './fake-cloud-store';

// The change-log subscriber is the trigger that pushes a local commit to the cloud. A CloudStore
// attaches its own instance to its own DataSource, so these cover both the routing and the
// subscriber's own logic.

let dataSource: DataSource;
let cloud: FakeCloudStore;

const commitEvent = (data: any) => ({ queryRunner: { data } }) as any;

const drained = async (store: FakeCloudStore, source: DataSource) => {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!(store as any).updatingCloudFromChangeLog && (await changeLogs(source).count()) === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for the change log to drain');
};

beforeEach(async () => {
  silenceLibraryLogs();
  dataSource = await createTestDataSource([User, Note, Tag, StoreChangeLog]);
  cloud = new FakeCloudStore(User, [], [Note], new BehaviorSubject<boolean>(true));
  await new User({ authId: 'auth-A' }).save({}, false);
  await cloud.initialize(new SqliteStore(dataSource, User));
});

afterEach(async () => {
  await dataSource.destroy();
});

test('a local save pushes to the cloud without an explicit drain', async () => {
  const note = await new Note({ text: 'local edit' }).save();

  await drained(cloud, dataSource);
  expect(cloud.port.get(`User/auth-A/Note/${note.id}`)).toMatchObject({ text: 'local edit' });
});

test('listing the subscriber class on a DataSource registers nothing', async () => {
  // The class carries no @EventSubscriber() metadata, so TypeORM's class-based registration — which
  // would build it with a zero-argument constructor and no cloud — cannot pick it up.
  const classRegistered = await createTestDataSource([User, Note, StoreChangeLog], [StoreChangeLogSubscriber]);

  expect(classRegistered.subscribers).toHaveLength(0);
  await classRegistered.destroy();
});

describe('when the subscriber holds a cloud', () => {
  let subscriber: StoreChangeLogSubscriber;
  let push: jest.SpyInstance;

  beforeEach(() => {
    subscriber = new StoreChangeLogSubscriber(cloud);
    push = jest.spyOn(cloud, 'updateCloudFromChangeLog').mockResolvedValue(undefined);
  });

  test('listens to StoreChangeLog only', () => {
    expect(subscriber.listenTo()).toBe(StoreChangeLog);
  });

  test('pushes after a commit that inserted a change-log row', () => {
    const event = commitEvent({});
    subscriber.afterInsert(event);
    subscriber.afterTransactionCommit(event);

    expect(push).toHaveBeenCalledTimes(1);
  });

  test('pushes after a commit that updated a change-log row', () => {
    const event = commitEvent({});
    subscriber.afterUpdate(event);
    subscriber.afterTransactionCommit(event);

    expect(push).toHaveBeenCalledTimes(1);
  });

  test('ignores a commit that touched no change-log row', () => {
    subscriber.afterTransactionCommit(commitEvent({}));

    expect(push).not.toHaveBeenCalled();
  });

  test('does not push while offline', () => {
    const event = commitEvent({});
    subscriber.afterInsert(event);
    (cloud as any).networkSubject.next(false);
    subscriber.afterTransactionCommit(event);

    expect(push).not.toHaveBeenCalled();
  });

  test('does not make the commit wait on the cloud round-trip', () => {
    let settled = false;
    push.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50)).then(() => (settled = true)));

    const event = commitEvent({});
    subscriber.afterInsert(event);

    // A returned promise would be awaited by TypeORM, blocking every local commit on the cloud.
    expect(subscriber.afterTransactionCommit(event)).toBeUndefined();
    expect(settled).toBe(false);
  });

  test('swallows a failed background push', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    push.mockRejectedValue(new Error('cloud unreachable'));

    const event = commitEvent({});
    subscriber.afterInsert(event);
    subscriber.afterTransactionCommit(event);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe('routing between tenants', () => {
  let otherDataSource: DataSource;
  let otherCloud: FakeCloudStore;

  beforeEach(async () => {
    otherDataSource = await createTestDataSource([User, Note, Tag, StoreChangeLog]);
    otherCloud = new FakeCloudStore(User, [], [Note], new BehaviorSubject<boolean>(true));
    await new User({ authId: 'auth-B' }).saveWithManager(otherDataSource.manager, {}, false);
    await otherCloud.initialize(new SqliteStore(otherDataSource, User));
  });

  afterEach(async () => {
    await otherDataSource.destroy();
  });

  test('a commit on one tenant never fires the other tenant push', async () => {
    const otherPush = jest.spyOn(otherCloud, 'updateCloudFromChangeLog');

    const note = await new Note({ text: 'tenant a' }).saveWithManager(dataSource.manager);

    await drained(cloud, dataSource);
    expect(cloud.port.get(`User/auth-A/Note/${note.id}`)).toBeDefined();
    expect(otherPush).not.toHaveBeenCalled();
    expect(otherCloud.port.paths()).toEqual([]);
    await expect(changeLogs(otherDataSource).count()).resolves.toBe(0);
  });
});
