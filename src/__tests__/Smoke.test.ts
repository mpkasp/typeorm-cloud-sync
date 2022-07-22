import { BaseUser, SqliteStore, StoreChangeLog } from '../index';
import { DataSource } from 'typeorm';

// TODO: Write a test that checks if we can tell that a SpecialUser is typeof User in Cloud-firebase User functions

const dataSource: DataSource = new DataSource({
  name: 'default',
  type: 'sqlite',
  database: 'tests',
  dropSchema: true,
  logging: false,
  synchronize: false,
  migrationsRun: true,
  entities: [BaseUser, StoreChangeLog, './entities/*.ts'],
});

let sqliteStore: SqliteStore;

beforeEach(async () => {
  await dataSource.initialize();
  await dataSource.synchronize().catch((err) => {
    console.error(err);
  });
  const UserModel = BaseUser;
  sqliteStore = new SqliteStore(dataSource, UserModel);
});

afterEach(async () => {
  await sqliteStore.dataSource.dropDatabase();
  await sqliteStore.dataSource.destroy();
});

test('Smoke', async () => {
  expect(sqliteStore.dataSource.isInitialized).toBe(true);
});

test('Test Save', async () => {
  expect(sqliteStore.dataSource.isInitialized).toBe(true);
  let localRecord = await new BaseUser({ displayName: 'A Local Name', changeId: 1 }).save();
  expect(localRecord.displayName).toBe('A Local Name');
});

test('Test Resolve', async () => {
  let cloudRecord = await new BaseUser({ displayName: 'A Cloud Name', changeId: 2 }).save();
  let localRecord = await new BaseUser({ displayName: 'A Local Name', changeId: 1 }).save();
  const resolvedRecord = (await sqliteStore.resolve(cloudRecord, localRecord)) as BaseUser;
  expect(resolvedRecord.displayName).toBe(localRecord.displayName);
});
