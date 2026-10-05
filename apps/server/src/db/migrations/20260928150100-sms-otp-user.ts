import type { MigrationInterface, QueryRunner } from 'typeorm'

export class SmsOtpUser20260928150100 implements MigrationInterface {
  name = 'SmsOtpUser20260928150100'

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      "ALTER TABLE msg_sms_otp ADD COLUMN user_id bigint unsigned NULL COMMENT 'Requesting user ID for bind codes' AFTER mobile",
    )
    await q.query('CREATE INDEX idx_msg_sms_otp_user ON msg_sms_otp (user_id)')
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX idx_msg_sms_otp_user ON msg_sms_otp')
    await q.query('ALTER TABLE msg_sms_otp DROP COLUMN user_id')
  }
}
