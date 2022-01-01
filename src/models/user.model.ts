import {StoreRecord} from './store-record.model';
import {Column, Entity} from 'typeorm';

@Entity({name: 'user'})
export class User extends StoreRecord {
  @Column({nullable: true})
  public authId?: string | null = null;

  @Column({nullable: true})
  public email?: string;

  @Column({nullable: true})
  public displayName?: string;

  @Column({nullable: true})
  public photoURL?: string;

  @Column({nullable: true})
  public firstName?: string;

  @Column({nullable: true})
  public lastName?: string;

  constructor(init?: Partial<any>) {
    super(init);
    Object.assign(this, init);
  }

  describe(): string[] {
    return ['firstName', 'lastName', 'email'];
  }

  updateSubscriptions(): Promise<any> {
    return Promise.resolve(undefined);
  }
}
