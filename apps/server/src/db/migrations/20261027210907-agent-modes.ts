import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 会话只用一个模式（只读 / 计划 / 每次询问 / 自动审查），工具策略新增“仅人工确认”。
 * 原“信任本会话”模式并入每次询问：它按单条记录记下的信任与新的“本会话内此工具不再询问”含义不同，
 * 一并清空，不把旧的逐条同意放大成整个工具的放行。
 */
export class AgentModes20261027210907 implements MigrationInterface {
  name = 'AgentModes20261027210907'

  async up(q: QueryRunner): Promise<void> {
    // qw:cross-tenant 模式值是全平台的枚举，所有租户的会话与配置方案一起换算
    await q.query(
      `UPDATE agent_thread SET approval_mode = 'plan' WHERE plan_mode = 1 AND approval_mode <> 'read_only'`,
    )
    // qw:cross-tenant 同上
    await q.query(`UPDATE agent_thread SET approval_mode = 'ask' WHERE approval_mode = 'trust'`)
    // qw:cross-tenant 旧信任按单条记录记，不能当成新的按工具放行
    await q.query('UPDATE agent_thread SET trusted = NULL WHERE trusted IS NOT NULL')
    await q.query(`ALTER TABLE agent_thread
      MODIFY approval_mode varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ask' COMMENT '会话模式（read_only、plan、ask、auto_review）',
      MODIFY trusted json NULL COMMENT '本会话内不再询问的工具',
      DROP COLUMN plan_mode`)
    // qw:cross-tenant 同上
    await q.query(`UPDATE agent_profile SET approval_mode = 'ask' WHERE approval_mode = 'trust'`)
    // 自动审查对所有需确认的写入生效后，`review` 与 `ask` 含义相同
    await q.query(`UPDATE cfg_mcp_tool SET agent_policy = 'ask' WHERE agent_policy = 'review'`)
    // 外部 MCP 工具的策略同样可能是 `review`
    await q.query(`UPDATE agent_mcp_tool SET policy = 'ask' WHERE policy = 'review'`)
    // 平台参数已退役
    await q.query(`DELETE FROM cfg_param WHERE param_key = 'agent.trust_mode'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE agent_thread
      ADD plan_mode tinyint NOT NULL DEFAULT 0 COMMENT '计划模式（先出计划、只读）' AFTER approval_mode,
      MODIFY trusted json NULL COMMENT '信任本会话时已确认过的操作（工具名 + 目标）'`)
    // qw:cross-tenant 计划模式拆回独立开关
    await q.query(
      `UPDATE agent_thread SET plan_mode = 1, approval_mode = 'ask' WHERE approval_mode = 'plan'`,
    )
    // qw:cross-tenant 配置方案里的计划模式在旧代码里不存在，退回每次询问
    await q.query(`UPDATE agent_profile SET approval_mode = 'ask' WHERE approval_mode = 'plan'`)
    // qw:cross-tenant 新的按工具放行在旧代码里没有对应含义
    await q.query('UPDATE agent_thread SET trusted = NULL WHERE trusted IS NOT NULL')
    await q.query(`ALTER TABLE agent_thread
      MODIFY approval_mode varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ask' COMMENT '审批模式（read_only、ask、trust）'`)
    // 旧代码不认识“仅人工确认”，退回需确认；原来的 `review` 已无法区分，不恢复
    await q.query(`UPDATE cfg_mcp_tool SET agent_policy = 'ask' WHERE agent_policy = 'human'`)
    await q.query(`UPDATE agent_mcp_tool SET policy = 'ask' WHERE policy = 'human'`)
  }
}
