import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Historic rows have no trusted identity snapshot, so all read admin through the
 * column default, not from today's iam_user.user_type. No whole-table UPDATE: ADD COLUMN can run
 * INSTANT on MySQL >= 8.0.29. Writers fill the session identity in a later task.
 * MySQL DDL commits implicitly: a failed up is not rolled back as a whole.
 */
export class AuditUserType20261002120100 implements MigrationInterface {
  name = 'AuditUserType20261002120100'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE aud_signin_log ADD COLUMN user_type varchar(16) NOT NULL DEFAULT 'admin'
      COMMENT '用户类型（admin/member，来源于会话）' AFTER user_id`)
    await q.query(`ALTER TABLE aud_action_log ADD COLUMN user_type varchar(16) NOT NULL DEFAULT 'admin'
      COMMENT '用户类型（admin/member，来源于会话）' AFTER user_id`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE aud_action_log DROP COLUMN user_type')
    await q.query('ALTER TABLE aud_signin_log DROP COLUMN user_type')
  }
}
