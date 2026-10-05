import type {
  WfBeginNode,
  WfFlowKind,
  WfFormKind,
  WfFormSnapshot,
  WfInitiatorScope,
} from '@qiwu/shared'
import { Column, CreateDateColumn, Entity } from 'typeorm'
import { BaseEntity, IdEntity } from '../../../core/db/base.entity.js'
import { referencedBy } from '../../../core/db/references.js'

// a published model is in use (its versions are what instances run and show): disable it instead. This also
// keeps a reused model_key from numbering versions again from 1 (unique(model_key, version, alive))
referencedBy('wf_model', { table: 'wf_version', column: 'model_id' })

/** `wf_model`: 流程模型 */
@Entity('wf_model')
export class WfModel extends BaseEntity {
  /** 模型标识（业务处理器按它注册） */
  @Column({ name: 'model_key', length: 64 })
  modelKey: string

  /** 模型名称（种子为 seed.wf.* 键） */
  @Column({ length: 128 })
  name: string

  /** 分类（字典 wf.category） */
  @Column({ length: 24, default: 'other' })
  category: string

  @Column({ type: 'varchar', length: 64, nullable: true })
  icon: string | null

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null

  @Column({ name: 'form_kind', type: 'varchar', length: 8 })
  formKind: WfFormKind

  /** 流程类型（tree 树形 / bpmn BPMN，创建后不可改） */
  @Column({ name: 'flow_kind', type: 'varchar', length: 8, default: 'tree' })
  flowKind: WfFlowKind

  /** 动态表单（form_kind=dynamic；发布时快照它，wf-form.entity.ts 登记了引用） */
  @Column({ name: 'form_id', type: 'bigint', unsigned: true, nullable: true })
  formId: number | null

  @Column({ name: 'create_route', type: 'varchar', length: 255, nullable: true })
  createRoute: string | null

  @Column({ name: 'view_component', type: 'varchar', length: 255, nullable: true })
  viewComponent: string | null

  /** 设计草稿（流程树 JSON，发布时才校验） */
  @Column({ name: 'draft_json', type: 'json', nullable: true })
  draftJson: object | null

  /** BPMN 设计草稿（XML；flow_kind=bpmn，发布后为规范化 XML） */
  @Column({ name: 'draft_xml', type: 'mediumtext', nullable: true })
  draftXml: string | null

  /** null = everyone */
  @Column({ name: 'initiator_scope', type: 'json', nullable: true })
  initiatorScope: WfInitiatorScope | null

  @Column({ name: 'manager_user_ids', type: 'json', nullable: true })
  managerUserIds: number[] | null

  @Column({ name: 'allow_cancel', type: 'boolean', default: true })
  allowCancel: boolean

  @Column({ name: 'allow_withdraw', type: 'boolean', default: true })
  allowWithdraw: boolean

  @Column({ type: 'boolean', default: true })
  enabled: boolean

  @Column({ name: 'sort_no', type: 'int', default: 0 })
  sortNo: number

  /** null = never published */
  @Column({ name: 'current_version_id', type: 'bigint', unsigned: true, nullable: true })
  currentVersionId: number | null
}

/** `wf_version`: a published snapshot, insert-only */
@Entity('wf_version')
export class WfVersion extends IdEntity {
  @Column({ name: 'model_id', type: 'bigint', unsigned: true })
  modelId: number

  @Column({ name: 'model_key', length: 64 })
  modelKey: string

  /** 1, 2, … per model */
  @Column({ type: 'int', unsigned: true })
  version: number

  /** the compiled (zod-parsed) tree */
  @Column({ name: 'tree_json', type: 'json' })
  treeJson: WfBeginNode

  /** a BPMN model's normalized XML `treeJson` was compiled from; null = a tree model's */
  @Column({ name: 'bpmn_xml', type: 'mediumtext', nullable: true })
  bpmnXml: string | null

  @Column({ name: 'form_snapshot', type: 'json' })
  formSnapshot: WfFormSnapshot

  /** null = seeded */
  @Column({ name: 'published_by', type: 'bigint', unsigned: true, nullable: true })
  publishedBy: number | null

  @CreateDateColumn({ name: 'published_at', type: 'datetime', precision: 3 })
  publishedAt: Date
}
