// tslint:disable: no-console
import { EntitySubscriberInterface, EventSubscriber, InsertEvent } from 'typeorm';
import { StoreChangeLog } from './models/store-change-log.model';
import { CloudStore } from './cloud/cloud-store';

@EventSubscriber()
export class StoreChangeLogSubscriber implements EntitySubscriberInterface<StoreChangeLog> {
  constructor(public cloud: CloudStore) {}

  listenTo() {
    return StoreChangeLog;
  }

  afterInsert(event: InsertEvent<StoreChangeLog>) {
    // Cloud push should be attempted if we're authenticated and have internet
    // If we don't have internet, don't try to push
    // Retry on two events: when app opens (done), or when we have internet (to do)
    if (this.cloud.network) {
      console.log('[afterInsert]', this.cloud.network, event);
      return this.cloud.updateCloudFromChangeLog();
    } else {
      console.log('[afterInsert] No network, not updating...', this.cloud.network);
    }
  }
}
