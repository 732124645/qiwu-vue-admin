// Built-in process templates: general approval, leave (days from qw-date-range-days),
// expense claim (qw-detail-table total) and overtime, each a dynamic model with its form. A template is a
// model whose key starts with WF_TEMPLATE_KEY_PREFIX, seeded disabled and unpublished: the new-approval wizard
// copies one (an administrator may also publish one as it is). Model, node and path names are seed.wf.* keys
// (shared seed.json); the form texts are form-create `{{$t.<id>}}` texts in the schema's `option.language`
// (by form-create locale, the designer edits them). Reviewers come from the org chart (initiator's dept heads),
// nobody there → the model's managers. Forms, routing and texts made up for this project.
import {
  compile,
  fieldsFromFormSchema,
  sanitizeFormSchema,
  WF_TEMPLATE_KEY_PREFIX,
  type WfBeginNode,
  type WfReviewNode,
  type WfStep,
} from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { findRow, insertRow } from '../upsert.js'

/** language id → [zh-CN, en-US] */
type Texts = Record<string, [zh: string, en: string]>
type Rule = Record<string, unknown>

const t = (id: string) => `{{$t.${id}}}`
/** a form's `option`: its texts by form-create locale (the web's `formLocale`) */
const option = (texts: Texts) => ({
  language: {
    'zh-cn': Object.fromEntries(Object.entries(texts).map(([id, [zh]]) => [id, zh])),
    en: Object.fromEntries(Object.entries(texts).map(([id, [, en]]) => [id, en])),
  },
})
/** a rule binding `field`, titled by the text of the same id */
const input = (type: string, field: string, extra: Rule = {}): Rule => ({
  type,
  field,
  title: t(field),
  ...extra,
})
const required = { $required: true }
// as the designer writes them
const textarea = (field: string, extra: Rule = {}) =>
  input('input', field, { _fc_drag_tag: 'textarea', props: { type: 'textarea' }, ...extra })
const day = (field: string) =>
  input('datePicker', field, { ...required, props: { type: 'date', valueFormat: 'YYYY-MM-DD' } })
const dateTime = (field: string) =>
  input('datePicker', field, {
    ...required,
    props: { type: 'datetime', valueFormat: 'YYYY-MM-DD[T]HH:mm:ssZ' },
  })

const review = (id: string, name: string, assignee: WfReviewNode['assignee']): WfReviewNode => ({
  id,
  type: 'review',
  name,
  assignee,
  sign: 'any',
  whenNobody: 'toManager',
  whenInitiatorIsReviewer: 'deptHead',
  onReject: 'finish',
})
const supervisor = () =>
  review('supervisor', 'seed.wf.node.supervisor', { kind: 'initiatorDeptHead' })
const begin = (next: WfStep): WfBeginNode => ({
  id: 'begin',
  type: 'begin',
  name: 'seed.wf.node.begin',
  next,
})
/** `field` over `limit`: two levels of the initiator's dept heads in turn; otherwise the direct one */
const overLimit = (fork: [id: string, name: string], path: string, field: string, limit: number) =>
  begin({
    id: fork[0],
    type: 'fork',
    name: fork[1],
    mode: 'exclusive',
    paths: [
      {
        id: 'over',
        name: path,
        when: [[{ field, op: 'gt', value: limit }]],
        child: {
          ...review('two-levels', 'seed.wf.node.twoLevels', { kind: 'deptHeadChain', levels: 2 }),
          sign: 'ordered',
        },
      },
      {
        id: 'otherwise',
        name: 'seed.wf.path.otherwise',
        fallback: true,
        when: [],
        child: supervisor(),
      },
    ],
  })

export interface WfTemplateSeed {
  /** after WF_TEMPLATE_KEY_PREFIX */
  key: string
  name: string
  description: string
  category: string
  icon: string
  /** `wf_form.name` */
  form: string
  schema: { rule: Rule[]; option: ReturnType<typeof option> }
  tree: WfBeginNode
}

