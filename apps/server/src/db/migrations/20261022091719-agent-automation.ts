import type { MigrationInterface, QueryRunner } from 'typeorm'

/** The agent, second part: profiles, memories, automations and their runs; thread links for them. */
export class AgentAutomation20261022091719 implements MigrationInterface {
  name = 'AgentAutomation20261022091719'

  async up(q: QueryRunner): Promise<void> {
    // 命名的组合：模型、推理强度、审批模式、允许的工具、额外说明；个人或全租户共用（owner_user_id = 0）
    await q.query(`CREATE TABLE agent_profile (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '配置方案 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      owner_user_id bigint unsigned NOT NULL DEFAULT 0 COMMENT '所属用户 ID（0 为全租户共用）',
      name varchar(64) NOT NULL COMMENT '名称',
      provider_id bigint unsigned NULL COMMENT '模型提供方 ID',
      model varchar(128) NULL COMMENT '模型名',
      reasoning varchar(16) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '推理强度',
      approval_mode varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ask' COMMENT '审批模式',
      tools json NULL COMMENT '允许的工具名（空为不限）',
      instructions text NULL COMMENT '额外说明',
      is_default tinyint NOT NULL DEFAULT 0 COMMENT '是否为本人默认',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_profile_name (tenant_id, owner_user_id, name, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体配置方案'`)

    // 每人一个记忆库：只本人可见、可改、可全部忘记；保存前遮蔽密钥类内容
    await q.query(`CREATE TABLE agent_memory (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '记忆 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      user_id bigint unsigned NOT NULL COMMENT '所属用户 ID',
      content varchar(1000) NOT NULL COMMENT '记忆内容',
      source varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'chat' COMMENT '来源（chat 对话中保存、extract 后台提炼、manual 手工）',
      source_thread_id bigint unsigned NULL COMMENT '来源会话 ID',
      last_used_at datetime(3) NULL COMMENT '最近使用时间（UTC）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_agent_memory_user (tenant_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体记忆'`)

    // 定时、业务事件或手动触发的技能 / 提示词；以所属用户（或共享时的创建人）的身份运行
    await q.query(`CREATE TABLE agent_automation (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '自动化 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      user_id bigint unsigned NOT NULL COMMENT '所属用户 ID（以其身份运行）',
      name varchar(100) NOT NULL COMMENT '名称',
      enabled tinyint NOT NULL DEFAULT 1 COMMENT '是否启用',
      shared tinyint NOT NULL DEFAULT 0 COMMENT '是否全租户共享',
      trigger_kind varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '触发方式（schedule、event、manual）',
      cron varchar(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'cron 表达式（定时）',
      timezone varchar(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '时区（定时）',
      event json NULL COMMENT '触发事件（操作日志的领域、动作、资源）',
      skill varchar(64) NULL COMMENT '执行的技能名',
      prompt text NULL COMMENT '提示词',
      profile_id bigint unsigned NULL COMMENT '配置方案 ID',
      write_mode varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'read_only' COMMENT '写入模式（read_only、ask、pre_approved、auto_review）',
      pre_approved json NULL COMMENT '预先同意的写入工具（及同意时间）',
      notify json NULL COMMENT '结果通知方式',
      last_run_at datetime(3) NULL COMMENT '最近运行时间（UTC）',
      next_run_at datetime(3) NULL COMMENT '下次运行时间（UTC）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_automation_name (tenant_id, user_id, name, alive),
      KEY idx_agent_automation_event (tenant_id, trigger_kind, enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体自动化'`)

    // 每次运行一条：触发来源、对应的隐藏会话、结果摘要
    await q.query(`CREATE TABLE agent_automation_run (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '运行 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      automation_id bigint unsigned NOT NULL COMMENT '自动化 ID',
      thread_id bigint unsigned NULL COMMENT '运行用的会话 ID',
      trigger_kind varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '触发方式（schedule、event、manual）',
      event json NULL COMMENT '触发事件内容（记录 ID 等）',
      status varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'running' COMMENT '状态（running、waiting、completed、failed、cancelled、skipped）',
      summary text NULL COMMENT '结果摘要',
      error_code varchar(32) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '失败原因代码',
      started_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '开始时间（UTC）',
      ended_at datetime(3) NULL COMMENT '结束时间（UTC）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_agent_automation_run (tenant_id, automation_id, started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体自动化运行记录'`)

    // 会话：所用配置方案、是否用记忆、子智能体的父会话、自动化运行
    await q.query(`ALTER TABLE agent_thread
      ADD COLUMN profile_id bigint unsigned NULL COMMENT '配置方案 ID' AFTER reasoning,
      ADD COLUMN memory_enabled tinyint NOT NULL DEFAULT 1 COMMENT '本会话是否使用记忆' AFTER profile_id,
      ADD COLUMN parent_thread_id bigint unsigned NULL COMMENT '父会话 ID（子智能体的会话）' AFTER forked_from_id,
      ADD COLUMN automation_run_id bigint unsigned NULL COMMENT '自动化运行 ID' AFTER parent_thread_id,
      ADD KEY idx_agent_thread_parent (tenant_id, parent_thread_id)`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      'ALTER TABLE agent_thread DROP KEY idx_agent_thread_parent, DROP COLUMN automation_run_id, DROP COLUMN parent_thread_id, DROP COLUMN memory_enabled, DROP COLUMN profile_id',
    )
    await q.query('DROP TABLE agent_automation_run')
    await q.query('DROP TABLE agent_automation')
    await q.query('DROP TABLE agent_memory')
    await q.query('DROP TABLE agent_profile')
  }
}
