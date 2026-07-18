import { BaseUser, SqliteStore, StoreChangeLog } from '../index';
import { DataSource } from 'typeorm/browser';
import initSqlJs from 'sql.js';

// TODO: Write a test that checks if we can tell that a SpecialUser is typeof User in Cloud-firebase User functions

// The package ships the TypeORM browser build (see typeorm-browser-build-gotcha), so tests use
// the in-memory `sqljs` driver with an injected sql.js module rather than a Node driver.
let dataSource: DataSource;
let sqliteStore: SqliteStore;

beforeEach(async () => {
  const SQL = await initSqlJs();
  dataSource = new DataSource({
    type: 'sqljs',
    driver: SQL,
    dropSchema: true,
    logging: false,
    synchronize: true,
    entities: [BaseUser, StoreChangeLog],
  });
  await dataSource.initialize();
  sqliteStore = new SqliteStore(dataSource, BaseUser);
});

afterEach(async () => {
  await dataSource.destroy();
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
