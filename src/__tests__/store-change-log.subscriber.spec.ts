import { BehaviorSubject } from 'rxjs';
import { DataSource } from 'typeorm/browser';
import { SqliteStore, StoreChangeLog, StoreChangeLogSubscriber } from '../index';
import { changeLogs, createTestDataSource, Note, silenceLibraryLogs, Tag, User } from './fake-entities';
import { FakeCloudStore } from './fake-cloud-store';

// Characterization tests for the change-log subscriber, the trigger that is supposed to push a
// local commit to the cloud. Step 3 of the multi-tenant plan re-wires it per tenant, so what it
// does — and does not — do today is pinned here.

let dataSource: DataSource;
let cloud: FakeCloudStore;

const commitEvent = (data: any) => ({ queryRunner: { data } }) as any;

beforeEach(async () => {
  silenceLibraryLogs();
  dataSource = await createTestDataSource([User, Note, Tag, StoreChangeLog], [StoreChangeLogSubscriber]);
  cloud = new FakeCloudStore(User, [], [Note], new BehaviorSubject<boolean>(true));
  await new User({ authId: 'auth-A' }).save({}, false);
  await cloud.initialize(new SqliteStore(dataSource, User));
});

afterEach(async () => {
  await dataSource.destroy();
});

test('a local save does not reach the cloud on its own', async () => {
  // TypeORM builds a registered subscriber with `new Subscriber()`, so the instance the DataSource
  // holds has no `cloud` and pushes nothing. CloudStore's own `new StoreChangeLogSubscriber(this)`
  // is never attached to a DataSource, so it never sees a commit either.
  const note = await new Note({ text: 'local only' }).save();

  await expect(changeLogs(dataSource).count()).resolves.toBe(1);
  expect(cloud.port.get(`User/auth-A/Note/${note.id}`)).toBeUndefined();
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
