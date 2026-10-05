import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * BPMN as a second way to draw a process. `wf_model.flow_kind` (`tree|bpmn`,
 * chosen on create, never changes), a BPMN model's draft XML, a version's normalized XML; the version's
 * `tree_json` (compiled from it) stays what the engine runs, so the runtime tables do not change. Down drops
 * the columns: a BPMN version keeps its tree and its instances run on.
 */
export class WfBpmn20261001120000 implements MigrationInterface {
  name = 'WfBpmn20261001120000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE wf_model
      ADD COLUMN flow_kind varchar(8) NOT NULL DEFAULT 'tree' COMMENT '流程类型（tree/bpmn，创建后不可改）' AFTER form_kind,
      ADD COLUMN draft_xml mediumtext NULL COMMENT '设计草稿（BPMN XML，flow_kind=bpmn）' AFTER draft_json`)
    await q.query(`ALTER TABLE wf_version
      ADD COLUMN bpmn_xml mediumtext NULL COMMENT 'BPMN 流程图（规范化 XML，flow_kind=bpmn）' AFTER tree_json`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE wf_version DROP COLUMN bpmn_xml')
    await q.query('ALTER TABLE wf_model DROP COLUMN flow_kind, DROP COLUMN draft_xml')
  }
}
