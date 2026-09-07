import { BehaviorSubject } from 'rxjs';
import { DataSource } from 'typeorm/browser';
import { BaseUserSubscriber, SqliteStore, StoreChangeLog } from '../index';
import { createTestDataSource, Note, silenceLibraryLogs, User } from './fake-entities';
import { FakeCloudStore } from './fake-cloud-store';

// Publishes a saved user onto its tenant's CloudStore. Attached per tenant by CloudStore, so a
// user saved in one database can only reach that database's cloud.

let dataSource: DataSource;
let cloud: FakeCloudStore;
let subscriber: BaseUserSubscriber;

beforeEach(async () => {
  silenceLibraryLogs();
  dataSource = await createTestDataSource([User, Note, StoreChangeLog]);
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

test('the tenant CloudStore attaches its own instance, so a saved user is published', async () => {
  expect(cloud.user).toBeNull();

  await new User({ authId: 'auth-B' }).save({}, false);

  expect(cloud.user!.authId).toBe('auth-B');
});

test('listing the subscriber class on a DataSource registers nothing', async () => {
  const classRegistered = await createTestDataSource([User, Note, StoreChangeLog], [BaseUserSubscriber]);

  expect(classRegistered.subscribers).toHaveLength(0);
  await classRegistered.destroy();
});
