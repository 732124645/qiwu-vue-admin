import { compile, type WfBeginNode } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { EXPENSE_FIELDS, EXPENSE_MODEL } from '../../../modules/oa/expense/expense-wf.handler.js'
import { findRow, insertRow } from '../upsert.js'
import { insertOfficeVersion, officeSeedTree } from './oa-process.seed.js'

/** 默认报销由发起人选择审批人，缺少人员时不得静默自动通过。 */
export const expenseTree: WfBeginNode = {
  id: 'begin',
  type: 'begin',
  name: 'seed.wf.node.begin',
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

/** 只补本租户缺少的模型及首个发布版本，不更改管理员配置。 */
export async function seedOaExpense(q: EntityManager): Promise<string[]> {
  if (await findRow(q, 'wf_model', { model_key: EXPENSE_MODEL })) return []
  const compiled = compile(await officeSeedTree(q, expenseTree), EXPENSE_FIELDS)
  if (!compiled.ok) throw new Error('seedOaExpense: the expense process does not compile')
  const modelId = await insertRow(q, 'wf_model', {
    model_key: EXPENSE_MODEL,
    name: 'seed.oa.expense',
    description: 'seed.oa.expenseDescription',
    category: 'other',
    icon: 'lucide:receipt-text',
    form_kind: 'custom',
    create_route: '/oa/expense/new',
    view_component: 'oa/expense/view',
    draft_json: compiled.flow.root,
    enabled: 1,
    sort_no: 30,
  })
  await insertOfficeVersion(q, modelId, EXPENSE_MODEL, compiled.flow.root, {
    fields: EXPENSE_FIELDS,
  })
  return []
}
