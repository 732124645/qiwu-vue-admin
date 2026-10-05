import type { MigrationInterface, QueryRunner } from 'typeorm'

/** Test-only migration: proves run/revert + `meta_migrations` bookkeeping without a real business table. */
export class TestMigrationProbe1790000000000 implements MigrationInterface {
  name = 'TestMigrationProbe1790000000000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      "CREATE TABLE test_migration_probe (id int unsigned NOT NULL PRIMARY KEY COMMENT 'Probe id') COMMENT='Test fixture: migration probe'",
    )
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE test_migration_probe')
  }
}
