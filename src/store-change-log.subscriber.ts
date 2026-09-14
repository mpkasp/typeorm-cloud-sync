import {EntitySubscriberInterface, InsertEvent, QueryRunner, TransactionCommitEvent, UpdateEvent} from 'typeorm/browser';
import { StoreChangeLog } from './models/store-change-log.model';
import { CloudStore } from './cloud/cloud-store';

export class StoreChangeLogSubscriber implements EntitySubscriberInterface<StoreChangeLog> {
  constructor(public cloud: CloudStore) {}

  listenTo() {
    return StoreChangeLog;
  }

  afterInsert(event: InsertEvent<StoreChangeLog>): Promise<any> | void {
    // console.log('[StoreChangeLogSubscriber - afterInsert]', event.queryRunner.isTransactionActive, event);
    this.markChangeLog(event.queryRunner, 'insert');
  }

  afterUpdate(event: UpdateEvent<StoreChangeLog>): Promise<any> | void {
    // console.log('[StoreChangeLogSubscriber - afterUpdate]', event.queryRunner.isTransactionActive, event);
    this.markChangeLog(event.queryRunner, 'update');
  }

  // Mutates the runner's existing data object rather than replacing it: other subscribers share it, and
  // TypeORM restores the object reference it held before each save, which would discard a replacement
  // before a surrounding transaction commits.
  private markChangeLog(queryRunner: QueryRunner, kind: 'insert' | 'update') {
    queryRunner.data.StoreChangeLog = { ...queryRunner.data.StoreChangeLog, [kind]: true };
  }

  afterTransactionCommit(event: TransactionCommitEvent): Promise<any> | void {
    const changeLog = event.queryRunner.data.StoreChangeLog;
    if (!changeLog?.insert && !changeLog?.update) {
      return;
    }
    event.queryRunner.data.StoreChangeLog = { insert: false, update: false };
    // Fire-and-forget, NOT `return`: TypeORM awaits a promise returned from a subscriber, so
    // returning this would block every local commit on a full cloud round-trip — the opposite of
    // local-first. The StoreChangeLog rows persist the pending work, and updateCloudFromChangeLog
    // returns early offline and queues a pass when one is already running, so pushing in the
    // background only changes WHEN the cloud catches up, never WHETHER it does.
    void Promise.resolve(this.cloud.updateCloudFromChangeLog())
      .catch(e => console.warn('[StoreChangeLogSubscriber] background cloud push failed', e));
  }
}
