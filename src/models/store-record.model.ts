import {
  BaseEntity,
  BeforeInsert,
  BeforeUpdate,
  Column,
  ObjectType,
  PrimaryGeneratedColumn,
  SaveOptions,
} from 'typeorm';
import { StoreChangeLog } from './store-change-log.model';

export abstract class StoreRecord extends BaseEntity {
  recordChangeTimestamp: Date = new Date();

  @PrimaryGeneratedColumn('uuid')
  id?: string;

  @Column({ type: 'boolean' })
  isDeleted: boolean = false;

  @Column()
  changeId: number = 1;

  @Column()
  protected createdMs?: number;

  @Column()
  protected updatedMs?: number;

  @Column({ type: 'boolean' })
  isPrivate: boolean = true;

  protected constructor(init?: Partial<any>) {
    super();
    if (init?.hasOwnProperty('created')) {
      delete init.created;
    }
    Object.assign(this, init);
  }

  static async getLatestRecord() {
    return await this.createQueryBuilder(this.name).orderBy('changeId', 'DESC').getOne();
  }

  static async getLatestChangeId(): Promise<number> {
    const latestObj = await this.getLatestRecord();
    return latestObj ? latestObj.changeId : 0;
  }

  static async save<T extends BaseEntity>(this: ObjectType<T>, entities: T[], options?: SaveOptions): Promise<any[]> {
    const es = (await super.save(entities, options)) as StoreRecord[];
    for (const e of es) {
      await e.updateChangeLog();
    }
    return Promise.resolve(es);
  }

  @BeforeInsert()
  private updateCreatedMs() {
    this.createdMs = new Date().getTime();
    this.updatedMs = new Date().getTime();
  }

  @BeforeUpdate()
  private updateUpdatedMs() {
    this.updatedMs = new Date().getTime();
  }

  get created(): Date | undefined {
    return this.createdMs ? new Date(this.createdMs) : undefined;
  }

  get updated(): Date | undefined {
    return this.updatedMs ? new Date(this.updatedMs) : undefined;
  }

  raw(includeId: boolean = false): any {
    const clone = Object.assign({}, this);
    if (!includeId) {
      delete clone.id;
    }
    Object.keys(clone).forEach((key: string) => {
      // @ts-ignore
      if (clone[key] === undefined) {
        // @ts-ignore
        delete clone[key];
        // console.log('deleted ', key);
      }
    });
    // console.log('[raw]', clone);
    return clone;
  }

  describe(): string[] {
    return Object.getOwnPropertyNames(this);
  }

  properties(): string[] {
    const props = Object.getOwnPropertyNames(this).sort();
    // @ts-ignore
    props.filter((prop) => typeof props[prop] !== 'function');
    return props;
  }

  orderBy(): string {
    return 'changeId';
  }

  orderByDirection(reverse?: boolean): string {
    return reverse ? 'asc' : 'desc';
  }

  async updateChangeLog(): Promise<StoreChangeLog> {
    const existingChangeLog = await StoreChangeLog.findOne({
      where: { tableName: this.constructor.name, recordId: this.id },
    });
    // console.log(existingChangeLog);
    if (!existingChangeLog) {
      // console.log(`[updateChangeLog] change log doesnt exist, making a new one ${this.constructor.name}, ${this.id}`);
      return await new StoreChangeLog(this.constructor.name, this.id!).save();
    } else {
      // console.log(`[updateChangeLog] change log exists, skipping making a new one ${this.constructor.name}, ${this.id}`);
    }
    return existingChangeLog;
  }

  async save(options?: SaveOptions, updateChangeLog: boolean = true): Promise<this> {
    // console.log(this, updateChangeLog, options);
    const savedRecord = await super.save(options);
    if (updateChangeLog) {
      // console.log('[save] saving store record, update change log:', updateChangeLog);
      // Removed await from update change log - this speeds things up in the ui nicely, but it may affect function. Be aware!
      await this.updateChangeLog();
    }
    return savedRecord;
  }
}
