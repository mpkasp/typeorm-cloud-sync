import {
    AfterInsert,
    BaseEntity,
    Column, Connection, Entity, PrimaryGeneratedColumn,
} from 'typeorm';
import {StoreRecord} from './store-record.model';

@Entity({name: 'storechangelog'})
export class StoreChangeLog extends BaseEntity {
    // When a record is changed locally, it is added to a change log.  Only the most recent change to a record is kept in the change log.
    @PrimaryGeneratedColumn('uuid')
    id?: string;

    @Column()
    recordId: string;

    @Column()
    tableName: string;

    constructor(tableName: string, recordId: string) {
        super();
        this.recordId = recordId;
        this.tableName = tableName;
    }

    public static newFromRecord(storeRecord: StoreRecord) {
        return new StoreChangeLog(storeRecord.constructor.name, storeRecord.id);
    }

    public static getFromRecord(storeRecord: StoreRecord): Promise<StoreChangeLog[]> {
        return StoreChangeLog.find({ where: {recordId: storeRecord.id, tableName: storeRecord.constructor.name}});
    }

    public async getRecord(connection: Connection): Promise<StoreRecord> {
        return await connection.getRepository(this.tableName).findOne(this.recordId) as StoreRecord;
    }
}
