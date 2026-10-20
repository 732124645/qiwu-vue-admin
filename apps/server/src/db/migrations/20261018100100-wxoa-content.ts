import type { MigrationInterface, QueryRunner } from 'typeorm'

/** Official Account content and operations: drafts, published records, mass jobs and rich-text image rewrites. */
export class WxoaContent20261018100100 implements MigrationInterface {
  name = 'WxoaContent20261018100100'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE wxoa_draft (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '草稿 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      account_id bigint unsigned NOT NULL COMMENT '公众号账号 ID',
      title varchar(64) NOT NULL COMMENT '首篇标题',
      articles json NOT NULL COMMENT '1 至 8 篇图文',
      media_id varchar(128) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '微信草稿 media_id',
      origin varchar(8) NOT NULL COMMENT '来源（local/pulled）',
      synced_at datetime(3) NULL COMMENT '最近同步时间（UTC）',
      synced_digest char(64) CHARACTER SET ascii NULL COMMENT '同步时正文摘要',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      KEY idx_wxoa_draft_tenant (tenant_id),
      UNIQUE KEY uk_wxoa_draft_media_id (account_id, media_id, alive),
      KEY idx_wxoa_draft_updated (account_id, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公众号图文草稿'`)

    await q.query(`CREATE TABLE wxoa_publish (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '发表记录 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      account_id bigint unsigned NOT NULL COMMENT '公众号账号 ID',
      draft_id bigint unsigned NULL COMMENT '本地草稿 ID',
      publish_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '微信发表任务 ID',
      article_id varchar(128) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '微信文章 ID',
      title varchar(64) NOT NULL COMMENT '首篇标题快照',
      publish_state varchar(16) NOT NULL COMMENT '状态',
      fail_idx json NULL COMMENT '失败篇序号',
      article_urls json NULL COMMENT '文章链接',
      finished_at datetime(3) NULL COMMENT '完成时间（UTC）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      KEY idx_wxoa_publish_tenant (tenant_id),
      UNIQUE KEY uk_wxoa_publish_publish_id (account_id, publish_id, alive),
      UNIQUE KEY uk_wxoa_publish_article_id (account_id, article_id, alive),
      KEY idx_wxoa_publish_created (account_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公众号发表记录'`)

    await q.query(`CREATE TABLE wxoa_mass_job (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '群发任务 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      account_id bigint unsigned NOT NULL COMMENT '公众号账号 ID',
      target_kind varchar(8) NOT NULL COMMENT '对象（all/tag/openids）',
      tag_id int unsigned NULL COMMENT '标签 ID',
      open_ids json NULL COMMENT 'openid 列表',
      msg_kind varchar(16) NOT NULL COMMENT '消息类型',
      payload json NOT NULL COMMENT '消息内容',
      client_msg_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '客户端幂等 ID',
      wx_msg_id varchar(32) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '微信消息 ID',
      msg_data_id varchar(32) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '微信图文数据 ID',
      job_state varchar(16) NOT NULL COMMENT '任务状态',
      result json NULL COMMENT '群发结果',
      finished_at datetime(3) NULL COMMENT '完成时间（UTC）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      KEY idx_wxoa_mass_job_tenant (tenant_id),
      UNIQUE KEY uk_wxoa_mass_client_msg_id (account_id, client_msg_id, alive),
      KEY idx_wxoa_mass_wx_msg_id (account_id, wx_msg_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公众号群发任务'`)

    await q.query(`CREATE TABLE wxoa_inline_image (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '正文图片映射 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      account_id bigint unsigned NOT NULL COMMENT '公众号账号 ID',
      object_id bigint unsigned NOT NULL COMMENT '本站正文图片对象 ID',
      wx_url varchar(1024) CHARACTER SET ascii NOT NULL COMMENT '微信图片地址',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      KEY idx_wxoa_inline_image_tenant (tenant_id),
      UNIQUE KEY uk_wxoa_inline_image_object (account_id, object_id, alive),
      KEY idx_wxoa_inline_image_url (account_id, wx_url(255))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公众号正文图片映射'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE wxoa_inline_image, wxoa_mass_job, wxoa_publish, wxoa_draft')
  }
}
