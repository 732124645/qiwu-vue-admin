import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * API logs (see docs/design-notes.md#audit): the access log (core/audit HttpTraceInterceptor, one row per traced
 * request) and the error log (HttpErrorFilter, one row per 5xx) with its handling state. Append-only
 * but for the fault's state, no soft delete.
 */
export class AudHttp20260928100000 implements MigrationInterface {
  name = 'AudHttp20260928100000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE aud_http_trace (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '日志 ID',
      trace_id varchar(64) NULL COMMENT '追踪 ID',
      user_id bigint unsigned NULL COMMENT '用户 ID',
      username varchar(64) NULL COMMENT '登录名',
      user_type varchar(16) NULL COMMENT '用户类型',
      client_id varchar(64) NULL COMMENT '客户端',
      method varchar(10) NOT NULL COMMENT '请求方法',
      url varchar(512) NOT NULL COMMENT '请求路径',
      query text NULL COMMENT '查询参数（JSON，敏感键脱敏，≤4 KB）',
      body text NULL COMMENT '请求体（JSON，敏感键脱敏，≤4 KB）',
      status_code smallint unsigned NOT NULL COMMENT 'HTTP 状态码',
      biz_code varchar(16) NOT NULL COMMENT '业务码（0 为成功）',
      msg varchar(255) NULL COMMENT '错误消息（i18n 键）',
      ip varchar(64) NULL COMMENT 'IP 地址',
      user_agent varchar(512) NULL COMMENT 'User-Agent',
      started_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '请求时间（UTC）',
      cost_ms int unsigned NOT NULL COMMENT '耗时（毫秒）',
      PRIMARY KEY (id),
      KEY idx_aud_http_trace_started (started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='API 访问日志'`)
    await q.query(`CREATE TABLE aud_http_fault (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '日志 ID',
      trace_id varchar(64) NULL COMMENT '追踪 ID',
      user_id bigint unsigned NULL COMMENT '用户 ID',
      username varchar(64) NULL COMMENT '登录名',
      method varchar(10) NOT NULL COMMENT '请求方法',
      url varchar(512) NOT NULL COMMENT '请求路径',
      query text NULL COMMENT '查询参数（JSON，敏感键脱敏，≤4 KB）',
      body text NULL COMMENT '请求体（JSON，敏感键脱敏，≤4 KB）',
      ip varchar(64) NULL COMMENT 'IP 地址',
      user_agent varchar(512) NULL COMMENT 'User-Agent',
      error_name varchar(128) NOT NULL COMMENT '异常类型',
      error_message text NULL COMMENT '异常消息',
      stack text NULL COMMENT '堆栈（前 8 KB）',
      state varchar(12) NOT NULL DEFAULT 'open' COMMENT '处理状态（open/resolved/ignored）',
      handled_by bigint unsigned NULL COMMENT '处理人 ID',
      handled_at datetime(3) NULL COMMENT '处理时间（UTC）',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '发生时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_aud_http_fault_state (state),
      KEY idx_aud_http_fault_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='API 错误日志'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE aud_http_fault')
    await q.query('DROP TABLE aud_http_trace')
  }
}
