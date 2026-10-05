import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * A `run_once` catch-up claimed at start is persisted as
 * `misfire_pending_at` (the missed fire time) until it has run, so a crash in between leaves it for the
 * next start instead of losing it.
 */
export class JobMisfire20260928120000 implements MigrationInterface {
  name = 'JobMisfire20260928120000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      "ALTER TABLE job_task ADD COLUMN misfire_pending_at datetime(3) NULL COMMENT '待补跑的错过触发时间（UTC，补跑后清空）' AFTER last_fire_at",
    )
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE job_task DROP COLUMN misfire_pending_at')
  }
}
