import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Scheduled jobs: a task names a whitelisted handler (the `@JobHandler` registry)
 * with its JSON params, a cron and its run policy; every attempt of every fire is one `job_run` row
 * (append-only, purged by `audit.purge`). Tasks are not soft-deleted; runs keep the task's name as it
 * was (`task_name`), so the log still reads after the task is gone (no FK).
 */
export class Job20260928110000 implements MigrationInterface {
  name = 'Job20260928110000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE job_task (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '任务 ID',
      name varchar(64) NOT NULL COMMENT '任务名称',
      group_code varchar(32) NOT NULL DEFAULT 'default' COMMENT '任务分组（字典 scheduler.job_group）',
      handler varchar(128) NOT NULL COMMENT '处理器',
      params json NULL COMMENT '参数（JSON 对象）',
      cron varchar(64) NOT NULL COMMENT 'Cron 表达式',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      retry_max tinyint unsigned NOT NULL DEFAULT 0 COMMENT '失败重试次数',
      retry_delay_ms int unsigned NOT NULL DEFAULT 1000 COMMENT '重试间隔（毫秒）',
      timeout_ms int unsigned NOT NULL DEFAULT 60000 COMMENT '超时（毫秒）',
      allow_overlap tinyint(1) NOT NULL DEFAULT 0 COMMENT '允许并发执行',
      misfire varchar(8) NOT NULL DEFAULT 'skip' COMMENT '错过策略（skip/run_once）',
      last_fire_at datetime(3) NULL COMMENT '上次触发时间（UTC）',
      note varchar(500) NULL COMMENT '备注',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_job_task_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='定时任务'`)
    await q.query(`CREATE TABLE job_run (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '日志 ID',
      task_id bigint unsigned NOT NULL COMMENT '任务 ID',
      task_name varchar(64) NOT NULL COMMENT '任务名称',
      handler varchar(128) NOT NULL COMMENT '处理器',
      params json NULL COMMENT '参数（JSON）',
      attempt tinyint unsigned NOT NULL DEFAULT 1 COMMENT '第几次尝试',
      outcome varchar(12) NOT NULL COMMENT '结果（字典 scheduler.run_outcome）',
      output text NULL COMMENT '输出',
      error text NULL COMMENT '错误信息',
      started_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '开始时间（UTC）',
      ended_at datetime(3) NULL COMMENT '结束时间（UTC）',
      cost_ms int unsigned NOT NULL DEFAULT 0 COMMENT '耗时（毫秒）',
      PRIMARY KEY (id),
      KEY idx_job_run_task_started (task_id, started_at),
      KEY idx_job_run_started (started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='任务日志'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE job_run, job_task')
  }
}
