import { z } from 'zod'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { wxoaCheckReplyBody } from './reply-rule.schema.js'
import {
  WXOA_CHANNELS,
  WXOA_DIRECTIONS,
  WXOA_REPLY_KINDS,
  WXOA_SEND_STATES,
  wxoaId,
  wxoaNeed,
  wxoaQueryId,
  type WxoaReplyKind,
} from './wxoa.schema.js'

/**
 * Message log (`wxoa_message`), `/api/wxoa/messages`, and conversations, `/api/wxoa/conversations`:
 * inbound pushes, passive replies, customer-service and template messages. Rows are a log, purged after
 * `wxoa.message.retention_days`. Payloads are WeChat's whitelisted fields (plain text: never render them
 * as HTML).
 */

export const wxoaMessageQuery = pageQuery(['occurredAt', 'id'])
  .extend({
    accountId: wxoaQueryId,
    openId: z.string().trim().max(64).optional(),
    direction: z.enum(WXOA_DIRECTIONS).optional(),
    channel: z.enum(WXOA_CHANNELS).optional(),
    msgKind: z.string().trim().max(24).optional(),
    occurredAtFrom: z.iso.datetime({ offset: true }).optional(),
    occurredAtTo: z.iso.datetime({ offset: true }).optional(),
  })
  .register(fieldDomains, { domain: 'wxoa.message' })
export type WxoaMessageQuery = z.output<typeof wxoaMessageQuery>

export const wxoaMessageVo = z.object({
  id: z.number().int(),
  accountId: z.number().int(),
  openId: z.string(),
  direction: z.enum(WXOA_DIRECTIONS),
  channel: z.string(),
  msgKind: z.string(),
  eventKind: z.string().nullable(),
  eventKey: z.string().nullable(),
  /** whitelisted fields; `truncated: true` when the longest texts were cut to fit 16 KiB */
  payload: z.record(z.string(), z.unknown()),
  /** the local copy of inbound media */
  objectId: z.number().int().nullable(),
  /** WeChat's 64-bit message id, as a string */
  wxMsgId: z.string().nullable(),
  sendState: z.enum(WXOA_SEND_STATES).nullable(),
  errcode: z.number().int().nullable(),
  operatorId: z.number().int().nullable(),
  occurredAt: z.iso.datetime(),
})
export type WxoaMessageVo = z.infer<typeof wxoaMessageVo>

/** GET /conversations: the account's fans by their last message, newest first (items are fans). */
export const wxoaConversationQuery = pageQuery(['lastInboundAt', 'id'])
  .extend({ accountId: wxoaQueryId })
  .register(fieldDomains, { domain: 'wxoa.message' })
export type WxoaConversationQuery = z.output<typeof wxoaConversationQuery>

/** GET /conversations/:fanId/messages: newest first, before `beforeId` (exclusive). */
export const wxoaFanMessagesQuery = z
  .object({
    beforeId: wxoaQueryId.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .register(fieldDomains, { domain: 'wxoa.message' })
export type WxoaFanMessagesQuery = z.output<typeof wxoaFanMessagesQuery>

/**
 * Customer-service windows: 48 hours and 5 messages after a fan's message; 1 minute and 3 messages
 * after a menu click, a QR scan or a subscribe. The server checks the times only; WeChat counts.
 */
export const WXOA_SEND_WINDOWS = {
  inbound: { ms: 48 * 3_600_000, max: 5 },
  event: { ms: 60_000, max: 3 },
} as const

const windowVo = z.object({
  /** null: never opened */
  until: z.iso.datetime().nullable(),
  used: z.number().int(),
  max: z.number().int(),
})
/** GET /conversations/:fanId/window */
export const wxoaSendWindowVo = z.object({ inbound: windowVo, event: windowVo })
export type WxoaSendWindowVo = z.infer<typeof wxoaSendWindowVo>

/** Kinds sent from a media file: `materialId` (a material of the account) or `objectId`. */
const MEDIA_KINDS: readonly WxoaReplyKind[] = ['image', 'voice', 'video']
/** Kinds needing a thumbnail material. */
const THUMB_KINDS: readonly WxoaReplyKind[] = ['video', 'music']

/**
 * POST /messages: a customer-service message to a fan of the account. Media come from exactly one of
 * `materialId` (a material of the account) and `objectId` (a `wxoa.media` object of the account, e.g. an
 * inbound copy); any other object → 404. Video and music also need `thumbMaterialId`.
 */
export const wxoaMessageSend = z
  .object({
    accountId: wxoaId,
    fanId: wxoaId,
    kind: z.enum(WXOA_REPLY_KINDS),
    /** by `kind`: `wxoaReplyBodies` */
    body: z.record(z.string(), z.unknown()),
    materialId: wxoaId.nullish(),
    objectId: wxoaId.nullish(),
    thumbMaterialId: wxoaId.nullish(),
  })
  .superRefine((m, ctx) => {
    const media = MEDIA_KINDS.includes(m.kind)
    if (media && m.materialId != null && m.objectId != null)
      ctx.addIssue({ code: 'custom', path: ['objectId'], message: 'validation.invalid' })
    else if (media) wxoaNeed(m.materialId ?? m.objectId, true, 'materialId', ctx)
    else {
      wxoaNeed(m.materialId, false, 'materialId', ctx)
      wxoaNeed(m.objectId, false, 'objectId', ctx)
    }
    wxoaNeed(m.thumbMaterialId, THUMB_KINDS.includes(m.kind), 'thumbMaterialId', ctx)
    wxoaCheckReplyBody(m.kind, m.body, 'body', ctx)
  })
  .register(fieldDomains, { domain: 'wxoa.message' })
export type WxoaMessageSend = z.infer<typeof wxoaMessageSend>
