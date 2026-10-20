import { z } from 'zod'
import { pageQuery } from '../../common/pagination.js'
import { utf8Bytes } from '../../common/password-policy.js'
import { fieldDomains, validationMessage } from '../../validation/zod-i18n.js'
import {
  WXOA_MATCH_MODES,
  WXOA_REPLY_KINDS,
  WXOA_REPLY_TRIGGERS,
  WXOA_SCENE,
  wxoaHttpUrl,
  wxoaId,
  wxoaNeed,
  wxoaQueryId,
  wxoaXmlSafe,
  type WxoaReplyKind,
} from './wxoa.schema.js'

/**
 * Auto-reply rules (`wxoa_reply_rule`), `/api/wxoa/reply-rules`, matched while a push is answered: the
 * subscribe rule (a `qrscene_` subscribe tries the scan rule of its scene first), scan rules by scene,
 * click rules by menu key, keyword rules (priority, then exact before contains, then id), and the default
 * rule for user messages nothing else matched. At most one enabled subscribe and one enabled default rule
 * per account (409), 500 rules per account.
 */

export const WXOA_RULES_MAX = 500
export const WXOA_KEYWORDS_MAX = 20
/** Text of a reply or a customer-service message, in UTF-8 bytes. */
export const WXOA_TEXT_MAX_BYTES = 2048

/** Text for an XML reply: no character XML forbids (`validation.wxoa.xml_char`). */
const xmlText = (max: number) =>
  z.string().min(1).max(max).refine(wxoaXmlSafe, { error: 'validation.wxoa.xml_char' })

/**
 * The content of each reply kind (`reply_body`, also a customer-service message's `body`). The media of
 * image, voice and video and the thumbnail of music are referenced beside it, never in it.
 */
export const wxoaReplyBodies = {
  text: z.strictObject({
    content: z
      .string()
      .refine((s) => s.trim() !== '', { error: 'validation.required' })
      .refine((s) => utf8Bytes(s) <= WXOA_TEXT_MAX_BYTES, {
        error: 'validation.wxoa.bytes',
        params: { maxBytes: WXOA_TEXT_MAX_BYTES },
      })
      .refine(wxoaXmlSafe, { error: 'validation.wxoa.xml_char' }),
  }),
  image: z.strictObject({}),
  voice: z.strictObject({}),
  video: z.strictObject({
    title: xmlText(64).optional(),
    description: xmlText(256).optional(),
  }),
  music: z.strictObject({
    title: xmlText(64),
    description: xmlText(256),
    musicUrl: wxoaHttpUrl(),
    hqMusicUrl: wxoaHttpUrl().optional(),
  }),
  /** one article linking out */
  news: z.strictObject({
    title: xmlText(64),
    description: xmlText(256),
    url: wxoaHttpUrl(),
    picUrl: wxoaHttpUrl(),
  }),
} as const satisfies Record<WxoaReplyKind, z.ZodType>

/** Checks `body` against its kind's schema, the issues placed under `prop`. */
export function wxoaCheckReplyBody(
  kind: WxoaReplyKind | undefined,
  body: unknown,
  prop: string,
  ctx: z.RefinementCtx,
) {
  if (!kind || !(kind in wxoaReplyBodies)) return
  for (const issue of wxoaReplyBodies[kind].safeParse(body).error?.issues ?? []) {
    const { key, params } = validationMessage(issue)
    ctx.addIssue({ code: 'custom', path: [prop, ...issue.path], message: key, params })
  }
}

/** Reply kinds whose media (music: thumbnail) is a material of the account (`materialId`). */
export const WXOA_MEDIA_REPLY_KINDS: readonly WxoaReplyKind[] = ['image', 'voice', 'video', 'music']

