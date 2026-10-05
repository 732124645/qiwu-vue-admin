import type { MigrationInterface, QueryRunner } from 'typeorm'

/** Sign-in log (see docs/design-notes.md#audit): append-only, no audit columns besides created_at, no soft delete. */
export class AudSignin20260926100200 implements MigrationInterface {
  name = 'AudSignin20260926100200'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE aud_signin_log (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '日志 ID',
      trace_id varchar(64) NULL COMMENT '追踪 ID',
      kind varchar(16) NOT NULL COMMENT '类型（password/sms/signout/kicked/refresh_reuse/locked）',
      user_id bigint unsigned NULL COMMENT '用户 ID（用户名不存在时为空）',
      username varchar(64) NOT NULL COMMENT '登录名（按输入记录）',
      client_id varchar(64) NOT NULL COMMENT '客户端 ID',
      ip varchar(64) NULL COMMENT 'IP 地址',
      location varchar(128) NULL COMMENT '登录地点',
      browser varchar(64) NULL COMMENT '浏览器',
      os varchar(64) NULL COMMENT '操作系统',
      ok tinyint(1) NOT NULL COMMENT '是否成功',
      msg_key varchar(128) NULL COMMENT '提示消息 i18n 键',
      msg_params json NULL COMMENT '提示消息参数',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '发生时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_aud_signin_log_created (created_at),
      KEY idx_aud_signin_log_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='登录日志'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE aud_signin_log')
  }
}
