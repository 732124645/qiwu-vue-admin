import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Process forms (see docs/design-notes.md#workflow): `wf_form`, the form-create forms dynamic process models bind
 * (`wf_model.form_id`). `schema_json` holds what `sanitizeFormSchema` returned on save (never the raw
 * input). A live name is unique (seeded templates, find their form by it). Soft delete, no
 * foreign keys: a model's reference is registered on the entity (409 `in_use`).
 */
export class WfForm20261001110000 implements MigrationInterface {
  name = 'WfForm20261001110000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE wf_form (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '表单 ID',
      name varchar(128) NOT NULL COMMENT '表单名称（种子为 seed.wf.* 键）',
      schema_json json NOT NULL COMMENT '表单结构（form-create rule + option，保存时已过滤）',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      note varchar(500) NULL COMMENT '备注',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC，软删）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_wf_form_name (name, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='流程表单'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE wf_form')
  }
}
