import type { MigrationInterface, QueryRunner } from 'typeorm'

/** Reclaim notification sends interrupted after their atomic claim. */
export class MsgClaim20260928140000 implements MigrationInterface {
  name = 'MsgClaim20260928140000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      "ALTER TABLE msg_inbox ADD COLUMN claimed_at datetime(3) NULL COMMENT '认领时间（UTC）' AFTER attempts",
    )
    await q.query(
      "ALTER TABLE msg_mail_record ADD COLUMN claimed_at datetime(3) NULL COMMENT '认领时间（UTC）' AFTER attempts",
    )
    await q.query(
      "ALTER TABLE msg_sms_record ADD COLUMN claimed_at datetime(3) NULL COMMENT '认领时间（UTC）' AFTER attempts",
    )
    await q.query("UPDATE msg_inbox SET claimed_at = created_at WHERE status = 'sending'")
    await q.query("UPDATE msg_mail_record SET claimed_at = created_at WHERE status = 'sending'")
    await q.query("UPDATE msg_sms_record SET claimed_at = created_at WHERE status = 'sending'")
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE msg_sms_record DROP COLUMN claimed_at')
    await q.query('ALTER TABLE msg_mail_record DROP COLUMN claimed_at')
    await q.query('ALTER TABLE msg_inbox DROP COLUMN claimed_at')
  }
}
