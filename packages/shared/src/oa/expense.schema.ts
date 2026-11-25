import { z } from 'zod'
import { SUB_ROWS_MAX } from '../common/crud.js'
import { pageQuery } from '../common/pagination.js'
import { fieldDomains } from '../validation/zod-i18n.js'
import { wfStartBody } from '../workflow/wf-center.schema.js'
import {
  oaAmount,
  oaAttachmentIds,
  oaPositiveAmount,
  oaRequestState,
  oaRequestVoFields,
} from './common.schema.js'

export const oaExpensePerms = {
  browse: 'oa.expense.browse',
  view: 'oa.expense.view',
  create: 'oa.expense.create',
  modify: 'oa.expense.modify',
} as const

/** 报销明细由整单保存，服务端校验已有明细 ID 确属本单。 */
export const expenseItemInput = z
  .strictObject({
    id: z.number().int().positive().optional(),
    expenseDate: z.iso.date(),
    expenseKind: z.string().trim().min(1).max(32),
    amount: oaPositiveAmount,
    description: z.string().trim().min(1).max(200),
    attachmentIds: oaAttachmentIds.optional(),
  })
  .register(fieldDomains, { domain: 'oa.expense' })
export type ExpenseItemInput = z.output<typeof expenseItemInput>

const fields = {
  reason: z.string().trim().min(1).max(500),
  tripId: z.number().int().positive().nullish(),
  attachmentIds: oaAttachmentIds.optional(),
  items: z.array(expenseItemInput).min(1).max(SUB_ROWS_MAX),
}

/** 总额和人民币币种由服务端确定，客户端只提交费用明细。 */
export const expenseCreate = z
  .strictObject({ ...fields, initiatorPicks: wfStartBody.shape.initiatorPicks })
  .register(fieldDomains, { domain: 'oa.expense' })
export type ExpenseCreate = z.output<typeof expenseCreate>

/** 未提交的字段不变；提交明细时整单替换，由服务端在事务中计算总额。 */
export const expenseUpdate = z
  .strictObject(fields)
  .partial()
  .register(fieldDomains, { domain: 'oa.expense' })
export type ExpenseUpdate = z.output<typeof expenseUpdate>

export const expenseQuery = pageQuery(['id', 'totalAmount', 'state', 'createdAt'])
  .extend({
    reason: z.string().trim().max(500).optional(),
    tripId: z.number().int().positive().optional(),
    state: oaRequestState.optional(),
  })
  .register(fieldDomains, { domain: 'oa.expense' })
export type ExpenseQuery = z.output<typeof expenseQuery>

export const expenseItemVo = z.object({
  id: z.number().int(),
  claimId: z.number().int(),
  expenseDate: z.iso.date(),
  expenseKind: z.string(),
  amount: oaPositiveAmount,
  description: z.string(),
  attachmentIds: z.array(z.number().int()),
  sortNo: z.number().int(),
})
export type ExpenseItemVo = z.output<typeof expenseItemVo>

export const expenseVo = z.object({
  ...oaRequestVoFields,
  reason: z.string(),
  tripId: z.number().int().nullable(),
  totalAmount: oaAmount,
  currency: z.literal('CNY'),
})
export type ExpenseVo = z.output<typeof expenseVo>

export const expenseDetailVo = expenseVo.extend({ items: z.array(expenseItemVo) })
export type ExpenseDetail = z.output<typeof expenseDetailVo>
