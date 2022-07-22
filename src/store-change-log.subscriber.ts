// tslint:disable: no-console
import { EntitySubscriberInterface, EventSubscriber, InsertEvent, RemoveEvent, TransactionCommitEvent } from 'typeorm';
import { StoreChangeLog } from './models/store-change-log.model';
import { CloudStore } from './cloud/cloud-store';

@EventSubscriber()
export class StoreChangeLogSubscriber implements EntitySubscriberInterface<StoreChangeLog> {
  constructor(public cloud: CloudStore) {}

  listenTo() {
    return StoreChangeLog;
  }

  afterInsert(event: InsertEvent<StoreChangeLog>): Promise<any> | void {
    event.queryRunner.data = { insert: true };
  }

  afterTransactionCommit(event: TransactionCommitEvent): Promise<any> | void {
    if (this.cloud?.network) {
      if (event.queryRunner.data.insert) {
        event.queryRunner.data = { insert: false };
        return this.cloud.updateCloudFromChangeLog();
      }
    } else {
      // console.log('[StoreChangeLogSubscriber - afterTransactionCommit] No cloud, or network, not updating...', this.cloud);
    }
  }
}
