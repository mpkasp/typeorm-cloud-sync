import {BaseEntity, Column, Entity, PrimaryColumn} from 'typeorm';
import {StoreRecord} from './store-record.model';

@Entity({ name: 'meta' })
export class Meta extends BaseEntity {
    @PrimaryColumn()
    public collection: string;

    @Column({ nullable: false })
    public changeId: number = 0;

    @Column({nullable: false})
    public isPrivate: boolean = true;

    constructor(collection: string, changeId: number, isPrivate: boolean) {
        super();
        this.changeId = changeId;
        this.collection = collection;
        this.isPrivate = isPrivate;
    }

    static fromRecord(record: StoreRecord) {
        console.log('[Meta - fromRecord]', record.constructor.name, record.changeId, record.isPrivate, record);
        const collection = Meta.collectionFromName(record.constructor.name, record.isPrivate);
        return new Meta(collection, record.changeId, record.isPrivate);
    }

    static collectionFromName(name: string, isPrivate: boolean) {
        return isPrivate ? `User/${name}` : name;
    }
}
