import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Workflow (see docs/design-notes.md#workflow) and its OA leave sample: every `wf_*` table but `wf_form` plus
 * `biz_leave_request`, with `wf_instance.initiator_ctx`/`urged_at` and
 * `wf_task.from_task_id`/`due_at`/`reminded_at`. Every table soft-deleted, a unique key ends with
 * `alive`, no foreign keys (the `*_id` columns are plain ids; the services check them). Enum codes are
 * the dicts `wf.category`, `wf.instance_state`, `wf.task_state`, `wf.action`, `biz.leave_kind` (seeded
 * by db/seeds/workflow) and the shared `WF_*` constants. `wf_version` is insert-only (a published
 * snapshot); `wf_cc` and `wf_event` rows are written by the server only (no update audit columns). The
 * column comments are the generator's zh-CN labels (`biz_leave_request` is generated).
 */
export class Wf20260930100000 implements MigrationInterface {
  name = 'Wf20260930100000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE wf_model (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '模型 ID',
      model_key varchar(64) NOT NULL COMMENT '模型标识（业务处理器按它注册）',
      name varchar(128) NOT NULL COMMENT '模型名称（种子为 seed.wf.* 键）',
      category varchar(24) NOT NULL DEFAULT 'other' COMMENT '分类（字典 wf.category）',
      icon varchar(64) NULL COMMENT '图标',
      description varchar(500) NULL COMMENT '说明',
      form_kind varchar(8) NOT NULL COMMENT '表单类型（dynamic/custom）',
      form_id bigint unsigned NULL COMMENT '动态表单 ID（form_kind=dynamic）',
      create_route varchar(255) NULL COMMENT '发起页路由（form_kind=custom，如 /biz/leave/new）',
      view_component varchar(255) NULL COMMENT '单据查看组件（views 相对路径，如 biz/leave/view）',
      draft_json json NULL COMMENT '设计草稿（流程树 JSON）',
      initiator_scope json NULL COMMENT '发起范围（{userIds,deptIds,roleIds}；为空则所有人）',
      manager_user_ids json NULL COMMENT '模型管理员用户 ID 列表',
      allow_cancel tinyint(1) NOT NULL DEFAULT 1 COMMENT '允许发起人撤销',
      allow_withdraw tinyint(1) NOT NULL DEFAULT 1 COMMENT '允许审批人撤回',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      sort_no int NOT NULL DEFAULT 0 COMMENT '排序号',
      current_version_id bigint unsigned NULL COMMENT '当前版本 ID（为空则未发布）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC，软删）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_wf_model_key (model_key, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='流程模型'`)

    await q.query(`CREATE TABLE wf_version (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '版本 ID',
      model_id bigint unsigned NOT NULL COMMENT '模型 ID',
      model_key varchar(64) NOT NULL COMMENT '模型标识',
      version int unsigned NOT NULL COMMENT '版本号（每个模型从 1 起）',
      tree_json json NOT NULL COMMENT '流程树 JSON（发布快照）',
      form_snapshot json NOT NULL COMMENT '表单快照（含 fields 字段清单）',
      published_by bigint unsigned NULL COMMENT '发布人 ID（为空则种子）',
      published_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '发布时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC，软删）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_wf_version_model_version (model_key, version, alive),
      KEY idx_wf_version_model (model_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='流程版本（只插入）'`)

    await q.query(`CREATE TABLE wf_instance (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '实例 ID',
      version_id bigint unsigned NOT NULL COMMENT '流程版本 ID',
      model_key varchar(64) NOT NULL COMMENT '模型标识（标题读取时按读者语言拼接，不入库）',
      business_key varchar(128) NULL COMMENT '业务键（form_kind=custom 的业务单据 ID）',
      initiator_id bigint unsigned NOT NULL COMMENT '发起人 ID',
      initiator_dept_id bigint unsigned NULL COMMENT '发起人部门 ID（管理侧数据范围）',
      state varchar(12) NOT NULL DEFAULT 'running' COMMENT '状态（字典 wf.instance_state）',
      form_values json NOT NULL COMMENT '表单值',
      initiator_picks json NOT NULL COMMENT '发起人自选审批人（节点 ID → 用户 ID 列表）',
      initiator_ctx json NOT NULL COMMENT '发起人上下文（{deptTreePath, roleIds}，发起时解析一次）',
      active_node_ids json NOT NULL COMMENT '持有令牌的节点 ID 列表（并行时多个）',
      urged_at datetime(3) NULL COMMENT '上次催办时间（UTC，每小时限 1 次）',
      started_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '发起时间（UTC）',
      ended_at datetime(3) NULL COMMENT '结束时间（UTC）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC，软删）',
      PRIMARY KEY (id),
      KEY idx_wf_instance_initiator_state (initiator_id, state),
      KEY idx_wf_instance_business (business_key),
      KEY idx_wf_instance_dept (initiator_dept_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='流程实例'`)

    await q.query(`CREATE TABLE wf_task (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '任务 ID',
      instance_id bigint unsigned NOT NULL COMMENT '实例 ID',
      node_id varchar(64) NOT NULL COMMENT '节点 ID',
      node_name varchar(64) NOT NULL COMMENT '节点名称（种子为 seed.wf.* 键）',
      assignee_id bigint unsigned NOT NULL COMMENT '办理人 ID',
      owner_id bigint unsigned NULL COMMENT '委派前的原办理人 ID',
      parent_task_id bigint unsigned NULL COMMENT '加签的父任务 ID',
      from_task_id bigint unsigned NULL COMMENT '来源任务 ID（由哪个任务的完成而生成，撤回按它认定）',
      sign_kind varchar(8) NULL COMMENT '加签方式（before/after）',
      seq int unsigned NOT NULL DEFAULT 0 COMMENT '依次审批中的顺序',
      state varchar(12) NOT NULL DEFAULT 'pending' COMMENT '状态（字典 wf.task_state）',
      comment varchar(1000) NULL COMMENT '审批意见',
      due_at datetime(3) NULL COMMENT '到期时间（UTC，节点有超时提醒时）',
      reminded_at datetime(3) NULL COMMENT '上次超时提醒时间（UTC）',
      handled_at datetime(3) NULL COMMENT '办理时间（UTC）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC，软删）',
      PRIMARY KEY (id),
      KEY idx_wf_task_assignee_state (assignee_id, state),
      KEY idx_wf_task_instance (instance_id),
      KEY idx_wf_task_state_due (state, due_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='流程任务'`)

    await q.query(`CREATE TABLE wf_cc (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '抄送 ID',
      instance_id bigint unsigned NOT NULL COMMENT '实例 ID',
      node_id varchar(64) NOT NULL COMMENT '节点 ID',
      user_id bigint unsigned NOT NULL COMMENT '抄送给的用户 ID',
      from_task_id bigint unsigned NULL COMMENT '来源任务 ID（为空则发起时经过的抄送节点）',
      from_user_id bigint unsigned NULL COMMENT '手动抄送人 ID（为空则抄送节点）',
      reason varchar(1000) NULL COMMENT '抄送说明',
      read_at datetime(3) NULL COMMENT '阅读时间（UTC）',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC，软删）',
      PRIMARY KEY (id),
      KEY idx_wf_cc_user (user_id),
      KEY idx_wf_cc_instance (instance_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='流程抄送'`)

    await q.query(`CREATE TABLE wf_event (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '事件 ID',
      instance_id bigint unsigned NOT NULL COMMENT '实例 ID',
      task_id bigint unsigned NULL COMMENT '任务 ID',
      node_id varchar(64) NULL COMMENT '节点 ID',
      actor_id bigint unsigned NULL COMMENT '操作人 ID（为空则系统）',
      action varchar(16) NOT NULL COMMENT '动作（字典 wf.action）',
      target_ids json NULL COMMENT '目标（用户 ID 列表；退回为目标节点 ID）',
      comment varchar(1000) NULL COMMENT '意见',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC，软删）',
      PRIMARY KEY (id),
      KEY idx_wf_event_instance (instance_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='流程事件（时间线）'`)

    await q.query(`CREATE TABLE biz_leave_request (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '请假单 ID',
      user_id bigint unsigned NOT NULL COMMENT '申请人 ID',
      dept_id bigint unsigned NULL COMMENT '申请人部门 ID',
      leave_kind varchar(16) NOT NULL COMMENT '请假类型（字典 biz.leave_kind）',
      start_at datetime(3) NOT NULL COMMENT '开始时间（UTC）',
      end_at datetime(3) NOT NULL COMMENT '结束时间（UTC）',
      days decimal(5,1) NOT NULL COMMENT '请假天数',
      reason varchar(500) NOT NULL COMMENT '请假事由',
      state varchar(12) NOT NULL DEFAULT 'draft' COMMENT '状态（draft/in_review/approved/rejected/canceled）',
      instance_id bigint unsigned NULL COMMENT '流程实例 ID（为空则未发起）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC，软删）',
      PRIMARY KEY (id),
      KEY idx_biz_leave_request_user (user_id),
      KEY idx_biz_leave_request_dept (dept_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='请假申请'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      'DROP TABLE biz_leave_request, wf_event, wf_cc, wf_task, wf_instance, wf_version, wf_model',
    )
  }
}
