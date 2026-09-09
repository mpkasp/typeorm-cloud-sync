import {
  BaseEntity,
  BeforeInsert,
  BeforeUpdate,
  Column, DataSource,
  EntityManager,
  EntitySchema,
  Index,
  ObjectType,
  PrimaryGeneratedColumn,
  SaveOptions,
} from 'typeorm/browser';
import { StoreChangeLog } from './store-change-log.model';
import {EntityTarget} from 'typeorm/browser';
import { storeNameOf } from './store-name';
import { activeRecordManager } from './active-record';

// Narrow whatever a caller passed — a class, an instance, or a `{type, name}` descriptor wrapping
// either — down to a valid repository target. A string name, class, or EntitySchema is already one;
// only a record instance needs narrowing to its constructor.
function entityClassOf(target: any): any {
  const candidate = target && typeof target === 'object' && 'type' in target ? target.type : target;
  if (typeof candidate === 'string' || typeof candidate === 'function' || candidate instanceof EntitySchema) {
    return candidate;
  }
  return candidate?.constructor;
}

export abstract class StoreRecord extends BaseEntity {
  // Stable storage identity, immune to class-name mangling by bundlers.
  // Concrete entities override this with a string literal (see storeNameOf).
  static storeName?: string;

  recordChangeTimestamp: Date = new Date();

  @PrimaryGeneratedColumn('uuid')
  id?: string;

  @Index()
  @Column({ type: 'boolean' })
  isDeleted: boolean = false;

  @Column()
  changeId: number = 1;

  @Column()
  protected createdMs?: number;

  @Column()
  protected updatedMs?: number;

  @Index()
  @Column({ type: 'boolean' })
  isPrivate: boolean = true;

  protected constructor(init?: Partial<any>) {
    super();
    if (init?.hasOwnProperty('created')) {
      delete init.created;
    }
    Object.assign(this, init);
  }

  // Resolve the repository from the entity class with a fixed query alias.
  //
  // TypeORM matches a string / `{name}` target against the entity's class name or table name — never
  // against `storeName`. Since a production build mangles class names, callers pass a mix of classes,
  // instances and `{type, name}` descriptors; `entityClassOf` normalises them to a target the
  // repository can resolve regardless of mangling.
  static async getLatestRecord(dataSource: DataSource, obj: EntityTarget<StoreRecord>, isPrivate: boolean) {
    const alias = 'record';
    const query = dataSource.getRepository(entityClassOf(obj))
        .createQueryBuilder(alias)
        .where(`${alias}.isPrivate = :isPrivate`, { isPrivate: isPrivate ? 1 : 0 })
        .orderBy(`${alias}.changeId`, 'DESC');
    return await query.getOne();
  }

  static async getLatestChangeId(dataSource: DataSource, obj: EntityTarget<StoreRecord>, isPrivate: boolean): Promise<number> {
    const latestObj = (await this.getLatestRecord(dataSource, obj, isPrivate)) as StoreRecord;
    return latestObj ? latestObj.changeId : 0;
  }

  static async saveAllWithManager<T extends BaseEntity>(
    this: ObjectType<T>,
    manager: EntityManager,
    entities: T[],
    options?: SaveOptions,
  ): Promise<T[]> {
    const saved = await manager.save(entities, options);
    for (const record of saved as unknown as StoreRecord[]) {
      await record.updateChangeLogWithManager(manager);
    }
    return saved;
  }

  static async save<T extends BaseEntity>(this: ObjectType<T>, entities: T[], options?: SaveOptions): Promise<any[]> {
    return (this as any).saveAllWithManager(activeRecordManager(this as Function), entities, options);
  }

  @BeforeInsert()
  private updateCreatedMs() {
    this.createdMs = new Date().getTime();
    this.updatedMs = new Date().getTime();
  }

  @BeforeUpdate()
  private updateUpdatedMs() {
    this.updatedMs = new Date().getTime();
  }

  get created(): Date | undefined {
    return this.createdMs ? new Date(this.createdMs) : undefined;
  }

  get updated(): Date | undefined {
    return this.updatedMs ? new Date(this.updatedMs) : undefined;
  }

  raw(includeId: boolean = false): any {
    const clone = Object.assign({}, this);
    if (!includeId) {
      delete clone.id;
    }
    Object.keys(clone).forEach((key: string) => {
      // @ts-ignore
      if (clone[key] === undefined) {
        // @ts-ignore
        delete clone[key];
        // console.log('deleted ', key);
      }
    });
    // console.log('[raw]', clone);
    return clone;
  }

  describe(): string[] {
    return Object.getOwnPropertyNames(this);
  }

  properties(): string[] {
    const props = Object.getOwnPropertyNames(this).sort();
    // @ts-ignore
    props.filter((prop) => typeof props[prop] !== 'function');
    return props;
  }

  orderBy(): string {
    return 'changeId';
  }

  orderByDirection(reverse?: boolean): string {
    return reverse ? 'asc' : 'desc';
  }

  // Queue this record for upload by adding a change-log row via the given manager. Only the most
  // recent change to a record is kept, so an existing row is left in place.
  async updateChangeLogWithManager(manager: EntityManager): Promise<StoreChangeLog> {
    const existingChangeLog = await manager.getRepository(StoreChangeLog).findOneBy({
      tableName: storeNameOf(this),
      recordId: this.id,
    });
    if (existingChangeLog) {
      return existingChangeLog;
    }
    return manager.save(new StoreChangeLog(storeNameOf(this), this.id!));
  }

  async updateChangeLog(): Promise<StoreChangeLog> {
    return this.updateChangeLogWithManager(activeRecordManager(this.constructor));
  }

  async saveWithManager(manager: EntityManager, options?: SaveOptions, updateChangeLog: boolean = true): Promise<this> {
    console.debug('[save]', this, updateChangeLog, options);
    const savedRecord = await manager.save(this, options);
    if (updateChangeLog) {
      await this.updateChangeLogWithManager(manager);
    }
    return savedRecord;
  }

  async save(options?: SaveOptions, updateChangeLog: boolean = true): Promise<this> {
    return this.saveWithManager(activeRecordManager(this.constructor), options, updateChangeLog);
  }
}
