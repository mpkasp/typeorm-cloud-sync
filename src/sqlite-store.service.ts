import {StoreRecord} from './models/store-record.model';
import {StoreChangeLog} from './models/store-change-log.model';

import {BehaviorSubject, Observable} from 'rxjs';
import {Connection} from 'typeorm';
import {flatMap, map, take} from 'rxjs/operators';

export abstract class SqliteStoreService {
  public connection?: Connection;
  private foodEntryId?: string;

  public async init(connection: Connection) {
    this.connection = connection;
    await this.initObservers();
  }

  public abstract initObservers(): Promise<any>;

  public async resolve(cloudRecord: StoreRecord, localRecord?: StoreRecord): Promise<StoreRecord | null> {
    // console.log(localRecord, cloudRecord);
    if (!localRecord) {
      console.log('[resolve] no local record - update from cloud', cloudRecord);
      try {
        return await this.saveRecord(cloudRecord, false);
      } catch (e) {
        console.warn('[resolve] unable to insert record', cloudRecord);
        console.warn(e);
        return null;
      }
    } else if (localRecord.updated?.getTime() !== cloudRecord.updated?.getTime()) {
      const cloudTime = cloudRecord.updated ? cloudRecord.updated.getTime() : 0;
      const localTime = localRecord.updated.getTime();
      // console.log(localTime, cloudTime);
      if (cloudTime >= localTime) {
        // server record is newer - use the server record
        console.log('[resolve] server record is newer - use the server record', localRecord, cloudRecord);
        try {
          const record = await this.saveRecord(cloudRecord, false);
          const changeLogs = await StoreChangeLog.getFromRecord(localRecord);
          await StoreChangeLog.remove(changeLogs);
          return record;
        } catch (e) {
          console.warn('[resolve] unable to insert record', cloudRecord, e);
          return null;
        }
      } else {
        // local record is newer - use the local record
        console.log('[resolve] local record is newer - use the local record', localRecord, cloudRecord);
        await localRecord.updateChangeLog();
        return Promise.resolve(localRecord);
      }
    }
    // Do nothing if localRecord == cloudRecord
    return null;
  }

  public async saveRecord(record: StoreRecord, updateChangeLog: boolean = true): Promise<StoreRecord> {
    return await record.save({}, updateChangeLog);;
  }
}
