import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * The scheduler seed once inserted `notify.dispatch` disabled as a placeholder and
 * seeds never change an existing task's switch, so upgraded databases never ran the outbox recovery. This
 * turns it on once (meta_migrations), so an admin who disables it later keeps it off; specs keep it off
 * (NODE_ENV=test). The scheduler picks it up at start or at its next periodic reconcile.
 */
export class NotifyDispatchOn20260928140100 implements MigrationInterface {
  name = 'NotifyDispatchOn20260928140100'

  async up(q: QueryRunner): Promise<void> {
    if (process.env.NODE_ENV === 'test') return
    await q.query(
      "UPDATE job_task SET enabled = 1 WHERE handler = 'notify.dispatch' AND name = 'seed.task.notifyDispatch' AND enabled = 0",
    )
  }

  async down(_q: QueryRunner): Promise<void> {
    // The previous switch is unknown.
  }
}
