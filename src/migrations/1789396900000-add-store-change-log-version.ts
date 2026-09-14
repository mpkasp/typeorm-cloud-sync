import { MigrationInterface, QueryRunner } from 'typeorm/browser';

// Adds StoreChangeLog.version. Rows queued before the upgrade read as version 0, which a drain
// matches like any other version.
export class AddStoreChangeLogVersion1789396900000 implements MigrationInterface {
  name = 'AddStoreChangeLogVersion1789396900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "storechangelog" ADD COLUMN "version" integer NOT NULL DEFAULT (0)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "storechangelog" DROP COLUMN "version"`);
  }
}
