import {EntitySubscriberInterface, EventSubscriber, InsertEvent, TransactionCommitEvent, UpdateEvent} from 'typeorm/browser';
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
        // Fire-and-forget, NOT `return`: TypeORM awaits a promise returned from a subscriber, so
        // returning this would block every local commit on a full cloud round-trip — the opposite of
        // local-first. The StoreChangeLog rows persist the pending work (and updateCloudFromChangeLog
        // guards its own re-entrancy), so pushing in the background only changes WHEN the cloud
        // catches up, never WHETHER it does.
        void Promise.resolve(this.cloud.updateCloudFromChangeLog())
          .catch(e => console.warn('[StoreChangeLogSubscriber] background cloud push failed', e));
      }
    } else {
      console.debug('[StoreChangeLogSubscriber - afterTransactionCommit] No cloud, or network, not updating...', this.cloud);
    }
  }
}
