import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * All notification tables share one migration.
 * Config and template tables have the full audit shape for editable generated CRUD pages; delivery
 * records and OTPs have only id and created_at for append-only pages (codegen rejects mixed shapes).
 * Template account/channel FKs use RESTRICT so deleting an in-use config becomes 409 in_use; delivery records have no such FK and retain their snapshots. Tencent SMS needs app_id.
 * A recipient without the channel's address still gets a record (`skipped`, reason in `error`):
 * an SMS record's `mobile` is then NULL, a mail record's `to_list` `[]`.
 */
export class MsgNotify20260928130000 implements MigrationInterface {
  name = 'MsgNotify20260928130000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE msg_inbox_template (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '站内信模板 ID',
      code varchar(100) NOT NULL COMMENT '模板编码',
      locale varchar(10) NOT NULL COMMENT '语言',
      name varchar(100) NOT NULL COMMENT '模板名称',
      title varchar(200) NOT NULL COMMENT '标题',
      body text NOT NULL COMMENT '正文（纯文本）',
      category varchar(16) NOT NULL COMMENT '分类（system/business）',
      sender_label varchar(64) NULL COMMENT '发送方名称',
      param_names json NULL COMMENT '参数名称',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_msg_inbox_template_code_locale (code, locale)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='站内信模板'`)

    await q.query(`CREATE TABLE msg_inbox (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '站内信 ID',
      user_id bigint unsigned NOT NULL COMMENT '收件人 ID',
      template_code varchar(100) NOT NULL COMMENT '模板编码',
      locale varchar(10) NOT NULL COMMENT '语言',
      category varchar(16) NOT NULL COMMENT '分类（system/business）',
      sender_label varchar(64) NULL COMMENT '发送方名称（模板快照）',
      title varchar(200) NOT NULL COMMENT '标题',
      body text NOT NULL COMMENT '正文（纯文本）',
      params json NULL COMMENT '参数',
      status varchar(12) NOT NULL DEFAULT 'pending' COMMENT '状态（pending/sending/delivered/failed）',
      attempts tinyint unsigned NOT NULL DEFAULT 0 COMMENT '发送尝试次数',
      read_at datetime(3) NULL COMMENT '阅读时间（UTC）',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_msg_inbox_user_read (user_id, read_at),
      KEY idx_msg_inbox_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='站内信'`)

    await q.query(`CREATE TABLE msg_mail_account (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '邮件账号 ID',
      name varchar(64) NOT NULL COMMENT '账号名称',
      address varchar(128) NOT NULL COMMENT '发件地址',
      username varchar(128) NULL COMMENT '登录名',
      password_enc varchar(512) NULL COMMENT '密码（SecretBox 密文）',
      host varchar(255) NOT NULL COMMENT '服务器地址',
      port smallint unsigned NOT NULL COMMENT '端口',
      security varchar(8) NOT NULL COMMENT '连接安全（ssl/starttls/none）',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_msg_mail_account_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='邮件账号'`)

    await q.query(`CREATE TABLE msg_mail_template (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '邮件模板 ID',
      code varchar(100) NOT NULL COMMENT '模板编码',
      locale varchar(10) NOT NULL COMMENT '语言',
      name varchar(100) NOT NULL COMMENT '模板名称',
      account_id bigint unsigned NULL COMMENT '邮件账号 ID（为空使用默认账号）',
      sender_label varchar(64) NULL COMMENT '发件人名称',
      subject varchar(255) NOT NULL COMMENT '主题',
      body mediumtext NOT NULL COMMENT '正文（已清洗 HTML）',
      param_names json NULL COMMENT '参数名称',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_msg_mail_template_code_locale (code, locale),
      KEY idx_msg_mail_template_account (account_id),
      CONSTRAINT fk_msg_mail_template_account FOREIGN KEY (account_id)
        REFERENCES msg_mail_account (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='邮件模板'`)

    await q.query(`CREATE TABLE msg_mail_record (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '邮件记录 ID',
      user_id bigint unsigned NULL COMMENT '收件用户 ID',
      to_list json NOT NULL COMMENT '收件地址列表',
      cc_list json NULL COMMENT '抄送地址列表',
      bcc_list json NULL COMMENT '密送地址列表',
      account_id bigint unsigned NULL COMMENT '邮件账号 ID（发送快照）',
      template_code varchar(100) NOT NULL COMMENT '模板编码',
      locale varchar(10) NOT NULL COMMENT '语言',
      subject varchar(255) NOT NULL COMMENT '主题',
      body mediumtext NOT NULL COMMENT '正文（已清洗 HTML）',
      params json NULL COMMENT '参数',
      status varchar(12) NOT NULL DEFAULT 'pending' COMMENT '状态（pending/sending/sent/failed/skipped）',
      provider_msg_id varchar(255) NULL COMMENT '服务商消息 ID',
      error varchar(1000) NULL COMMENT '错误信息',
      attempts tinyint unsigned NOT NULL DEFAULT 0 COMMENT '发送尝试次数',
      sent_at datetime(3) NULL COMMENT '发送时间（UTC）',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_msg_mail_record_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='邮件发送记录'`)

    await q.query(`CREATE TABLE msg_sms_channel (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '短信渠道 ID',
      driver varchar(16) NOT NULL COMMENT '驱动（aliyun/tencent/debug）',
      name varchar(64) NOT NULL COMMENT '渠道名称',
      sign_name varchar(64) NULL COMMENT '短信签名',
      app_id varchar(64) NULL COMMENT '应用 ID（腾讯 SmsSdkAppId）',
      api_key varchar(128) NULL COMMENT 'API Key',
      api_secret_enc varchar(512) NULL COMMENT 'API Secret（SecretBox 密文）',
      region varchar(64) NULL COMMENT '区域',
      receipt_secret_enc varchar(512) NULL COMMENT '回执密钥（SecretBox 密文）',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_msg_sms_channel_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='短信渠道'`)

    await q.query(`CREATE TABLE msg_sms_template (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '短信模板 ID',
      code varchar(100) NOT NULL COMMENT '模板编码',
      locale varchar(10) NOT NULL COMMENT '语言',
      channel_id bigint unsigned NULL COMMENT '短信渠道 ID',
      name varchar(100) NOT NULL COMMENT '模板名称',
      purpose varchar(12) NOT NULL COMMENT '用途（otp/notice/promo）',
      body varchar(500) NOT NULL COMMENT '正文（纯文本）',
      param_names json NULL COMMENT '参数名称',
      provider_template_id varchar(64) NULL COMMENT '服务商模板 ID',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_msg_sms_template_code_locale (code, locale),
      KEY idx_msg_sms_template_channel (channel_id),
      CONSTRAINT fk_msg_sms_template_channel FOREIGN KEY (channel_id)
        REFERENCES msg_sms_channel (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='短信模板'`)

    await q.query(`CREATE TABLE msg_sms_record (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '短信记录 ID',
      channel_id bigint unsigned NULL COMMENT '短信渠道 ID（发送快照）',
      template_code varchar(100) NOT NULL COMMENT '模板编码',
      mobile varchar(32) NULL COMMENT '手机号（为空 = 收件人无手机号，已跳过）',
      user_id bigint unsigned NULL COMMENT '收件用户 ID',
      body varchar(1000) NOT NULL COMMENT '正文（纯文本）',
      params json NULL COMMENT '参数',
      status varchar(12) NOT NULL DEFAULT 'pending' COMMENT '状态（pending/sending/sent/failed/skipped）',
      error varchar(1000) NULL COMMENT '错误信息',
      provider_msg_id varchar(128) NULL COMMENT '服务商消息 ID',
      receipt_status varchar(24) NULL COMMENT '回执状态',
      receipt_at datetime(3) NULL COMMENT '回执时间（UTC）',
      attempts tinyint unsigned NOT NULL DEFAULT 0 COMMENT '发送尝试次数',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_msg_sms_record_status (status),
      KEY idx_msg_sms_record_provider_msg_id (provider_msg_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='短信发送记录'`)

    await q.query(`CREATE TABLE msg_sms_otp (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '短信验证码 ID',
      mobile varchar(32) NOT NULL COMMENT '手机号',
      scene varchar(24) NOT NULL COMMENT '场景（signin/reset_password/bind_mobile）',
      code varchar(8) NOT NULL COMMENT '验证码',
      attempts tinyint unsigned NOT NULL DEFAULT 0 COMMENT '验证失败次数（5 次作废）',
      daily_seq int unsigned NOT NULL COMMENT '当日序号',
      request_ip varchar(64) NOT NULL COMMENT '请求 IP',
      consumed_at datetime(3) NULL COMMENT '使用时间（UTC）',
      consumed_ip varchar(64) NULL COMMENT '使用 IP',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_msg_sms_otp_mobile_scene_created (mobile, scene, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='短信验证码'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      'DROP TABLE msg_sms_otp, msg_sms_record, msg_sms_template, msg_sms_channel, msg_mail_record, msg_mail_template, msg_mail_account, msg_inbox, msg_inbox_template',
    )
  }
}
