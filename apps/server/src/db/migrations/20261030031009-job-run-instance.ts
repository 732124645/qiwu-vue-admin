import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 任务日志记下执行实例与执行期间的事件循环最大延迟：多实例部署时把一次执行和同一进程的慢请求对上。
 * 两列都可空，老数据保持 NULL。
 */
export class JobRunInstance20261030031009 implements MigrationInterface {
  name = 'JobRunInstance20261030031009'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE job_run
      ADD COLUMN instance varchar(64) NULL COMMENT '执行实例（主机名:进程号）' AFTER cost_ms,
      ADD COLUMN loop_max_ms int unsigned NULL COMMENT '执行期间本进程事件循环最大延迟（毫秒）' AFTER instance`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE job_run DROP COLUMN loop_max_ms, DROP COLUMN instance')
  }
}
