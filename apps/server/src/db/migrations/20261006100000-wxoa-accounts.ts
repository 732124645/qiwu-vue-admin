import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * WeChat Official Account management (see docs/design-notes.md#wxoa): accounts, fans, tags and the
 * message log. Secrets are SecretBox ciphertext (`*_enc`), never plaintext. WeChat ids (appid, openid,
 * media and message ids) are ASCII, case-sensitive ones `ascii_bin`. Child rows belong to an account by
 * `account_id`; deleting an account soft-deletes it only, nothing cascades. Messages are a log: never
 * soft-deleted by the app, purged after the retention period; outbound rows have no `dedup_key`, so the
 * unique key leaves them alone. No foreign keys.
 */
export class WxoaAccounts20261006100000 implements MigrationInterface {
  name = 'WxoaAccounts20261006100000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE wxoa_account (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '账号 ID',
      label varchar(64) NOT NULL COMMENT '账号名称',
      app_id varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'AppID',
      account_kind varchar(16) NOT NULL COMMENT '账号类型（service：服务号，subscription：公众号（原订阅号），sandbox：测试号）',
      verified tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否认证',
      crypto_mode varchar(16) NOT NULL DEFAULT 'plain' COMMENT '消息加密方式（plain：明文，compat：兼容，secure：安全）',
      app_secret_enc varchar(512) CHARACTER SET ascii NOT NULL COMMENT 'AppSecret 密文',
      push_token_enc varchar(512) CHARACTER SET ascii NOT NULL COMMENT '消息推送 Token 密文',
      aes_key_enc varchar(512) CHARACTER SET ascii NULL COMMENT 'EncodingAESKey 密文（明文模式可空）',
      callback_key char(22) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '回调地址路径标识（22 位 base64url）',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      last_push_at datetime(3) NULL COMMENT '最近一次验签通过的推送时间（UTC）',
      note varchar(500) NULL COMMENT '备注',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_wxoa_account_app_id (app_id, alive),
      UNIQUE KEY uk_wxoa_account_callback_key (callback_key, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公众号账号'`)
    await q.query(`CREATE TABLE wxoa_fan (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '粉丝 ID',
      account_id bigint unsigned NOT NULL COMMENT '公众号账号 ID',
      open_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '用户标识（openid）',
      union_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '开放平台用户标识（unionid）',
      subscribed tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否关注',
      subscribed_at datetime(3) NULL COMMENT '关注时间（UTC）',
      unsubscribed_at datetime(3) NULL COMMENT '取消关注时间（UTC）',
      subscribe_scene varchar(48) CHARACTER SET ascii NULL COMMENT '关注渠道来源',
      qr_scene varchar(64) NULL COMMENT '扫码关注的二维码场景',
      remark varchar(30) NULL COMMENT '备注名',
      lang varchar(16) CHARACTER SET ascii NULL COMMENT '语言',
      tag_ids json NULL COMMENT '标签 ID 列表（微信端标签 ID）',
      blocked tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否在黑名单',
      last_inbound_at datetime(3) NULL COMMENT '最近一条用户消息时间（UTC，客服消息 48 小时窗口）',
      last_event_at datetime(3) NULL COMMENT '最近一次可回复事件时间（UTC，客服消息 1 分钟窗口）',
      synced_at datetime(3) NULL COMMENT '最近一次资料同步时间（UTC）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_wxoa_fan_open_id (account_id, open_id, alive),
      KEY idx_wxoa_fan_subscribed (account_id, subscribed, subscribed_at),
      KEY idx_wxoa_fan_inbound (account_id, last_inbound_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公众号粉丝'`)
    await q.query(`CREATE TABLE wxoa_tag (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '标签 ID',
      account_id bigint unsigned NOT NULL COMMENT '公众号账号 ID',
      tag_id int unsigned NOT NULL COMMENT '微信端标签 ID',
      name varchar(30) NOT NULL COMMENT '标签名称',
      fan_count int unsigned NOT NULL DEFAULT 0 COMMENT '粉丝数',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_wxoa_tag_tag_id (account_id, tag_id, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公众号粉丝标签'`)
    await q.query(`CREATE TABLE wxoa_message (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '消息 ID',
      account_id bigint unsigned NOT NULL COMMENT '公众号账号 ID',
      open_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '粉丝标识（openid）',
      direction varchar(8) NOT NULL COMMENT '方向（in：收到，out：发出）',
      channel varchar(16) NOT NULL COMMENT '渠道（push：推送，passive：被动回复，cs：客服消息，template：模板消息）',
      msg_kind varchar(24) NOT NULL COMMENT '消息类型',
      event_kind varchar(48) NULL COMMENT '事件类型',
      event_key varchar(1024) NULL COMMENT '事件 KEY（VIEW 事件为菜单跳转 URL，最长 1024 字节）',
      payload json NOT NULL COMMENT '消息内容（白名单字段，超长时截断并标记）',
      object_id bigint unsigned NULL COMMENT '入站媒体本地副本的文件对象 ID',
      wx_msg_id varchar(24) CHARACTER SET ascii NULL COMMENT '微信消息 ID（64 位，按字符串保存）',
      dedup_key char(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '入站排重键（sha256，出站为空）',
      send_state varchar(16) NULL COMMENT '发送状态（pending/sent/delivered/failed/user_blocked）',
      errcode int NULL COMMENT '微信返回码',
      operator_id bigint unsigned NULL COMMENT '发送人 ID',
      occurred_at datetime(3) NOT NULL COMMENT '发生时间（UTC）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_wxoa_message_dedup (account_id, dedup_key, alive),
      KEY idx_wxoa_message_open_id (account_id, open_id, id),
      KEY idx_wxoa_message_occurred (account_id, occurred_at),
      KEY idx_wxoa_message_wx_msg_id (account_id, wx_msg_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公众号消息记录'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE wxoa_message, wxoa_tag, wxoa_fan, wxoa_account')
  }
}