export const WF_TEMPLATES: WfTemplateSeed[] = [
  {
    key: 'general',
    name: 'seed.wf.tpl.general',
    description: 'seed.wf.tpl.generalDescription',
    category: 'other',
    icon: 'lucide:clipboard-check',
    form: 'seed.wf.form.general',
    schema: {
      rule: [
        input('input', 'subject', required),
        textarea('details'),
        input('qw-upload', 'attachments'),
      ],
      option: option({
        subject: ['事由', 'Subject'],
        details: ['详细说明', 'Details'],
        attachments: ['附件', 'Attachments'],
      }),
    },
    tree: begin(supervisor()),
  },
  {
    key: 'leave',
    name: 'seed.wf.tpl.leave',
    description: 'seed.wf.tpl.leaveDescription',
    category: 'hr',
    icon: 'lucide:calendar-days',
    form: 'seed.wf.form.leave',
    schema: {
      rule: [
        input('qw-dict-select', 'leaveKind', { ...required, props: { code: 'biz.leave_kind' } }),
        day('startDate'),
        day('endDate'),
        input('qw-date-range-days', 'days', {
          props: { startField: 'startDate', endField: 'endDate' },
        }),
        textarea('reason', required),
      ],
      option: option({
        leaveKind: ['请假类型', 'Leave type'],
        startDate: ['开始日期', 'Start date'],
        endDate: ['结束日期', 'End date'],
        days: ['请假天数', 'Days'],
        reason: ['请假事由', 'Reason'],
      }),
    },
    tree: overLimit(['by-days', 'seed.wf.node.byDays'], 'seed.wf.path.over3Days', 'days', 3),
  },
  {
    key: 'expense',
    name: 'seed.wf.tpl.expense',
    description: 'seed.wf.tpl.expenseDescription',
    category: 'finance',
    icon: 'lucide:receipt',
    form: 'seed.wf.form.expense',
    schema: {
      rule: [
        input('input', 'subject', required),
        input('qw-detail-table', 'items', {
          ...required,
          props: {
            columns: [
              { prop: 'kind', label: t('itemKind') },
              { prop: 'note', label: t('itemNote') },
              { prop: 'amount', label: t('amount'), sum: 'total' },
            ],
          },
        }),
        input('qw-upload', 'attachments'),
      ],
      option: option({
        subject: ['报销事由', 'Purpose'],
        items: ['费用明细', 'Items'],
        itemKind: ['费用类型', 'Type'],
        itemNote: ['说明', 'Note'],
        amount: ['金额', 'Amount'],
        attachments: ['票据', 'Receipts'],
      }),
    },
    tree: overLimit(['by-amount', 'seed.wf.node.byAmount'], 'seed.wf.path.over5000', 'total', 5000),
  },
  {
    key: 'overtime',
    name: 'seed.wf.tpl.overtime',
    description: 'seed.wf.tpl.overtimeDescription',
    category: 'hr',
    icon: 'lucide:calendar-clock',
    form: 'seed.wf.form.overtime',
    schema: {
      rule: [
        dateTime('startTime'),
        dateTime('endTime'),
        input('inputNumber', 'hours', { ...required, props: { min: 0, step: 0.5, precision: 1 } }),
        textarea('reason', required),
      ],
      option: option({
        startTime: ['开始时间', 'Start time'],
        endTime: ['结束时间', 'End time'],
        hours: ['加班时长（小时）', 'Hours'],
        reason: ['加班事由', 'Reason'],
      }),
    },
    tree: begin(supervisor()),
  },
]

/**
 * Each template once: only while neither its model key nor its form name exists, live or deleted
 * (afterwards the administrator owns both). The form is stored as `sanitizeFormSchema` returns it, the draft
 * as `compile` checked it against the form's fields; a template that fails either is a seed error.
 */
export async function seedProcessTemplates(q: EntityManager): Promise<string[]> {
  for (const [i, tpl] of WF_TEMPLATES.entries()) {
    const key = WF_TEMPLATE_KEY_PREFIX + tpl.key
    if (
      (await findRow(q, 'wf_model', { model_key: key })) ||
      (await findRow(q, 'wf_form', { name: tpl.form }))
    )
      continue
    const s = sanitizeFormSchema(tpl.schema)
    const f = s.ok ? fieldsFromFormSchema(s.schema) : undefined
    const c = f?.ok ? compile(tpl.tree, f.fields) : undefined
    if (!s.ok || !f?.ok || !c?.ok)
      throw new Error(
        `seedProcessTemplates: template ${key} is invalid: ${JSON.stringify(c ?? f ?? s)}`,
      )
    const formId = await insertRow(q, 'wf_form', { name: tpl.form, schema_json: s.schema })
    await insertRow(q, 'wf_model', {
      model_key: key,
      name: tpl.name,
      category: tpl.category,
      icon: tpl.icon,
      description: tpl.description,
      form_kind: 'dynamic',
      form_id: formId,
      draft_json: c.flow.root,
      enabled: 0,
      sort_no: 900 + i * 10,
    })
  }
  return []
}
