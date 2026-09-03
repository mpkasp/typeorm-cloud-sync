import { BehaviorSubject } from 'rxjs';
import { DataSource } from 'typeorm/browser';
import { BaseUserSubscriber, SqliteStore, StoreChangeLog } from '../index';
import { createTestDataSource, Note, silenceLibraryLogs, User } from './fake-entities';
import { FakeCloudStore } from './fake-cloud-store';

// The other globally-decorated subscriber Step 3 has to re-wire per tenant. Like
// StoreChangeLogSubscriber it is inert unless something hands it a CloudStore.

let dataSource: DataSource;
let cloud: FakeCloudStore;
let subscriber: BaseUserSubscriber;

beforeEach(async () => {
  silenceLibraryLogs();
  dataSource = await createTestDataSource([User, Note, StoreChangeLog], [BaseUserSubscriber]);
  cloud = new FakeCloudStore(User, [], [Note], new BehaviorSubject<boolean>(true));
  await cloud.initialize(new SqliteStore(dataSource, User));
  subscriber = new BaseUserSubscriber(User, cloud);
});

afterEach(async () => {
  await dataSource.destroy();
});

test('listens to the app supplied user model', () => {
  expect(subscriber.listenTo()).toBe(User);
});

test('publishes an inserted user to the cloud store', () => {
  const user = new User({ authId: 'auth-A' });

  subscriber.afterInsert({ entity: user } as any);

  expect(cloud.user).toBe(user);
});

test('publishes the pre-update row on update, not the new one', () => {
  const stored = new User({ authId: 'auth-A', displayName: 'Before' });
  const incoming = new User({ authId: 'auth-A', displayName: 'After' });

  subscriber.afterUpdate({ entity: incoming, databaseEntity: stored } as any);

  expect(cloud.user).toBe(stored);
});

test('is a no-op without a cloud store', () => {
  const unwired = new BaseUserSubscriber(User, undefined as any);

  expect(() => unwired.afterInsert({ entity: new User({}) } as any)).not.toThrow();
});

test('a DataSource-registered instance gets no cloud, so saves stay local', async () => {
  // TypeORM constructs registered subscribers with `new Subscriber()`: no UserModel (so it listens
  // to everything) and no cloud store (so it publishes nothing).
  expect(cloud.user).toBeNull();

  await new User({ authId: 'auth-B' }).save({}, false);

  expect(cloud.user).toBeNull();
});
