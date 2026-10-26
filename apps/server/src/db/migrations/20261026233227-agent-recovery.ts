import type { MigrationInterface, QueryRunner } from 'typeorm'

/** 保存投递意图、流式检查点和调用开始记录，进程中断后不靠短期缓存猜测是否执行。 */
export class AgentRecovery20261026233227 implements MigrationInterface {
  name = 'AgentRecovery20261026233227'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE agent_thread
      ADD client_draft_id varchar(36) NULL COMMENT '客户端草稿接收标识',
      ADD client_draft_hash char(64) NULL COMMENT '首次创建内容摘要',
      ADD recovery_required tinyint NOT NULL DEFAULT 0 COMMENT '未知写入待本人核对',
      ADD recovery_revision int unsigned NOT NULL DEFAULT 0 COMMENT '未知写入核对版本',
      ADD UNIQUE KEY uk_agent_thread_client (tenant_id, user_id, client_draft_id)`)
    await q.query(`ALTER TABLE agent_turn
      ADD parent_turn_id bigint unsigned NULL COMMENT '子任务所属父预算轮次',
      ADD KEY idx_agent_turn_parent (tenant_id, parent_turn_id)`)
    await q.query(`ALTER TABLE agent_item
      ADD revision int unsigned NOT NULL DEFAULT 0 COMMENT '已提交条目版本'`)
    await q.query(`ALTER TABLE agent_usage_entry
      ADD status varchar(16) NOT NULL DEFAULT 'complete' COMMENT 'pending/complete/unknown',
      ADD lease_until datetime(3) NULL COMMENT '调用持有者的数据库租约期限',
      ADD settled_at datetime(3) NULL COMMENT '首次结算时间',
      ADD usage_day date NULL COMMENT '调用开始所属 UTC 日',
      ADD parent_turn_id bigint unsigned NULL COMMENT '父轮预算快照',
      ADD KEY idx_agent_usage_pending (tenant_id, status, lease_until)`)
    // qw:cross-tenant 升级前的完成记录保留原日期和已记账事实，不生成虚假在途调用。
    await q.query(
      'UPDATE agent_usage_entry SET usage_day = DATE(created_at), settled_at = created_at',
    )
    // 投递效果永久唯一，不因会话或收据软删除释放标识，否则断线重试可再次触发模型。
    await q.query(`CREATE TABLE agent_message_receipt (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '投递收据 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      user_id bigint unsigned NOT NULL COMMENT '发起人 ID',
      thread_id bigint unsigned NOT NULL COMMENT '所属会话 ID',
      client_message_id varchar(36) NOT NULL COMMENT '客户端发送意图',
      request_hash char(64) NOT NULL COMMENT '规范化消息内容摘要',
      item_id bigint unsigned NOT NULL COMMENT '首次接收条目 ID',
      accepted_turn_id bigint unsigned NOT NULL COMMENT '首次接收轮次 ID',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_message_client (tenant_id, user_id, client_message_id),
      KEY idx_agent_message_thread (tenant_id, thread_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='客户端发送意图的永久接收记录'`)
  }

  async down(q: QueryRunner): Promise<void> {
    // qw:cross-tenant 回退前跨租户检查不可丢失的未完成计量、写入风险与永久投递事实。
    const [unsafe] = (await q.query(`SELECT 1 AS unsafe WHERE
      EXISTS (SELECT 1 FROM agent_usage_entry WHERE status = 'pending') OR
      EXISTS (SELECT 1 FROM agent_thread WHERE recovery_required = 1 OR client_draft_id IS NOT NULL) OR
      EXISTS (SELECT 1 FROM agent_message_receipt)`)) as { unsafe: number }[]
    if (unsafe)
      throw new Error(
        'Unfinished recovery or durable delivery records require reconciliation before rollback',
      )
    await q.query('DROP TABLE agent_message_receipt')
    await q.query(`ALTER TABLE agent_usage_entry DROP INDEX idx_agent_usage_pending,
      DROP status, DROP lease_until, DROP settled_at, DROP usage_day, DROP parent_turn_id`)
    await q.query('ALTER TABLE agent_item DROP revision')
    await q.query('ALTER TABLE agent_turn DROP INDEX idx_agent_turn_parent, DROP parent_turn_id')
    await q.query(`ALTER TABLE agent_thread DROP INDEX uk_agent_thread_client,
      DROP client_draft_id, DROP client_draft_hash, DROP recovery_required, DROP recovery_revision`)
  }
}
