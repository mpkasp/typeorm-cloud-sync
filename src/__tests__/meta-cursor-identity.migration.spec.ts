import initSqlJs from 'sql.js';
import { DataSource } from 'typeorm/browser';
import { Meta, MetaCursorIdentity1789400000000 } from '../index';

test('MetaCursorIdentity rekeys a meta table created before cursors on (collection, isPrivate)', async () => {
  const dataSource = new DataSource({
    type: 'sqljs',
    driver: await initSqlJs(),
    logging: false,
    entities: [Meta],
    migrations: [MetaCursorIdentity1789400000000],
  });
  await dataSource.initialize();
  await dataSource.query(
    `CREATE TABLE "meta" ("collection" varchar PRIMARY KEY NOT NULL, "changeId" integer NOT NULL, "isPrivate" boolean NOT NULL)`,
  );

  await dataSource.runMigrations();
  await dataSource.getRepository(Meta).save([new Meta('Note', true, 3), new Meta('Note', false, 5)]);

  await expect(dataSource.getRepository(Meta).count()).resolves.toBe(2);
  await expect(dataSource.driver.createSchemaBuilder().log()).resolves.toMatchObject({ upQueries: [] });
  await dataSource.destroy();
});
