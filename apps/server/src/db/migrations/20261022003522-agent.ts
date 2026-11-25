import type { MigrationInterface, QueryRunner } from 'typeorm'

/** The in-app agent: providers, external MCP servers, skills, instructions, threads, usage, a sample customer. */
export class Agent20261022003522 implements MigrationInterface {
  name = 'Agent20261022003522'

  async up(q: QueryRunner): Promise<void> {
    // 模型提供方由平台（root）统一配置，所有租户共用；密钥用 secret-box 加密，接口只写不读回
    await q.query(`CREATE TABLE agent_provider (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '提供方 ID',
      name varchar(64) NOT NULL COMMENT '名称',
      kind varchar(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'openai-compatible' COMMENT '接口类型',
      base_url varchar(512) NOT NULL COMMENT '接口地址',
      api_key json NULL COMMENT '密钥（加密存储，只写不读）',
      models json NOT NULL COMMENT '可用模型及其参数',
      enabled tinyint NOT NULL DEFAULT 1 COMMENT '是否启用',
      is_default tinyint NOT NULL DEFAULT 0 COMMENT '是否默认提供方',
      sort int NOT NULL DEFAULT 0 COMMENT '排序',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_provider_name (name, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体模型提供方（平台）'`)

    // 联网搜索的服务商，平台统一配置
    await q.query(`CREATE TABLE agent_search_provider (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '搜索提供方 ID',
      kind varchar(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '提供方类型（bocha、tavily）',
      name varchar(64) NOT NULL COMMENT '名称',
      api_key json NULL COMMENT '密钥（加密存储，只写不读）',
      enabled tinyint NOT NULL DEFAULT 1 COMMENT '是否启用',
      is_default tinyint NOT NULL DEFAULT 0 COMMENT '是否默认',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_search_provider_name (name, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体联网搜索提供方（平台）'`)

    // 外部 MCP 服务器由平台添加；工具返回的内容一律按不可信外部内容处理
    await q.query(`CREATE TABLE agent_mcp_server (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '服务器 ID',
      name varchar(64) NOT NULL COMMENT '名称',
      url varchar(512) NOT NULL COMMENT 'Streamable HTTP 地址',
      auth_kind varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'none' COMMENT '鉴权方式（none、header、oauth）',
      auth_secret json NULL COMMENT '鉴权信息（加密存储，只写不读）',
      allow_private tinyint NOT NULL DEFAULT 0 COMMENT '是否允许内网地址',
      enabled tinyint NOT NULL DEFAULT 1 COMMENT '是否启用',
      status varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'unknown' COMMENT '最近连接状态',
      last_error varchar(512) NULL COMMENT '最近一次连接错误',
      synced_at datetime(3) NULL COMMENT '最近同步工具列表的时间（UTC）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_mcp_server_name (name, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体外部 MCP 服务器（平台）'`)

    // 新发现的外部工具默认停用、默认需要确认，由管理员逐个启用
    await q.query(`CREATE TABLE agent_mcp_tool (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '外部工具 ID',
      server_id bigint unsigned NOT NULL COMMENT '所属服务器 ID',
      name varchar(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '服务器上的工具名',
      title varchar(200) NULL COMMENT '标题',
      description text NULL COMMENT '描述（来自服务器，不可信）',
      input_schema json NULL COMMENT '参数 JSON Schema（来自服务器）',
      read_only_hint tinyint NOT NULL DEFAULT 0 COMMENT '服务器声明为只读（不可信，仅供参考）',
      enabled tinyint NOT NULL DEFAULT 0 COMMENT '是否启用（新发现的工具默认停用）',
      policy varchar(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ask' COMMENT '审批策略（auto、ask、deny）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_mcp_tool_name (server_id, name, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体外部 MCP 工具（平台）'`)

    // 平台技能对所有租户可用；租户与个人的技能在 agent_skill
    await q.query(`CREATE TABLE agent_platform_skill (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '技能 ID',
      name varchar(64) NOT NULL COMMENT '技能名',
      description varchar(512) NOT NULL COMMENT '何时使用（智能体据此选择）',
      body mediumtext NOT NULL COMMENT '技能正文（说明文字）',
      tools json NULL COMMENT '允许使用的工具名（空为不限）',
      enabled tinyint NOT NULL DEFAULT 1 COMMENT '是否启用',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_platform_skill_name (name, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体技能（平台，所有租户可用）'`)

    // 租户共用技能 owner_user_id = 0，个人技能记所属用户
    await q.query(`CREATE TABLE agent_skill (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '技能 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      owner_user_id bigint unsigned NOT NULL DEFAULT 0 COMMENT '所属用户 ID（0 为全租户共用）',
      name varchar(64) NOT NULL COMMENT '技能名',
      description varchar(512) NOT NULL COMMENT '何时使用（智能体据此选择）',
      body mediumtext NOT NULL COMMENT '技能正文（说明文字）',
      tools json NULL COMMENT '允许使用的工具名（空为不限）',
      enabled tinyint NOT NULL DEFAULT 1 COMMENT '是否启用',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_skill_name (tenant_id, owner_user_id, name, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体技能（租户与个人）'`)

    // 拼进系统提示：平台说明（系统参数）→ 租户说明 → 个人说明
    await q.query(`CREATE TABLE agent_instruction (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '说明 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      owner_user_id bigint unsigned NOT NULL DEFAULT 0 COMMENT '所属用户 ID（0 为租户说明）',
      body text NOT NULL COMMENT '说明正文',
      tone varchar(16) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '回答语气预设（仅个人说明）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_instruction_owner (tenant_id, owner_user_id, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体说明（租户与个人）'`)

    // 提示词模板：个人（owner_user_id 记本人）或全租户共用（0）
    await q.query(`CREATE TABLE agent_prompt (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '模板 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      owner_user_id bigint unsigned NOT NULL DEFAULT 0 COMMENT '所属用户 ID（0 为全租户共用）',
      name varchar(64) NOT NULL COMMENT '模板名',
      body text NOT NULL COMMENT '模板内容',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_prompt_name (tenant_id, owner_user_id, name, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体提示词模板'`)

    // 对回答的点赞点踩与文字反馈，带 traceId 便于排查
    await q.query(`CREATE TABLE agent_feedback (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '反馈 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      thread_id bigint unsigned NOT NULL COMMENT '会话 ID',
      item_id bigint unsigned NOT NULL COMMENT '被评价的条目 ID',
      user_id bigint unsigned NOT NULL COMMENT '反馈人 ID',
      rating tinyint NOT NULL COMMENT '评价（1 赞、-1 踩）',
      comment varchar(1000) NULL COMMENT '文字反馈',
      trace_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '追踪 ID',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_feedback_user (tenant_id, item_id, user_id, alive),
      KEY idx_agent_feedback_thread (tenant_id, thread_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体回答反馈'`)

    // 列表里选中多条记录批量执行一个技能：每条一个会话
    await q.query(`CREATE TABLE agent_batch (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '批次 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      user_id bigint unsigned NOT NULL COMMENT '发起人 ID',
      skill_name varchar(64) NOT NULL COMMENT '执行的技能名',
      target varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '目标数据类型（如 demo.customer）',
      status varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'running' COMMENT '状态',
      total int NOT NULL DEFAULT 0 COMMENT '目标总数',
      finished int NOT NULL DEFAULT 0 COMMENT '已完成数',
      failed int NOT NULL DEFAULT 0 COMMENT '失败数',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_agent_batch_tenant (tenant_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体批量任务'`)

    // 会话 → 轮次 → 条目：每一步落库，页面与模型上下文都从这里恢复
    await q.query(`CREATE TABLE agent_thread (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '会话 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      user_id bigint unsigned NOT NULL COMMENT '所属用户 ID',
      title varchar(200) NOT NULL COMMENT '标题',
      status varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'active' COMMENT '状态（active、archived）',
      provider_id bigint unsigned NULL COMMENT '模型提供方 ID',
      model varchar(128) NULL COMMENT '模型名',
      reasoning varchar(16) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '推理强度',
      approval_mode varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ask' COMMENT '审批模式（read_only、ask、trust）',
      plan_mode tinyint NOT NULL DEFAULT 0 COMMENT '计划模式（先出计划、只读）',
      pinned tinyint NOT NULL DEFAULT 0 COMMENT '是否置顶',
      temporary tinyint NOT NULL DEFAULT 0 COMMENT '临时会话（不进列表，关闭即删）',
      read_seq int NOT NULL DEFAULT 0 COMMENT '所属用户已读到的条目序号',
      share_token char(32) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '只读分享令牌（同租户内有效）',
      trusted json NULL COMMENT '信任本会话时已确认过的操作',
      forked_from_id bigint unsigned NULL COMMENT '分叉来源会话 ID',
      batch_id bigint unsigned NULL COMMENT '所属批次 ID',
      target_ref varchar(128) NULL COMMENT '批量或页面上下文的目标记录',
      context json NULL COMMENT '发起时的页面上下文',
      summary mediumtext NULL COMMENT '压缩后的早期对话摘要',
      summary_seq int NOT NULL DEFAULT 0 COMMENT '摘要覆盖到的条目序号',
      last_active_at datetime(3) NULL COMMENT '最近活动时间（UTC）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_thread_share (tenant_id, share_token, alive),
      KEY idx_agent_thread_user (tenant_id, user_id, last_active_at),
      KEY idx_agent_thread_batch (tenant_id, batch_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体会话'`)

    // 一轮 = 用户一句话到智能体答完（中间可能停下等审批）
    await q.query(`CREATE TABLE agent_turn (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '轮次 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      thread_id bigint unsigned NOT NULL COMMENT '所属会话 ID',
      user_id bigint unsigned NOT NULL COMMENT '发起人 ID',
      status varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'running' COMMENT '状态（running、waiting、completed、failed、cancelled）',
      steps int NOT NULL DEFAULT 0 COMMENT '已执行步数',
      prompt_tokens int NOT NULL DEFAULT 0 COMMENT '输入 token 数',
      completion_tokens int NOT NULL DEFAULT 0 COMMENT '输出 token 数',
      error_code varchar(32) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '失败原因代码',
      error_msg varchar(512) NULL COMMENT '失败说明',
      started_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '开始时间（UTC）',
      ended_at datetime(3) NULL COMMENT '结束时间（UTC）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_agent_turn_thread (tenant_id, thread_id),
      KEY idx_agent_turn_user_status (tenant_id, user_id, status),
      KEY idx_agent_turn_status (status, started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体轮次'`)

    // 条目按顺序号排列，模型上下文与页面都从这里恢复
    await q.query(`CREATE TABLE agent_item (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '条目 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      thread_id bigint unsigned NOT NULL COMMENT '所属会话 ID',
      turn_id bigint unsigned NULL COMMENT '所属轮次 ID',
      seq int NOT NULL COMMENT '会话内顺序号',
      kind varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '类型（user、assistant、tool_call、tool_result、approval、plan、error）',
      status varchar(16) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '工具调用与审批的状态',
      payload json NOT NULL COMMENT '内容',
      text mediumtext NULL COMMENT '可检索的纯文本（用户与智能体的消息）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_item_seq (tenant_id, thread_id, seq, alive),
      KEY idx_agent_item_turn (tenant_id, turn_id),
      KEY idx_agent_item_open (turn_id, kind, status),
      FULLTEXT KEY ft_agent_item_text (text) WITH PARSER ngram
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体会话条目'`)

    // 每用户、每天、每模型一行，限额与用量页都读它
    await q.query(`CREATE TABLE agent_usage (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '记录 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      user_id bigint unsigned NOT NULL COMMENT '用户 ID',
      day date NOT NULL COMMENT '日期（UTC）',
      model varchar(128) NOT NULL COMMENT '模型名',
      calls int NOT NULL DEFAULT 0 COMMENT '模型调用次数',
      prompt_tokens bigint unsigned NOT NULL DEFAULT 0 COMMENT '输入 token 数',
      completion_tokens bigint unsigned NOT NULL DEFAULT 0 COMMENT '输出 token 数',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_agent_usage_day (tenant_id, user_id, day, model, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='智能体用量（按日）'`)

    // 示例客户：演示“让智能体联网补齐客户信息”
    await q.query(`CREATE TABLE demo_customer (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '客户 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      name varchar(200) NOT NULL COMMENT '客户名称',
      website varchar(512) NULL COMMENT '官网',
      industry varchar(64) NULL COMMENT '行业',
      city varchar(64) NULL COMMENT '城市',
      scale varchar(32) NULL COMMENT '规模',
      phone varchar(32) NULL COMMENT '电话',
      address varchar(255) NULL COMMENT '地址',
      intro text NULL COMMENT '简介',
      dept_id bigint unsigned NULL COMMENT '所属部门 ID（数据权限）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_demo_customer_name (tenant_id, name, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='客户（智能体示例）'`)

    // 本系统工具在智能体里的审批策略（auto、ask、deny）；空为按类型默认：只读 auto、写入 ask
    await q.query(
      "ALTER TABLE cfg_mcp_tool ADD COLUMN agent_policy varchar(8) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '智能体审批策略（空为按类型默认）' AFTER enabled",
    )
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE cfg_mcp_tool DROP COLUMN agent_policy')
    await q.query('DROP TABLE demo_customer')
    await q.query('DROP TABLE agent_usage')
    await q.query('DROP TABLE agent_item')
    await q.query('DROP TABLE agent_turn')
    await q.query('DROP TABLE agent_thread')
    await q.query('DROP TABLE agent_batch')
    await q.query('DROP TABLE agent_feedback')
    await q.query('DROP TABLE agent_prompt')
    await q.query('DROP TABLE agent_instruction')
    await q.query('DROP TABLE agent_skill')
    await q.query('DROP TABLE agent_platform_skill')
    await q.query('DROP TABLE agent_mcp_tool')
    await q.query('DROP TABLE agent_mcp_server')
    await q.query('DROP TABLE agent_search_provider')
    await q.query('DROP TABLE agent_provider')
  }
}
