import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 租户对智能体工具的收紧：平台策略之上，租户管理员只能把工具改成“仅人工确认”或“停用”，
 * 生效值总取两者中更严的一方，所以这里只存 `human` / `deny`。
 */
export class AgentToolRestriction20261028103525 implements MigrationInterface {
  name = 'AgentToolRestriction20261028103525'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE agent_tool_restriction (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '收紧 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      tool varchar(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '工具名；外部 MCP 工具为 mcp:<agent_mcp_tool.id>',
      policy varchar(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '收紧后的策略（human、deny）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_tool_restriction (tenant_id, tool, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体工具的租户收紧'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS agent_tool_restriction')
  }
}
