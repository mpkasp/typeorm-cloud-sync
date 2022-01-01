import {Connection, EntitySubscriberInterface, InsertEvent, RemoveEvent, UpdateEvent} from 'typeorm';
import {BaseUser} from './models/base-user.model';
import { CloudStore } from './cloud/cloud-store';

export class UserSubscriber implements EntitySubscriberInterface<BaseUser> {
  constructor(public UserModel: typeof BaseUser, public cloudStore: CloudStore) {}

  listenTo() {
    return this.UserModel;
  }

  afterInsert(event: InsertEvent<BaseUser>): Promise<any> | void {
    const user = event.entity;
    this.cloudStore.userSubject.next(user);
  }

  afterUpdate(event: UpdateEvent<BaseUser>) {
    const user = event.databaseEntity;
    this.cloudStore.userSubject.next(user);
  }
}
