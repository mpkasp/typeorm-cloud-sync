import {BaseUser, SqliteStore, StoreChangeLog} from '../index';
import {ConnectionOptions, createConnection} from "typeorm";

// TODO: Write a test that checks if we can tell that a SpecialUser is typeof User in Cloud-firebase User functions

const dbOptions: ConnectionOptions = {
  name: 'default',
  type: 'sqlite',
  database: 'tests',
  dropSchema: true,
  logging: false,
  synchronize: false,
  migrationsRun: true,
  entities: [BaseUser, StoreChangeLog, "./entities/*.ts"]
};

let sqliteStore: SqliteStore;

beforeEach(async () => {
  const connection = await createConnection(dbOptions);
  await connection.synchronize().catch(err => {
    alert(`${err}`);
  });
  const UserModel = BaseUser;
  sqliteStore = new SqliteStore(connection, UserModel);
});

afterEach(async () => {
  await sqliteStore.connection.dropDatabase();
  await sqliteStore.connection.close();
});

test('Smoke', async () => {
  expect(sqliteStore.connection.isConnected).toBe(true);
});

test('Test Save', async () => {
  let localRecord = await (new BaseUser({displayName: 'A Local Name', changeId: 1})).save();
  expect(localRecord.displayName).toBe('A Local Name');
});

test('Test Resolve', async () => {
  let cloudRecord = await (new BaseUser({displayName: 'A Cloud Name', changeId: 2})).save();
  let localRecord = await (new BaseUser({displayName: 'A Local Name', changeId: 1})).save();
  const resolvedRecord = await sqliteStore.resolve(cloudRecord, localRecord) as BaseUser;
  expect(resolvedRecord.displayName).toBe(localRecord.displayName);
});
