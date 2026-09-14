import { MigrationInterface, QueryRunner } from 'typeorm/browser';

// Rekeys the local meta table on (collection, isPrivate) so it can hold one download cursor per
// collection. No earlier version wrote rows to it, so the table is recreated rather than copied.
export class MetaCursorIdentity1789400000000 implements MigrationInterface {
  name = 'MetaCursorIdentity1789400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "meta"`);
    await queryRunner.query(
      `CREATE TABLE "meta" ("collection" varchar NOT NULL, "isPrivate" boolean NOT NULL, "changeId" integer NOT NULL, PRIMARY KEY ("collection", "isPrivate"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "meta"`);
    await queryRunner.query(
      `CREATE TABLE "meta" ("collection" varchar PRIMARY KEY NOT NULL, "changeId" integer NOT NULL, "isPrivate" boolean NOT NULL)`,
    );
  }
}
