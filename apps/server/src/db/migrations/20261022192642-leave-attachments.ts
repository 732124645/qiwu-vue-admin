import type { MigrationInterface, QueryRunner } from 'typeorm'

/** 请假附件沿用文件对象与历史申请，旧行没有附件时保持为空。 */
export class LeaveAttachments20261022192642 implements MigrationInterface {
  name = 'LeaveAttachments20261022192642'

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      "ALTER TABLE biz_leave_request ADD COLUMN attachment_ids json NULL COMMENT '附件对象 ID 列表'",
    )
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE biz_leave_request DROP COLUMN attachment_ids')
  }
}
