// tslint:disable: no-console
import {EntitySubscriberInterface, EventSubscriber, InsertEvent, TransactionCommitEvent} from 'typeorm';
import { StoreChangeLog } from './models/store-change-log.model';
import { CloudStore } from './cloud/cloud-store';

@EventSubscriber()
export class StoreChangeLogSubscriber implements EntitySubscriberInterface<StoreChangeLog> {
  constructor(public cloud: CloudStore) {}

  listenTo() {
    return StoreChangeLog;
  }

  afterTransactionCommit(event: TransactionCommitEvent): Promise<any> | void {
    if (this.cloud?.network) {
      console.log('[StoreChangeLogSubscriber - afterTransactionCommit]', this.cloud.network, event);
      return this.cloud.updateCloudFromChangeLog();
    } else {
      console.log('[StoreChangeLogSubscriber - afterTransactionCommit] No cloud, or network, not updating...', this.cloud);
    }
  }
}
