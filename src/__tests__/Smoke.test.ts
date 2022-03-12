import {BaseUser, SqliteStore} from '../index';
import {ConnectionOptions, createConnection} from "typeorm";

// TODO: Write a test that checks if we can tell that a SpecialUser is typeof User in Cloud-firebase User functions

let dbOptions: ConnectionOptions = {
  name: 'default',
  type: 'sqlite',
  database: 'tests',
  dropSchema: true,
  logging: false,
  synchronize: false,
  migrationsRun: true,
  entities: ["../models/base-user.model.ts", "../models/store-change-log.model.ts", "./entities/*.ts"]
};

test('Smoke', async () => {
  const connection = await createConnection(dbOptions);
  await connection.synchronize().catch(err => {
    alert(`${err}`);
  });
  const UserModel = BaseUser;
  const sqliteStore = new SqliteStore(connection, UserModel);
  expect(sqliteStore.connection.isConnected).toBe(true);
});
