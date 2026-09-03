import { Column, DataSource, Entity, EntityTarget, Repository } from 'typeorm/browser';
import initSqlJs from 'sql.js';
import { StoreRecord } from '../models/store-record.model';
import { StoreChangeLog } from '../models/store-change-log.model';
import { BaseUser } from '../models/base-user.model';

// Concrete StoreRecord subclasses for the characterization tests. Both declare an explicit
// `storeName`, as production entities must, so change-log rows and cloud paths do not depend on the
// (bundler-manglable) class name.

// Apps subclass BaseUser (Daily's `User`); `storeName` must resolve to 'User' or the record does
// not land on the auth-keyed cloud document.
@Entity({ name: 'user' })
export class User extends BaseUser {
  static storeName = 'User';
}

@Entity({ name: 'note' })
export class Note extends StoreRecord {
  static storeName = 'Note';

  @Column({ nullable: true })
  text?: string;

  constructor(init?: Partial<any>) {
    super(init);
    Object.assign(this, init);
  }
}

@Entity({ name: 'tag' })
export class Tag extends StoreRecord {
  static storeName = 'Tag';

  @Column({ nullable: true })
  label?: string;

  constructor(init?: Partial<any>) {
    super(init);
    Object.assign(this, init);
  }
}

// The package ships the TypeORM browser build (see typeorm-browser-build-gotcha), so tests use the
// in-memory `sqljs` driver with an injected sql.js module rather than a Node driver.
export async function createTestDataSource(
  entities: EntityTarget<any>[],
  subscribers: Function[] = [],
): Promise<DataSource> {
  const SQL = await initSqlJs();
  const dataSource = new DataSource({
    type: 'sqljs',
    driver: SQL,
    dropSchema: true,
    logging: false,
    synchronize: true,
    entities: entities as any,
    subscribers: subscribers as any,
  });
  await dataSource.initialize();
  return dataSource;
}

// The library logs on every save/resolve; keep test output readable without hiding warnings.
export function silenceLibraryLogs() {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'debug').mockImplementation(() => undefined);
}

// Assertions read the change log through a repository rather than the ActiveRecord statics under
// test, so they keep working once those statics move to per-tenant managers.
export function changeLogs(dataSource: DataSource): Repository<StoreChangeLog> {
  return dataSource.getRepository(StoreChangeLog);
}
