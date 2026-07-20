import { BaseEntity, Column, DataSource, Entity, EntityManager, PrimaryGeneratedColumn } from 'typeorm/browser';
import { StoreRecord } from './store-record.model';
import { storeNameOf } from './store-name';

@Entity({ name: 'storechangelog' })
export class StoreChangeLog extends BaseEntity {
  // When a record is changed locally, it is added to a change log.  Only the most recent change to a record is kept in the change log.
  @PrimaryGeneratedColumn('uuid')
  id?: string;

  @Column()
  recordId: string;

  @Column()
  tableName: string;

  constructor(tableName: string, recordId: string) {
    super();
    this.recordId = recordId;
    this.tableName = tableName;
  }

  public static newFromRecord(storeRecord: StoreRecord) {
    return new StoreChangeLog(storeNameOf(storeRecord), storeRecord.id!);
  }

  public static getFromRecord(storeRecord: StoreRecord): Promise<StoreChangeLog[]> {
    // @ts-ignore
    return StoreChangeLog.find({ where: { recordId: storeRecord.id, tableName: storeNameOf(storeRecord) } });
  }

  // Resolve the entity class for this change-log row's store name.
  //
  // `tableName` holds the record's *store name* (from storeNameOf) — a stable
  // literal like 'User'/'Dosage', NOT a TypeORM table/entity name. We cannot
  // hand that string to getRepository(): bundlers (esbuild/Angular) mangle
  // class names, so EntityMetadata.name no longer equals the stored store name,
  // and the declared table name is lower-cased ('user'). Instead, match the
  // store name against each registered entity's storeNameOf and use the class.
  private resolveTarget(entityMetadatas: readonly { target: string | Function }[]): string | Function | undefined {
    return entityMetadatas.find((m) => storeNameOf(m.target) === this.tableName)?.target;
  }

  public async getRecord(dataSource: DataSource): Promise<StoreRecord | null> {
    const target = this.resolveTarget(dataSource.entityMetadatas);
    if (!target) {
      return null;
    }
    return (await dataSource.getRepository(target).findOne({
      where: {
        id: this.recordId,
      },
      order: {
        changeId: 'DESC'
      }
    })) as StoreRecord;
  }

  public async getRecordWithManager(manager: EntityManager): Promise<StoreRecord | null> {
    const target = this.resolveTarget(manager.connection.entityMetadatas);
    if (!target) {
      return null;
    }
    return (await manager.getRepository(target).findOne({
      where: {
        id: this.recordId,
      },
      order: {
        changeId: 'DESC'
      }
    })) as StoreRecord;
  }
}
