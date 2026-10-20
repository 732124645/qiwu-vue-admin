import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * WeChat Official Account automation (see docs/design-notes.md#wxoa): auto-reply rules, menus, materials
 * and channel QR codes, each owned by an account (`account_id`, no cascade). Generated columns hold the
 * "at most one" rules in unique keys: `sole` (one enabled subscribe rule and one enabled default rule per
 * account; a disabled or deleted rule frees the slot) and `default_one` (one default menu per account).
 * A click key and a scan scene of the same text do not collide: the trigger kind is part of the key.
 * `wxoa_reply_rule.material_id` is a restricting reference checked through its own index. No foreign keys.
 */
export class WxoaAutomation20261006100100 implements MigrationInterface {
  name = 'WxoaAutomation20261006100100'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE wxoa_reply_rule (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '规则 ID',
      account_id bigint unsigned NOT NULL COMMENT '公众号账号 ID',
      name varchar(64) NOT NULL COMMENT '规则名称',
      trigger_kind varchar(16) NOT NULL COMMENT '触发类型（subscribe：关注，keyword：关键词，default：默认，click：菜单点击，scan：扫码）',
      match_mode varchar(8) NULL COMMENT '关键词匹配方式（exact：精确，contains：包含）',
      keywords json NULL COMMENT '关键词列表',
      event_key varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL COMMENT '事件 KEY（点击为菜单 KEY，扫码为二维码场景）',
      priority int NOT NULL DEFAULT 0 COMMENT '优先级',
      reply_kind varchar(16) NOT NULL COMMENT '回复类型',
      reply_body json NOT NULL COMMENT '回复内容',
      material_id bigint unsigned NULL COMMENT '引用的素材 ID',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      sole tinyint AS (IF(trigger_kind IN ('subscribe', 'default') AND enabled = 1, 1, NULL)) VIRTUAL COMMENT '启用的关注 / 默认规则为 1、其余为空（唯一索引用）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_wxoa_reply_rule_sole (account_id, trigger_kind, sole, alive),
      UNIQUE KEY uk_wxoa_reply_rule_event_key (account_id, trigger_kind, event_key, alive),
      KEY idx_wxoa_reply_rule_match (account_id, trigger_kind, enabled, priority),
      KEY idx_wxoa_reply_rule_material (material_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公众号自动回复规则'`)
    await q.query(`CREATE TABLE wxoa_menu (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '菜单 ID',
      account_id bigint unsigned NOT NULL COMMENT '公众号账号 ID',
      menu_kind varchar(16) NOT NULL COMMENT '菜单类型（default：默认菜单，conditional：个性化菜单）',
      label varchar(64) NOT NULL COMMENT '菜单名称',
      match_tag_id int unsigned NULL COMMENT '匹配的微信端标签 ID',
      match_platform varchar(8) NULL COMMENT '匹配的客户端平台（ios/android/other）',
      buttons json NOT NULL COMMENT '菜单按钮',
      wx_menu_id varchar(32) CHARACTER SET ascii NULL COMMENT '个性化菜单的微信端 menuid',
      published_at datetime(3) NULL COMMENT '发布时间（UTC）',
      published_digest char(64) CHARACTER SET ascii NULL COMMENT '发布时按钮的摘要（判断有未发布的修改）',
      default_one tinyint AS (IF(menu_kind = 'default', 1, NULL)) VIRTUAL COMMENT '默认菜单为 1、其余为空（唯一索引用）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_wxoa_menu_default (account_id, default_one, alive),
      CONSTRAINT ck_wxoa_menu_match CHECK (menu_kind <> 'conditional' OR match_tag_id IS NOT NULL OR match_platform IS NOT NULL)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公众号自定义菜单'`)
    await q.query(`CREATE TABLE wxoa_material (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '素材 ID',
      account_id bigint unsigned NOT NULL COMMENT '公众号账号 ID',
      media_kind varchar(8) NOT NULL COMMENT '素材类型（image/voice/video/thumb）',
      media_id varchar(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '微信端素材 media_id',
      title varchar(64) NULL COMMENT '标题（视频必填）',
      intro varchar(255) NULL COMMENT '简介（视频必填）',
      file_name varchar(255) NULL COMMENT '文件名',
      byte_size bigint unsigned NULL COMMENT '文件大小（字节）',
      wx_url varchar(1024) CHARACTER SET ascii NULL COMMENT '图片的微信端地址（https）',
      object_id bigint unsigned NULL COMMENT '本地副本的文件对象 ID',
      origin varchar(8) NOT NULL COMMENT '来源（local：本地上传，pulled：从微信同步）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_wxoa_material_media_id (account_id, media_id, alive),
      KEY idx_wxoa_material_kind (account_id, media_kind, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公众号永久素材'`)
    await q.query(`CREATE TABLE wxoa_qrcode (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '二维码 ID',
      account_id bigint unsigned NOT NULL COMMENT '公众号账号 ID',
      label varchar(64) NOT NULL COMMENT '名称',
      qr_kind varchar(12) NOT NULL COMMENT '类型（temporary：临时，permanent：永久）',
      scene varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '场景值（字符串）',
      expires_at datetime(3) NULL COMMENT '过期时间（UTC，永久码为空）',
      ticket varchar(255) CHARACTER SET ascii NOT NULL COMMENT '二维码 ticket',
      qr_url varchar(255) CHARACTER SET ascii NOT NULL COMMENT '二维码内容地址',
      object_id bigint unsigned NULL COMMENT '二维码图片副本的文件对象 ID',
      tag_id int unsigned NULL COMMENT '扫码后自动打的微信端标签 ID',
      scan_count int unsigned NOT NULL DEFAULT 0 COMMENT '扫码次数',
      subscribe_count int unsigned NOT NULL DEFAULT 0 COMMENT '扫码关注次数',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_wxoa_qrcode_scene (account_id, scene, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公众号渠道二维码'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE wxoa_qrcode, wxoa_material, wxoa_menu, wxoa_reply_rule')
  }
}
