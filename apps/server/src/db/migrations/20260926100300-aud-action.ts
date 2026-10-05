import type { MigrationInterface, QueryRunner } from 'typeorm'

/** Action log (see docs/design-notes.md#audit): one row per `@ActionLog` call; append-only, no soft delete. */
export class AudAction20260926100300 implements MigrationInterface {
  name = 'AudAction20260926100300'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE aud_action_log (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '日志 ID',
      trace_id varchar(64) NULL COMMENT '追踪 ID',
      domain varchar(64) NOT NULL COMMENT '业务域（如 iam.user）',
      verb varchar(32) NOT NULL COMMENT '动作（create/modify/remove/…）',
      biz_id varchar(64) NULL COMMENT '业务 ID',
      user_id bigint unsigned NULL COMMENT '操作人 ID',
      username varchar(64) NULL COMMENT '操作人登录名',
      dept_name varchar(64) NULL COMMENT '操作人部门（i18n 键或文本）',
      http_method varchar(10) NOT NULL COMMENT '请求方法',
      url varchar(512) NOT NULL COMMENT '请求 URL',
      ip varchar(64) NULL COMMENT 'IP 地址',
      location varchar(128) NULL COMMENT '操作地点',
      user_agent varchar(512) NULL COMMENT 'User-Agent',
      params text NULL COMMENT '请求参数（JSON，敏感键脱敏，≤4 KB）',
      result text NULL COMMENT '返回结果（JSON，敏感键脱敏，≤2 KB）',
      ok tinyint(1) NOT NULL COMMENT '是否成功',
      error_msg varchar(1000) NULL COMMENT '失败原因（错误消息 i18n 键）',
      cost_ms int unsigned NOT NULL COMMENT '耗时（毫秒）',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '发生时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_aud_action_log_created (created_at),
      KEY idx_aud_action_log_domain_verb (domain, verb)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='操作日志'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE aud_action_log')
  }
}
