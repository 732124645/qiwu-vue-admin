import { z } from 'zod'
import { pageQuery } from '../common/pagination.js'
import { fieldDomains } from '../validation/zod-i18n.js'
import { wfStartBody } from '../workflow/wf-center.schema.js'
import { oaAttachmentIds, oaRequestState, oaRequestVoFields } from './common.schema.js'

export const oaSealPerms = {
  browse: 'oa.seal.browse',
  view: 'oa.seal.view',
  create: 'oa.seal.create',
  modify: 'oa.seal.modify',
} as const

const fields = {
  sealKind: z.string().trim().min(1).max(32),
  documentName: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(1).max(500),
  copies: z.number().int().positive().max(9999),
  expectedDate: z.iso.date(),
  attachmentIds: oaAttachmentIds.optional(),
}

/** 用印申请只提交业务内容；批准不代表印章已实际使用。 */
export const sealCreate = z
  .strictObject({ ...fields, initiatorPicks: wfStartBody.shape.initiatorPicks })
  .register(fieldDomains, { domain: 'oa.seal' })
export type SealCreate = z.output<typeof sealCreate>

export const sealUpdate = z
  .strictObject(fields)
  .partial()
  .register(fieldDomains, { domain: 'oa.seal' })
export type SealUpdate = z.output<typeof sealUpdate>

export const sealQuery = pageQuery(['id', 'expectedDate', 'state', 'createdAt'])
  .extend({
    documentName: z.string().trim().max(200).optional(),
    sealKind: z.string().trim().max(32).optional(),
    state: oaRequestState.optional(),
  })
  .register(fieldDomains, { domain: 'oa.seal' })
export type SealQuery = z.output<typeof sealQuery>

export const sealVo = z.object({
  ...oaRequestVoFields,
  sealKind: z.string(),
  documentName: z.string(),
  purpose: z.string(),
  copies: z.number().int(),
  expectedDate: z.iso.date(),
})
export type SealVo = z.output<typeof sealVo>
