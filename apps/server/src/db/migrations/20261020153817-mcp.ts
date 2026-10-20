import type { MigrationInterface, QueryRunner } from 'typeorm'

/** Agent access over MCP: personal access tokens (per tenant) and the platform's per-tool switch. */
export class Mcp20261020153817 implements MigrationInterface {
  name = 'Mcp20261020153817'

  async up(q: QueryRunner): Promise<void> {
    // 令牌明文只在创建时返回一次，库里只存 SHA-256 摘要；摘要由服务端随机生成，全局唯一不会跨租户冲突
    await q.query(`CREATE TABLE iam_access_token (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '访问令牌 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      user_id bigint unsigned NOT NULL COMMENT '所属用户 ID',
      name varchar(64) NOT NULL COMMENT '令牌名称',
      token_digest char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '令牌 SHA-256 摘要',
      token_hint varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '令牌末尾几位（展示用）',
      tools json NULL COMMENT '允许的工具名（空为全部只读工具）',
      allow_write tinyint NOT NULL DEFAULT 0 COMMENT '是否允许写入类工具',
      expires_at datetime(3) NULL COMMENT '到期时间（UTC，空为不过期）',
      last_used_at datetime(3) NULL COMMENT '最近使用时间（UTC）',
      revoked_at datetime(3) NULL COMMENT '吊销时间（UTC）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      KEY idx_iam_access_token_tenant (tenant_id, user_id),
      UNIQUE KEY uk_iam_access_token_digest (token_digest, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='个人访问令牌（智能体接入）'`)

    // 平台对已注册工具的整体停用；没有行的工具按启用处理，所以新增工具不需要改表
    await q.query(`CREATE TABLE cfg_mcp_tool (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '记录 ID',
      name varchar(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '工具名',
      enabled tinyint NOT NULL DEFAULT 1 COMMENT '是否启用',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_cfg_mcp_tool_name (name, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='MCP 工具启用状态（平台）'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE cfg_mcp_tool')
    await q.query('DROP TABLE iam_access_token')
  }
}
