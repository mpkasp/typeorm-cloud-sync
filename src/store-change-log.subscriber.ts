import {EntitySubscriberInterface, EventSubscriber, InsertEvent, TransactionCommitEvent, UpdateEvent} from 'typeorm';
import { StoreChangeLog } from './models/store-change-log.model';
import { CloudStore } from './cloud/cloud-store';

@EventSubscriber()
export class StoreChangeLogSubscriber implements EntitySubscriberInterface<StoreChangeLog> {
  constructor(public cloud: CloudStore) {}

  listenTo() {
    return StoreChangeLog;
  }

  afterInsert(event: InsertEvent<StoreChangeLog>): Promise<any> | void {
    // console.log('[StoreChangeLogSubscriber - afterInsert]', event.queryRunner.isTransactionActive, event);
    event.queryRunner.data = { StoreChangeLog: { insert: true }};
  }

  afterUpdate(event: UpdateEvent<StoreChangeLog>): Promise<any> | void {
    // console.log('[StoreChangeLogSubscriber - afterUpdate]', event.queryRunner.isTransactionActive, event);
    event.queryRunner.data = { StoreChangeLog: { update: true }};
  }

  afterTransactionCommit(event: TransactionCommitEvent): Promise<any> | void {
    // console.log('[StoreChangeLogSubscriber - afterTransactionCommit]', this.cloud, event);
    if (this.cloud?.network) {
      if (event.queryRunner.data.StoreChangeLog?.insert || event.queryRunner.data.StoreChangeLog?.update) {
        event.queryRunner.data.StoreChangeLog.insert =  false;
        return this.cloud.updateCloudFromChangeLog();
      }
    } else {
      console.log('[StoreChangeLogSubscriber - afterTransactionCommit] No cloud, or network, not updating...', this.cloud);
    }
  }
}
