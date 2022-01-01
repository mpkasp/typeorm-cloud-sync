import {Connection, EntitySubscriberInterface, InsertEvent, RemoveEvent, UpdateEvent} from 'typeorm';
import {User} from './models/user.model';
import { CloudStore } from './cloud/cloud-store';

export class UserSubscriber implements EntitySubscriberInterface<User> {
  constructor(public UserModel: typeof User, public cloudStore: CloudStore) {}

  listenTo() {
    return this.UserModel;
  }

  afterInsert(event: InsertEvent<User>): Promise<any> | void {
    const user = event.entity;
    this.cloudStore.userSubject.next(user);
  }

  afterUpdate(event: UpdateEvent<User>) {
    const user = event.databaseEntity;
    this.cloudStore.userSubject.next(user);
  }
}
