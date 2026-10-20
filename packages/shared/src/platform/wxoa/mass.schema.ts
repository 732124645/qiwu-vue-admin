import { z } from 'zod'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { wxoaAccountRef, wxoaId, wxoaQueryId } from './wxoa.schema.js'

export const WXOA_MASS_OPENIDS_MAX = 10_000
export const WXOA_MASS_KINDS = ['text', 'image', 'voice', 'video', 'mpnews'] as const
export const WXOA_MASS_TARGETS = ['all', 'tag', 'openids'] as const
/**
 * 结果未知的群发任务可重发的时限（自创建起 23 小时）：微信按 clientmsgid 防重只有 24 小时，
 * 留一小时余量；过了时限服务端回 409，页面不再提供重发。
 */
export const WXOA_MASS_RETRY_MS = 23 * 3_600_000
/**
 * 群发内容，字段名与微信一致：text 为 `{ content }`，image / voice / video 为 `{ media_id }`（video 可带
 * title、description），mpnews 的 media_id 由服务端按 draftId 填入。
 */
export const wxoaMassPayload = z.record(z.string(), z.unknown())
export const wxoaMassCreate = z
  .object({
    accountId: wxoaQueryId,
    targetKind: z.enum(WXOA_MASS_TARGETS),
    tagId: z.number().int().positive().optional(),
    openIds: z.array(z.string().trim().min(1).max(64)).min(2).max(WXOA_MASS_OPENIDS_MAX).optional(),
    msgKind: z.enum(WXOA_MASS_KINDS),
    payload: wxoaMassPayload,
    draftId: wxoaId.optional(),
    sendIgnoreReprint: z.boolean().optional().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.targetKind === 'tag' && v.tagId === undefined)
      ctx.addIssue({ code: 'custom', path: ['tagId'], message: 'validation.required' })
    if (v.targetKind !== 'tag' && v.tagId !== undefined)
      ctx.addIssue({ code: 'custom', path: ['tagId'], message: 'validation.invalid' })
    if (v.targetKind === 'openids' && v.openIds === undefined)
      ctx.addIssue({ code: 'custom', path: ['openIds'], message: 'validation.required' })
    if (v.targetKind !== 'openids' && v.openIds !== undefined)
      ctx.addIssue({ code: 'custom', path: ['openIds'], message: 'validation.invalid' })
    if (v.msgKind === 'mpnews' && v.draftId === undefined)
      ctx.addIssue({ code: 'custom', path: ['draftId'], message: 'validation.required' })
    const need = v.msgKind === 'text' ? 'content' : v.msgKind === 'mpnews' ? null : 'media_id'
    const value = need ? v.payload[need] : undefined
    if (need && !(typeof value === 'string' && value.trim()))
      ctx.addIssue({ code: 'custom', path: ['payload', need], message: 'validation.required' })
  })
  .register(fieldDomains, { domain: 'wxoa.mass' })
export type WxoaMassCreate = z.output<typeof wxoaMassCreate>

export const wxoaMassPreview = wxoaMassCreate.extend({ toOpenId: z.string().trim().min(1).max(64) })
export type WxoaMassPreview = z.output<typeof wxoaMassPreview>
export const wxoaMassQuery = pageQuery(['createdAt', 'finishedAt', 'id'])
  .extend({ accountId: wxoaQueryId })
  .register(fieldDomains, { domain: 'wxoa.mass' })
export type WxoaMassQuery = z.output<typeof wxoaMassQuery>
/** 删除群发：`index` 是要删除的篇序号（从 1 开始），不填删除全部。 */
export const wxoaMassDelete = z.object({ index: z.coerce.number().int().min(1).max(8).optional() })
export type WxoaMassDelete = z.output<typeof wxoaMassDelete>
export const wxoaMassVo = z.object({
  id: wxoaId,
  accountId: wxoaId,
  targetKind: z.enum(WXOA_MASS_TARGETS),
  tagId: z.number().int().nullable(),
  openIds: z.array(z.string()).nullable(),
  msgKind: z.enum(WXOA_MASS_KINDS),
  payload: wxoaMassPayload,
  clientMsgId: z.string(),
  wxMsgId: z.string().nullable(),
  msgDataId: z.string().nullable(),
  jobState: z.enum(['submitted', 'succeeded', 'failed', 'removed']),
  result: z.record(z.string(), z.unknown()).nullable(),
  finishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** 详情接口才有：mass/get 返回的发送状态（SEND_SUCCESS / SENDING / SEND_FAIL / DELETE） */
  upstream: z.object({ msgId: z.string(), msgStatus: z.string() }).nullable().optional(),
})
export type WxoaMassVo = z.infer<typeof wxoaMassVo>
export const wxoaMassAccountRef = wxoaAccountRef
