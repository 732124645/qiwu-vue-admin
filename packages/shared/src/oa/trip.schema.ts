import { z } from 'zod'
import { pageQuery } from '../common/pagination.js'
import { fieldDomains } from '../validation/zod-i18n.js'
import { wfStartBody } from '../workflow/wf-center.schema.js'
import { oaAmount, oaAttachmentIds, oaRequestState, oaRequestVoFields } from './common.schema.js'

export const oaTripPerms = {
  browse: 'oa.trip.browse',
  view: 'oa.trip.view',
  create: 'oa.trip.create',
  modify: 'oa.trip.modify',
} as const

const fields = {
  destination: z.string().trim().min(1).max(200),
  startAt: z.iso.datetime({ offset: true }),
  endAt: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(1).max(500),
  estimatedAmount: oaAmount.nullish(),
  attachmentIds: oaAttachmentIds.optional(),
}

/** 出差提交包含选定审批人；所属人、状态与实例由业务服务写入。 */
export const tripCreate = z
  .strictObject({ ...fields, initiatorPicks: wfStartBody.shape.initiatorPicks })
  .refine((row) => Date.parse(row.endAt) > Date.parse(row.startAt), {
    path: ['endAt'],
    error: 'validation.invalid',
  })
  .register(fieldDomains, { domain: 'oa.trip' })
export type TripCreate = z.output<typeof tripCreate>

/** 只允许业务字段更新；只提交一个时间端点时由服务端结合已存值验证。 */
export const tripUpdate = z
  .strictObject(fields)
  .partial()
  .refine((row) => !row.startAt || !row.endAt || Date.parse(row.endAt) > Date.parse(row.startAt), {
    path: ['endAt'],
    error: 'validation.invalid',
  })
  .register(fieldDomains, { domain: 'oa.trip' })
export type TripUpdate = z.output<typeof tripUpdate>

export const tripQuery = pageQuery(['id', 'startAt', 'endAt', 'state', 'createdAt'])
  .extend({
    destination: z.string().trim().max(200).optional(),
    state: oaRequestState.optional(),
    startAtFrom: z.iso.datetime({ offset: true }).optional(),
    startAtTo: z.iso.datetime({ offset: true }).optional(),
  })
  .register(fieldDomains, { domain: 'oa.trip' })
export type TripQuery = z.output<typeof tripQuery>

export const tripVo = z.object({
  ...oaRequestVoFields,
  destination: z.string(),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
  reason: z.string(),
  estimatedAmount: oaAmount.nullable(),
})
export type TripVo = z.output<typeof tripVo>
