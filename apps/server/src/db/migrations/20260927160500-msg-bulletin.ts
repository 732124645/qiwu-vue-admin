import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Bulletins (通知公告): one author-written text in one language, its body
 * HTML sanitized when saved (core/sanitize.ts); readers see it once published. Not soft-deleted: a
 * deleted bulletin is gone, its read receipts with it (FK CASCADE). A receipt = one reader, the first
 * time they opened it. The column comments are the generator's zh-CN labels.
 */
export class MsgBulletin20260927160500 implements MigrationInterface {
  name = 'MsgBulletin20260927160500'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE msg_bulletin (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '公告 ID',
      title varchar(200) NOT NULL COMMENT '标题',
      kind varchar(16) NOT NULL COMMENT '类型（字典 messaging.bulletin_kind）',
      body mediumtext NOT NULL COMMENT '正文（HTML，保存时清洗）',
      published tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否已发布',
      published_at datetime(3) NULL COMMENT '发布时间（UTC）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_msg_bulletin_published (published, published_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='通知公告'`)

    await q.query(`CREATE TABLE msg_bulletin_receipt (
      bulletin_id bigint unsigned NOT NULL COMMENT '公告 ID',
      user_id bigint unsigned NOT NULL COMMENT '阅读人 ID',
      read_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '首次阅读时间（UTC）',
      PRIMARY KEY (bulletin_id, user_id),
      KEY idx_msg_bulletin_receipt_user (user_id),
      CONSTRAINT fk_msg_bulletin_receipt_bulletin FOREIGN KEY (bulletin_id)
        REFERENCES msg_bulletin (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公告已读回执'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE msg_bulletin_receipt, msg_bulletin')
  }
}
