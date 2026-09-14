import { Column, Entity, PrimaryColumn } from 'typeorm/browser';

// A collection's download cursor: the highest changeId the cloud has delivered and this device has
// applied. Only cloud deliveries advance it (CloudStore.advanceCursor); an upload's changeId never does.
@Entity({ name: 'meta' })
export class Meta {
  @PrimaryColumn()
  public collection: string;

  @PrimaryColumn({ type: 'boolean' })
  public isPrivate: boolean;

  @Column({ nullable: false })
  public changeId: number;

  constructor(collection: string, isPrivate: boolean, changeId: number) {
    this.collection = collection;
    this.isPrivate = isPrivate;
    this.changeId = changeId;
  }
}
