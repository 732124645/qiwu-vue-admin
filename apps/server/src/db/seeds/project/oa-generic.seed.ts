import { compile, fieldsFromFormSchema, sanitizeFormSchema, type WfBeginNode } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { findRow, insertRow } from '../upsert.js'
import { insertOfficeVersion, officeSeedTree } from './oa-process.seed.js'

export const GENERIC_MODEL = 'oa-generic'
const sanitized = sanitizeFormSchema({
  rule: [
    {
      type: 'input',
      field: 'title',
      title: '{{$t.title}}',
      $required: true,
      props: { maxlength: 200 },
    },
    {
      type: 'input',
      field: 'description',
      title: '{{$t.description}}',
      $required: true,
      _fc_drag_tag: 'textarea',
      props: { type: 'textarea', maxlength: 1000 },
    },
    {
      type: 'datePicker',
      field: 'expectedDate',
      title: '{{$t.expectedDate}}',
      $required: true,
      props: { type: 'date', valueFormat: 'YYYY-MM-DD' },
    },
    { type: 'qw-upload', field: 'attachments', title: '{{$t.attachments}}' },
  ],
  option: {
    language: {
      'zh-cn': {
        title: '事项名称',
        description: '事项说明',
        expectedDate: '期望日期',
        attachments: '附件',
      },
      en: {
        title: 'Subject',
        description: 'Description',
        expectedDate: 'Expected date',
        attachments: 'Attachments',
      },
    },
  },
})
if (!sanitized.ok) throw new Error('seedOaGeneric: the form schema is invalid')
export const genericSchema = sanitized.schema

export const genericTree: WfBeginNode = {
  id: 'begin',
  type: 'begin',
  name: 'seed.wf.node.begin',
  access: { title: 'edit', description: 'edit', expectedDate: 'edit', attachments: 'edit' },
  next: {
    id: 'review',
    type: 'review',
    name: 'seed.oa.reviewer',
    assignee: { kind: 'initiatorPicks' },
    sign: 'any',
    whenNobody: 'toManager',
    whenInitiatorIsReviewer: 'self',
    onReject: 'finish',
  },
}

/** 通用审批只补缺少的动态表单和初始发布模型，不改写运行中快照。 */
export async function seedOaGeneric(q: EntityManager): Promise<string[]> {
  if (await findRow(q, 'wf_model', { model_key: GENERIC_MODEL })) return []
  const fields = fieldsFromFormSchema(genericSchema)
  if (!fields.ok) throw new Error('seedOaGeneric: the form fields are invalid')
  const compiled = compile(await officeSeedTree(q, genericTree), fields.fields)
  if (!compiled.ok) throw new Error('seedOaGeneric: the general process does not compile')
  const existing = await findRow(q, 'wf_form', { name: 'seed.oa.genericForm' })
  // 已有同名表单属于管理员，不自动接管、覆盖或复活。
  if (existing) return []
  const formId = await insertRow(q, 'wf_form', {
    name: 'seed.oa.genericForm',
    schema_json: genericSchema,
    enabled: 1,
  })
  const modelId = await insertRow(q, 'wf_model', {
    model_key: GENERIC_MODEL,
    name: 'seed.oa.generic',
    description: 'seed.oa.genericDescription',
    category: 'other',
    icon: 'lucide:clipboard-check',
    form_kind: 'dynamic',
    form_id: formId,
    draft_json: compiled.flow.root,
    enabled: 1,
    sort_no: 50,
  })
  await insertOfficeVersion(q, modelId, GENERIC_MODEL, compiled.flow.root, {
    fields: fields.fields,
    schema: genericSchema,
  })
  return []
}