const ruleFields = {
  name: z.string().trim().min(1).max(64),
  triggerKind: z.enum(WXOA_REPLY_TRIGGERS),
  /** keyword rules only */
  matchMode: z.enum(WXOA_MATCH_MODES).nullish(),
  /** keyword rules only: 1–20 words of 1–30 characters */
  keywords: z.array(z.string().trim().min(1).max(30)).min(1).max(WXOA_KEYWORDS_MAX).nullish(),
  /** click rules: the menu key (≤ 128 UTF-8 bytes, compared as is); scan rules: the QR scene */
  eventKey: z.string().min(1).nullish(),
  /** keyword rules: higher first */
  priority: z.number().int().min(0).max(9999).optional(),
  replyKind: z.enum(WXOA_REPLY_KINDS),
  /** by `replyKind`: {@link wxoaReplyBodies} */
  replyBody: z.record(z.string(), z.unknown()),
  /** a material of the account: the media of image / voice / video, the thumbnail of music */
  materialId: wxoaId.nullish(),
  enabled: z.boolean().optional(),
}

type RuleInput = {
  triggerKind?: string
  matchMode?: unknown
  keywords?: unknown
  eventKey?: string | null
  replyKind?: WxoaReplyKind
  replyBody?: unknown
  materialId?: unknown
}

function checkRule(r: RuleInput, ctx: z.RefinementCtx) {
  const keyword = r.triggerKind === 'keyword'
  wxoaNeed(r.matchMode, keyword, 'matchMode', ctx)
  wxoaNeed(r.keywords, keyword, 'keywords', ctx)
  wxoaNeed(r.eventKey, r.triggerKind === 'click' || r.triggerKind === 'scan', 'eventKey', ctx)
  if (r.eventKey != null && r.triggerKind === 'click' && utf8Bytes(r.eventKey) > 128)
    ctx.addIssue({
      code: 'custom',
      path: ['eventKey'],
      message: 'validation.wxoa.bytes',
      params: { maxBytes: 128 },
    })
  if (r.eventKey != null && r.triggerKind === 'scan' && !WXOA_SCENE.test(r.eventKey))
    ctx.addIssue({ code: 'custom', path: ['eventKey'], message: 'validation.invalid_format.other' })
  const media = r.replyKind !== undefined && WXOA_MEDIA_REPLY_KINDS.includes(r.replyKind)
  wxoaNeed(r.materialId, media, 'materialId', ctx)
  wxoaCheckReplyBody(r.replyKind, r.replyBody, 'replyBody', ctx)
}

/** POST body. */
export const wxoaReplyRuleCreate = z
  .object({ accountId: wxoaId, ...ruleFields })
  .superRefine(checkRule)
  .register(fieldDomains, { domain: 'wxoa.replyRule' })
export type WxoaReplyRuleCreate = z.infer<typeof wxoaReplyRuleCreate>

/** PUT body: every field (a rule is checked as a whole); no `accountId`. */
export const wxoaReplyRuleUpdate = z
  .strictObject(ruleFields)
  .superRefine(checkRule)
  .register(fieldDomains, { domain: 'wxoa.replyRule' })
export type WxoaReplyRuleUpdate = z.infer<typeof wxoaReplyRuleUpdate>

export const wxoaReplyRuleQuery = pageQuery(['priority', 'createdAt', 'id'])
  .extend({
    accountId: wxoaQueryId,
    triggerKind: z.enum(WXOA_REPLY_TRIGGERS).optional(),
    name: z.string().trim().max(64).optional(),
    enabled: z.stringbool().optional(),
  })
  .register(fieldDomains, { domain: 'wxoa.replyRule' })
export type WxoaReplyRuleQuery = z.output<typeof wxoaReplyRuleQuery>

export const wxoaReplyRuleVo = z.object({
  id: z.number().int(),
  accountId: z.number().int(),
  name: z.string(),
  triggerKind: z.enum(WXOA_REPLY_TRIGGERS),
  matchMode: z.enum(WXOA_MATCH_MODES).nullable(),
  keywords: z.array(z.string()).nullable(),
  eventKey: z.string().nullable(),
  priority: z.number().int(),
  replyKind: z.enum(WXOA_REPLY_KINDS),
  replyBody: z.record(z.string(), z.unknown()),
  materialId: z.number().int().nullable(),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type WxoaReplyRuleVo = z.infer<typeof wxoaReplyRuleVo>
