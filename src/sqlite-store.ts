// tslint:disable: no-console
import { StoreRecord } from './models/store-record.model';
import { StoreChangeLog } from './models/store-change-log.model';

import { DataSource } from 'typeorm';
import { BaseUser } from './models/base-user.model';

export class SqliteStore {
  readonly dataSource: DataSource;

  constructor(dataSource: DataSource, public UserModel: typeof BaseUser) {
    this.dataSource = dataSource;
  }

  public async resolve(cloudRecord: StoreRecord, localRecord?: StoreRecord | null): Promise<StoreRecord | null> {
    // console.log('[CloudSync - SqliteStore - resolve]', localRecord, cloudRecord);
    if (!localRecord) {
      console.log('[CloudSync - SqliteStore - resolve] no local record - need to update from cloud', cloudRecord);
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
        console.log(
          '[CloudSync - SqliteStore - resolve] server record is newer - use the server record',
          localRecord,
          cloudRecord,
        );
        try {
          const record = await this.saveRecord(cloudRecord, false);
          const changeLogs = await StoreChangeLog.getFromRecord(localRecord);
          // @ts-ignore
          await StoreChangeLog.remove(changeLogs);
          return record;
        } catch (e) {
          console.warn('[CloudSync - SqliteStore - resolve] unable to insert record', cloudRecord, e);
          return null;
        }
      } else {
        // local record is newer - use the local record
        console.log(
          '[CloudSync - SqliteStore - resolve] local record is newer - use the local record',
          localRecord,
          cloudRecord,
        );
        await localRecord.updateChangeLog();
        return Promise.resolve(localRecord);
      }
    }
    // Do nothing if localRecord == cloudRecord
    return null;
  }

  public async saveRecord(record: StoreRecord, updateChangeLog: boolean = true): Promise<StoreRecord> {
    return await record.save({}, updateChangeLog);
  }

  public async dropPrivateTypeOrmCloudSyncRecords() {
    await this.dataSource.createQueryBuilder().delete().from(StoreChangeLog).execute();
  }

  public async dropPrivateRecords(recordName: typeof StoreRecord) {
    return this.dataSource.createQueryBuilder().delete().from(recordName).where('isPrivate = 1').execute();
  }
}
