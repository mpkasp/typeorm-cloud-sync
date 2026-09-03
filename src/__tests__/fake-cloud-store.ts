import { Observable } from 'rxjs';
import { CloudStore } from '../cloud/cloud-store';
import { SqliteStore } from '../sqlite-store';
import { StoreRecord } from '../models/store-record.model';
import { BaseUser } from '../models/base-user.model';
import { storeNameOf } from '../models/store-name';
import { PathBuilder } from '../cloud/firebase/protocol/path-builder';
import { StoreRecordWriter } from '../cloud/firebase/protocol/store-record-writer';
import { VersionedRecord } from '../cloud/firebase/protocol/firestore-port';
import { FakeFirestorePort } from '../cloud/firebase/protocol/__tests__/fake-firestore-port';

// A CloudStore whose cloud is the in-memory FakeFirestorePort, running the same PathBuilder +
// StoreRecordWriter protocol CloudFirebaseFirestore runs. Cloud subscriptions are recorded rather
// than opened, so CloudStore's orchestration can be exercised without a Firebase app or a browser.
export class FakeCloudStore extends CloudStore {
  readonly port = new FakeFirestorePort();
  // Every subscribe/unsubscribe/write the orchestration performs, in order.
  readonly calls: string[] = [];
  private readonly paths = new PathBuilder(() => this.user?.authId);
  private readonly writer = new StoreRecordWriter(this.port, this.paths);

  constructor(
    UserModel: typeof BaseUser,
    publicRecords: (typeof StoreRecord)[],
    privateRecords: (typeof StoreRecord)[],
    network$: Observable<boolean>,
  ) {
    super(UserModel, publicRecords, privateRecords, network$);
  }

  public async initialize(localStore: SqliteStore) {
    await this._initializeBase(localStore);
  }

  public async create(obj: StoreRecord) {
    return this.port.setDoc(this.paths.documentPath(this.target(obj)), obj.raw());
  }

  public async update(obj: StoreRecord) {
    return this.port.setDoc(this.paths.documentPath(this.target(obj)), obj.raw(), { merge: true });
  }

  public async delete(obj: StoreRecord, fromDb: boolean = false) {
    if (fromDb) {
      return this.port.deleteDoc(this.paths.documentPath(this.target(obj)));
    }
    obj.isDeleted = true;
    return this.updateStoreRecord(obj);
  }

  // Mirrors CloudFirebaseFirestore.updateStoreRecord, including the seedChangeId callback.
  public async updateStoreRecord(obj: StoreRecord): Promise<StoreRecord> {
    this.calls.push(`update:${storeNameOf(obj)}`);
    await this.writer.updateStoreRecord(this.asVersioned(obj), {
      seedChangeId: () =>
        StoreRecord.getLatestChangeId(
          this.localStore.dataSource,
          { type: obj as any, name: storeNameOf(obj) },
          storeNameOf(obj),
          obj.isPrivate,
        ),
    });
    return obj;
  }

  protected deserialize(document: any): any {
    return document;
  }

  protected async subscribePublicCloud(): Promise<any> {
    this.publicRecords.forEach((record) => this.calls.push(`subscribePublic:${storeNameOf(record)}`));
  }

  protected async subscribePrivateCloud(): Promise<any> {
    if (this.privateCloudInitialized) {
      return;
    }
    this.privateRecords.forEach((record) => this.calls.push(`subscribePrivate:${storeNameOf(record)}`));
    this.privateCloudInitialized = true;
  }

  protected unsubscribePrivateCloud(): any {
    this.privateCloudInitialized = false;
    this.calls.push('unsubscribePrivateCloud');
  }

  protected async subscribeRecord(recordName: typeof StoreRecord, isPrivate: boolean): Promise<any> {
    this.calls.push(`subscribe:${storeNameOf(recordName)}`);
  }

  protected unsubscribeRecord(recordName: typeof StoreRecord): any {
    this.calls.push(`unsubscribe:${storeNameOf(recordName)}`);
  }

  private target(obj: StoreRecord) {
    return {
      storeName: storeNameOf(obj),
      isPrivate: obj.isPrivate,
      id: obj.id as string,
      authId: (obj as any).authId,
    };
  }

  private asVersioned(obj: StoreRecord): VersionedRecord {
    return {
      ...this.target(obj),
      get changeId() {
        return obj.changeId;
      },
      set changeId(v: number) {
        obj.changeId = v;
      },
      get recordChangeTimestamp() {
        return obj.recordChangeTimestamp;
      },
      set recordChangeTimestamp(v: Date) {
        obj.recordChangeTimestamp = v;
      },
      raw: () => obj.raw(),
    };
  }
}
