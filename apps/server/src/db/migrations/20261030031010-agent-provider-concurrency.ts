import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 模型提供方的全局并发上限：跨实例、跨租户发往同一提供方的调用总数不超过它，满了排队等待。
 * 为空或 0 表示不限（原有行为）。
 */
export class AgentProviderConcurrency20261030031010 implements MigrationInterface {
  name = 'AgentProviderConcurrency20261030031010'

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE agent_provider ADD COLUMN max_concurrency int unsigned NULL COMMENT '并发上限（空或 0 不限）' AFTER models`,
    )
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE agent_provider DROP COLUMN max_concurrency')
  }
}
