// tslint:disable: no-console
import { StoreRecord } from './models/store-record.model';
import { StoreChangeLog } from './models/store-change-log.model';

import { DataSource, EntityManager } from 'typeorm/browser';
import { BaseUser } from './models/base-user.model';

export class SqliteStore {
  readonly dataSource: DataSource;

  constructor(dataSource: DataSource, public UserModel: typeof BaseUser) {
    this.dataSource = dataSource;
  }

  // Every persistence call in the library goes through this manager rather than the entity classes'
  // globally bound DataSource, so a store only ever reads and writes its own database.
  public get manager(): EntityManager {
    return this.dataSource.manager;
  }

  public async resolve(cloudRecord: StoreRecord, localRecord?: StoreRecord | null): Promise<StoreRecord | null> {
    // console.log('[CloudSync - SqliteStore - resolve]', localRecord, cloudRecord);
    if (!localRecord) {
      console.debug('[CloudSync - SqliteStore - resolve] no local record - need to update from cloud', cloudRecord);
      try {
        return await this.saveRecord(cloudRecord, false);
      } catch (e) {
        console.warn('[CloudSync - SqliteStore - resolve] unable to insert record', cloudRecord, e);
        return null;
      }
    } else if (localRecord.updated?.getTime() !== cloudRecord.updated?.getTime()) {
      const cloudTime = cloudRecord.updated ? cloudRecord.updated.getTime() : 0;
      const localTime = localRecord.updated?.getTime() || 0;
      // console.log(localTime, cloudTime);
      if (cloudTime >= localTime) {
        // server record is newer - use the server record
        console.debug(
          '[CloudSync - SqliteStore - resolve] server record is newer - use the server record',
          localRecord,
          cloudRecord,
        );
        try {
          const record = await this.saveRecord(cloudRecord, false);
          const changeLogs = await StoreChangeLog.getFromRecordWithManager(this.manager, localRecord);
          await this.manager.remove(changeLogs);
          return record;
        } catch (e) {
          console.warn('[CloudSync - SqliteStore - resolve] unable to insert record', cloudRecord, e);
          return null;
        }
      } else {
        // local record is newer - use the local record
        console.debug(
          '[CloudSync - SqliteStore - resolve] local record is newer - use the local record',
          localRecord,
          cloudRecord,
        );
        await localRecord.updateChangeLogWithManager(this.manager);
        return Promise.resolve(localRecord);
      }
    }
    // Do nothing if localRecord == cloudRecord
    return null;
  }

  public async saveRecord(record: StoreRecord, updateChangeLog: boolean = true): Promise<StoreRecord> {
    return await record.saveWithManager(this.manager, {}, updateChangeLog);
  }

  public async dropPrivateTypeOrmCloudSyncRecords() {
    await this.dataSource.createQueryBuilder().delete().from(StoreChangeLog).execute();
  }

  public async dropPrivateRecords(recordName: typeof StoreRecord) {
    return this.dataSource.createQueryBuilder().delete().from(recordName).where('isPrivate = 1').execute();
  }
}
