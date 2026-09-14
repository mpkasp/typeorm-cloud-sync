// tslint:disable: no-console
import { StoreRecord } from './models/store-record.model';
import { StoreChangeLog } from './models/store-change-log.model';
import { Meta } from './models/meta.model';

import { DataSource, EntityManager, SaveOptions } from 'typeorm/browser';
import { BaseUser } from './models/base-user.model';

export class SqliteStore {
  readonly dataSource: DataSource;

  constructor(
    dataSource: DataSource,
    public UserModel: typeof BaseUser,
  ) {
    this.dataSource = dataSource;
  }

  // Every persistence call in the library goes through this manager rather than the entity classes'
  // globally bound DataSource, so a store only ever reads and writes its own database.
  public get manager(): EntityManager {
    return this.dataSource.manager;
  }

  public async resolve(cloudRecord: StoreRecord, localRecord?: StoreRecord | null): Promise<StoreRecord | null> {
    // console.log('[CloudSync - SqliteStore - resolve]', localRecord, cloudRecord);
    // A store that fails is thrown, not swallowed: the caller (CloudStore.applyDelivery) must not
    // advance the cursor past a record that is not on the device.
    if (!localRecord) {
      console.debug('[CloudSync - SqliteStore - resolve] no local record - need to update from cloud', cloudRecord);
      return await this.saveRecord(cloudRecord, false);
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
        // Read the change-log row(s) before touching anything, then delete by id+version in the
        // same transaction as the cloud save — the drain's shape (T3/T4). If a local edit lands
        // between the read above and here, the version has moved on and the delete affects nothing:
        // that edit is newer than this comparison, so the cloud copy is discarded and the local
        // record stays queued rather than being overwritten.
        // resolve() is only reached through CloudStore.resolveRecords, which already holds the
        // per-DataSource lock (T4) for the whole page; a second serializeLocalTransaction here
        // would wait on the chain slot this same call occupies and deadlock.
        const changeLogs = await StoreChangeLog.getFromRecordWithManager(this.manager, localRecord);
        return await this.manager.transaction(async (manager) => {
          const deletions = await Promise.all(
            changeLogs.map((changeLog) =>
              manager
                .createQueryBuilder()
                .delete()
                .from(StoreChangeLog)
                .where('id = :id AND version = :version', { id: changeLog.id, version: changeLog.version })
                .execute(),
            ),
          );
          if (changeLogs.length > 0 && !deletions.some((result) => result.affected === 1)) {
            return null;
          }
          // Routed through saveRecord (not the transaction's `manager` directly) so callers that
          // spy on it to observe/gate a cloud-origin write — the drain does the same — see this one
          // too. sqljs/Capacitor hand every EntityManager the same query runner (see
          // local-transaction-lock.ts), so this still executes inside the transaction above.
          return this.saveRecord(cloudRecord, false);
        });
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
    // A save with updateChangeLog false is always cloud-origin data, not a local edit: listeners off
    // keeps the @BeforeInsert/@BeforeUpdate hooks from stamping the local write time over the
    // timestamps the cloud document carries (see resolveRecordsLocked's bulk save).
    const options: SaveOptions = updateChangeLog ? {} : { listeners: false };
    return await record.saveWithManager(this.manager, options, updateChangeLog);
  }

  // Clears the change log and the private download cursors, so the next account to sign in downloads
  // its private collections from the start.
  public async dropPrivateTypeOrmCloudSyncRecords() {
    await this.dataSource.createQueryBuilder().delete().from(StoreChangeLog).execute();
    await this.dataSource.createQueryBuilder().delete().from(Meta).where('isPrivate = 1').execute();
  }

  public async dropPrivateRecords(recordName: typeof StoreRecord) {
    return this.dataSource.createQueryBuilder().delete().from(recordName).where('isPrivate = 1').execute();
  }
}
