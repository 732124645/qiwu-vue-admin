import type { MigrationInterface, QueryRunner } from 'typeorm'

/** 办公业务单据：按租户隔离，流程实例与业务结果由同一事务维护。 */
export class OaOffice20261022164843 implements MigrationInterface {
  name = 'OaOffice20261022164843'

  /** 建立出差、报销主子表与用印单据，保留已有请假表与历史流程。 */
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE oa_trip_request (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '单据 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      user_id bigint unsigned NOT NULL COMMENT '申请人 ID',
      dept_id bigint unsigned NULL COMMENT '申请人部门 ID',
      destination varchar(200) NOT NULL COMMENT '目的地',
      start_at datetime(3) NOT NULL COMMENT '开始时间（UTC）',
      end_at datetime(3) NOT NULL COMMENT '结束时间（UTC）',
      reason varchar(500) NOT NULL COMMENT '出差事由',
      estimated_amount decimal(12,2) NULL COMMENT '预计费用（人民币元）',
      attachment_ids json NULL COMMENT '附件对象 ID 列表',
      state varchar(12) NOT NULL DEFAULT 'draft' COMMENT '状态（draft/in_review/approved/rejected/canceled）',
      instance_id bigint unsigned NULL COMMENT '流程实例 ID（为空则未发起）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_oa_trip_request_instance (tenant_id, instance_id, alive),
      KEY idx_oa_trip_request_user (tenant_id, user_id, created_at),
      KEY idx_oa_trip_request_dept (tenant_id, dept_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='出差申请'`)

    await q.query(`CREATE TABLE oa_expense_claim (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '单据 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      user_id bigint unsigned NOT NULL COMMENT '申请人 ID',
      dept_id bigint unsigned NULL COMMENT '申请人部门 ID',
      reason varchar(500) NOT NULL COMMENT '报销事由',
      trip_id bigint unsigned NULL COMMENT '关联本人的出差申请 ID',
      total_amount decimal(12,2) NOT NULL COMMENT '明细汇总金额（人民币元）',
      currency varchar(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'CNY' COMMENT '币种',
      attachment_ids json NULL COMMENT '附件对象 ID 列表',
      state varchar(12) NOT NULL DEFAULT 'draft' COMMENT '状态（draft/in_review/approved/rejected/canceled）',
      instance_id bigint unsigned NULL COMMENT '流程实例 ID（为空则未发起）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_oa_expense_claim_instance (tenant_id, instance_id, alive),
      KEY idx_oa_expense_claim_user (tenant_id, user_id, created_at),
      KEY idx_oa_expense_claim_dept (tenant_id, dept_id),
      KEY idx_oa_expense_claim_trip (tenant_id, trip_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='报销申请'`)

    await q.query(`CREATE TABLE oa_expense_item (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '明细 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      claim_id bigint unsigned NOT NULL COMMENT '报销申请 ID',
      expense_date date NOT NULL COMMENT '费用发生日期',
      expense_kind varchar(32) NOT NULL COMMENT '费用类别（字典 oa.expense_kind）',
      amount decimal(12,2) NOT NULL COMMENT '费用金额（人民币元）',
      description varchar(200) NOT NULL COMMENT '费用说明',
      attachment_ids json NULL COMMENT '附件对象 ID 列表',
      sort_no int NOT NULL DEFAULT 0 COMMENT '排序号',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_oa_expense_item_claim (tenant_id, claim_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='报销明细'`)

    await q.query(`CREATE TABLE oa_seal_request (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '单据 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      user_id bigint unsigned NOT NULL COMMENT '申请人 ID',
      dept_id bigint unsigned NULL COMMENT '申请人部门 ID',
      seal_kind varchar(32) NOT NULL COMMENT '印章类型（字典 oa.seal_kind）',
      document_name varchar(200) NOT NULL COMMENT '文件名称',
      purpose varchar(500) NOT NULL COMMENT '用印用途',
      copies int unsigned NOT NULL COMMENT '用印份数',
      expected_date date NOT NULL COMMENT '期望用印日期',
      attachment_ids json NULL COMMENT '附件对象 ID 列表',
      state varchar(12) NOT NULL DEFAULT 'draft' COMMENT '状态（draft/in_review/approved/rejected/canceled）',
      instance_id bigint unsigned NULL COMMENT '流程实例 ID（为空则未发起）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_oa_seal_request_instance (tenant_id, instance_id, alive),
      KEY idx_oa_seal_request_user (tenant_id, user_id, created_at),
      KEY idx_oa_seal_request_dept (tenant_id, dept_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用印申请'`)
  }

  /** 按依赖逆序回退，不改动工作流或既有请假记录。 */
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE oa_seal_request')
    await q.query('DROP TABLE oa_expense_item')
    await q.query('DROP TABLE oa_expense_claim')
    await q.query('DROP TABLE oa_trip_request')
  }
}
