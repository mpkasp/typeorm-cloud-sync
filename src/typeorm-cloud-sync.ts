import { Connection } from 'typeorm';
import { CloudStore } from './cloud/cloud-store';
import { User } from './models/user.model';
import { SqliteStore } from './sqlite-store';

export class TypeormCloudSync {
  readonly userModel: typeof User;
  readonly sqliteStore: SqliteStore;
  protected cloudStore?: CloudStore;

  constructor(private connection: Connection, userModel: typeof User = User) {
    this.sqliteStore = new SqliteStore(connection, userModel);
    this.userModel = userModel;
  }

  initializeCloudStore(cloudStore: CloudStore) {
    this.cloudStore = cloudStore;
  }
}
