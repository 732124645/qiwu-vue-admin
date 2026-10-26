import type { MigrationInterface, QueryRunner } from 'typeorm'

/** 积分账本保留真实用量和当时费率，旧 Token 记录保留但不虚构历史积分。 */
export class AgentCredits20261026180241 implements MigrationInterface {
  name = 'AgentCredits20261026180241'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE agent_usage
      DROP INDEX uk_agent_usage_day,
      MODIFY model varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '精确模型标识',
      ADD provider_id bigint unsigned NOT NULL DEFAULT 0 COMMENT '提供方 ID（历史来源未知为 0）' AFTER model,
      ADD provider_name varchar(64) NULL COMMENT '提供方名称快照' AFTER provider_id,
      ADD credits decimal(24,6) NOT NULL DEFAULT 0 COMMENT '已计价积分',
      ADD cache_read_tokens bigint unsigned NULL COMMENT '缓存读取 Token（未报告为空）',
      ADD cache_write_tokens bigint unsigned NULL COMMENT '缓存写入 Token（未报告为空）',
      ADD reasoning_tokens bigint unsigned NULL COMMENT '输出中已包含的推理 Token（未报告为空）',
      ADD unpriced_calls int unsigned NOT NULL DEFAULT 0 COMMENT '新调用中无法计价的次数',
      ADD unreported_calls int unsigned NOT NULL DEFAULT 0 COMMENT '新调用中未报告用量的次数',
      ADD legacy_calls int unsigned NOT NULL DEFAULT 0 COMMENT '升级前无费率快照的次数',
      ADD UNIQUE KEY uk_agent_usage_day (tenant_id, user_id, day, provider_id, model, alive)`)
    // qw:cross-tenant migration marks every tenant's historical rows without inferring old rates.
    await q.query('UPDATE agent_usage SET legacy_calls = calls')
    await q.query(`ALTER TABLE agent_turn
      MODIFY prompt_tokens bigint unsigned NOT NULL DEFAULT 0 COMMENT '本轮输入 Token',
      MODIFY completion_tokens bigint unsigned NOT NULL DEFAULT 0 COMMENT '本轮输出 Token',
      ADD credits decimal(24,6) NOT NULL DEFAULT 0 COMMENT '本轮已计价积分',
      ADD unpriced_calls int unsigned NOT NULL DEFAULT 0 COMMENT '本轮无法计价调用数',
      ADD unreported_calls int unsigned NOT NULL DEFAULT 0 COMMENT '本轮未报告用量调用数',
      ADD legacy_usage tinyint NOT NULL DEFAULT 1 COMMENT '升级前无积分快照的轮次'`)
    await q.query('ALTER TABLE agent_turn ALTER COLUMN legacy_usage SET DEFAULT 0')
    await q.query(`CREATE TABLE agent_usage_entry (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '用量明细 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      user_id bigint unsigned NOT NULL COMMENT '用户 ID',
      provider_id bigint unsigned NOT NULL COMMENT '提供方 ID',
      provider_name varchar(64) NOT NULL COMMENT '提供方名称快照',
      model varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '精确模型标识',
      thread_id bigint unsigned NULL COMMENT '会话 ID（非会话调用为空）',
      turn_id bigint unsigned NULL COMMENT '轮次 ID（非轮次调用为空）',
      kind varchar(16) NOT NULL DEFAULT 'chat' COMMENT '调用类型',
      usage_json json NULL COMMENT '供应商用量及细分（不含响应正文）',
      pricing json NULL COMMENT '调用时每百万 Token 积分费率快照',
      credits decimal(24,6) NULL COMMENT '本次积分（无法计价为空）',
      usage_reported tinyint NOT NULL DEFAULT 0 COMMENT '供应商是否报告实际用量',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_agent_usage_entry_day (tenant_id, created_at, id),
      KEY idx_agent_usage_entry_user (tenant_id, user_id, created_at),
      KEY idx_agent_usage_entry_turn (tenant_id, turn_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='模型调用用量与积分明细'`)
  }

  async down(q: QueryRunner): Promise<void> {
    // 回退会移除积分功能，但不能悄悄丢弃同名模型在不同提供方的 Token 累计。
    // qw:cross-tenant migration checks every tenant before restoring the historical live-row key.
    const [usage] = (await q.query(`SELECT 1 AS conflict
      FROM agent_usage WHERE deleted_at IS NULL
      GROUP BY tenant_id, user_id, day, model COLLATE utf8mb4_0900_ai_ci HAVING COUNT(*) > 1 LIMIT 1`)) as {
      conflict: number
    }[]
    if (usage)
      throw new Error(
        'Provider-specific usage conflicts with the old key; reconcile it before rollback',
      )
    // qw:cross-tenant 回退前统一核对全部租户，不能把不限额后的大累计截断成旧整数。
    const [turn] = (await q.query(`SELECT 1 AS oversized FROM agent_turn
      WHERE prompt_tokens > 2147483647 OR completion_tokens > 2147483647 LIMIT 1`)) as {
      oversized: number
    }[]
    if (turn)
      throw new Error(
        'Turn token totals exceed old integer storage; reconcile them before rollback',
      )
    await q.query('DROP TABLE agent_usage_entry')
    await q.query(
      `ALTER TABLE agent_turn DROP credits, DROP unpriced_calls, DROP unreported_calls, DROP legacy_usage,
       MODIFY prompt_tokens int NOT NULL DEFAULT 0 COMMENT '输入 token 数',
       MODIFY completion_tokens int NOT NULL DEFAULT 0 COMMENT '输出 token 数'`,
    )
    await q.query(`ALTER TABLE agent_usage
      DROP INDEX uk_agent_usage_day,
      DROP provider_id, DROP provider_name, DROP credits,
      MODIFY model varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '模型名',
      DROP cache_read_tokens, DROP cache_write_tokens, DROP reasoning_tokens,
      DROP unpriced_calls, DROP unreported_calls, DROP legacy_calls,
      ADD UNIQUE KEY uk_agent_usage_day (tenant_id, user_id, day, model, alive)`)
  }
}
