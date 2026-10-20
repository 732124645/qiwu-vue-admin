import { z } from 'zod'
import { pageQuery, PAGE_SIZE_MAX } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { wxoaId, wxoaQueryId, wxoaTagId } from './wxoa.schema.js'

/**
 * Fans (`wxoa_fan`), `/api/wxoa/fans`, and tags (`wxoa_tag`), `/api/wxoa/tags`. Fan rows come from pushes
 * and syncs; an unsubscribe only clears `subscribed`. Tag ids are WeChat's (per account), and every fan or
 * tag a request names must belong to its account (else 404).
 */

export const wxoaFanQuery = pageQuery(['subscribedAt', 'lastInboundAt', 'id'])
  .extend({
    accountId: wxoaQueryId,
    subscribed: z.stringbool().optional(),
    blocked: z.stringbool().optional(),
    tagId: z.coerce.number().int().min(0).max(4_294_967_295).optional(),
    openId: z.string().trim().max(64).optional(),
    remark: z.string().trim().max(30).optional(),
  })
  .register(fieldDomains, { domain: 'wxoa.fan' })
export type WxoaFanQuery = z.output<typeof wxoaFanQuery>

export const wxoaFanVo = z.object({
  id: z.number().int(),
  accountId: z.number().int(),
  openId: z.string(),
  unionId: z.string().nullable(),
  subscribed: z.boolean(),
  subscribedAt: z.iso.datetime().nullable(),
  unsubscribedAt: z.iso.datetime().nullable(),
  subscribeScene: z.string().nullable(),
  qrScene: z.string().nullable(),
  remark: z.string().nullable(),
  lang: z.string().nullable(),
  tagIds: z.array(z.number().int()),
  blocked: z.boolean(),
  lastInboundAt: z.iso.datetime().nullable(),
  lastEventAt: z.iso.datetime().nullable(),
  syncedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})
export type WxoaFanVo = z.infer<typeof wxoaFanVo>

/** PUT /fans/:id/remark: '' clears it. */
export const wxoaFanRemarkBody = z
  .strictObject({ remark: z.string().trim().max(30) })
  .register(fieldDomains, { domain: 'wxoa.fan' })
export type WxoaFanRemarkBody = z.infer<typeof wxoaFanRemarkBody>

const fanIds = z.array(wxoaId).min(1).max(PAGE_SIZE_MAX)

export const WXOA_TAG_OPS = ['add', 'remove'] as const
/** POST /fans/tagging (sent to WeChat in its own batch sizes). */
export const wxoaFanTaggingBody = z
  .object({ accountId: wxoaId, fanIds, tagId: wxoaTagId, op: z.enum(WXOA_TAG_OPS) })
  .register(fieldDomains, { domain: 'wxoa.fan' })
export type WxoaFanTaggingBody = z.infer<typeof wxoaFanTaggingBody>

/** POST /fans/blocking */
export const wxoaFanBlockingBody = z
  .object({ accountId: wxoaId, fanIds, blocked: z.boolean() })
  .register(fieldDomains, { domain: 'wxoa.fan' })
export type WxoaFanBlockingBody = z.infer<typeof wxoaFanBlockingBody>

/** Tags an account may have on WeChat. */
export const WXOA_TAGS_MAX = 100

const tagName = z.string().trim().min(1).max(30)
/** POST /tags */
export const wxoaTagCreate = z
  .object({ accountId: wxoaId, name: tagName })
  .register(fieldDomains, { domain: 'wxoa.tag' })
export type WxoaTagCreate = z.infer<typeof wxoaTagCreate>
/** PUT /tags/:id: the name only. */
export const wxoaTagUpdate = z
  .strictObject({ name: tagName })
  .register(fieldDomains, { domain: 'wxoa.tag' })
export type WxoaTagUpdate = z.infer<typeof wxoaTagUpdate>

/** GET /tags?accountId= (all of the account's tags). */
export const wxoaTagVo = z.object({
  id: z.number().int(),
  accountId: z.number().int(),
  tagId: z.number().int(),
  name: z.string(),
  fanCount: z.number().int(),
})
export type WxoaTagVo = z.infer<typeof wxoaTagVo>
