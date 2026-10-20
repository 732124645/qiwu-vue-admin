import { z } from 'zod'
import { utf8Bytes } from '../../common/password-policy.js'
import { fieldDomains } from '../../validation/zod-i18n.js'

/**
 * WeChat Official Account management (`wxoa_*` tables), `/api/wxoa/*` (see docs/design-notes.md#wxoa).
 * Several accounts; every other row belongs to one by `accountId`, and every id a request refers to must
 * belong to the same account (else 404). Permissions are per feature: holding one acts on every account.
 * Field labels `field.wxoa.<resource>.<prop>`.
 */

export const wxoaPerms = {
  account: {
    browse: 'wxoa.account.browse',
    create: 'wxoa.account.create',
    modify: 'wxoa.account.modify',
    remove: 'wxoa.account.remove',
    /** reset the account's API call counts (`clear_quota/v2`, 10 a month with the console's reset) */
    'clear-quota': 'wxoa.account.clear-quota',
  },
  message: { browse: 'wxoa.message.browse', send: 'wxoa.message.send' },
  reply: {
    browse: 'wxoa.reply.browse',
    create: 'wxoa.reply.create',
    modify: 'wxoa.reply.modify',
    remove: 'wxoa.reply.remove',
  },
  menu: { browse: 'wxoa.menu.browse', modify: 'wxoa.menu.modify', publish: 'wxoa.menu.publish' },
  fan: {
    browse: 'wxoa.fan.browse',
    modify: 'wxoa.fan.modify',
    sync: 'wxoa.fan.sync',
    export: 'wxoa.fan.export',
  },
  tag: {
    browse: 'wxoa.tag.browse',
    create: 'wxoa.tag.create',
    modify: 'wxoa.tag.modify',
    remove: 'wxoa.tag.remove',
  },
  material: {
    browse: 'wxoa.material.browse',
    create: 'wxoa.material.create',
    remove: 'wxoa.material.remove',
    sync: 'wxoa.material.sync',
  },
  template: {
    browse: 'wxoa.template.browse',
    remove: 'wxoa.template.remove',
    send: 'wxoa.template.send',
  },
  qrcode: {
    browse: 'wxoa.qrcode.browse',
    create: 'wxoa.qrcode.create',
    modify: 'wxoa.qrcode.modify',
    remove: 'wxoa.qrcode.remove',
  },
  draft: {
    browse: 'wxoa.draft.browse',
    create: 'wxoa.draft.create',
    modify: 'wxoa.draft.modify',
    remove: 'wxoa.draft.remove',
    sync: 'wxoa.draft.sync',
  },
  publish: {
    browse: 'wxoa.publish.browse',
    create: 'wxoa.publish.create',
    remove: 'wxoa.publish.remove',
  },
  comment: {
    browse: 'wxoa.comment.browse',
    modify: 'wxoa.comment.modify',
    send: 'wxoa.comment.send',
    remove: 'wxoa.comment.remove',
  },
  mass: { browse: 'wxoa.mass.browse', send: 'wxoa.mass.send', remove: 'wxoa.mass.remove' },
  stat: { browse: 'wxoa.stat.browse' },
  notice: { browse: 'wxoa.notice.browse', modify: 'wxoa.notice.modify', send: 'wxoa.notice.send' },
} as const

/** Built-in params (not public), read through ParamService: an invalid value falls back to the default. */
export const wxoaParams = {
  /** days the message log is kept: 0–3650, 0 = forever (default {@link WXOA_RETENTION_DAYS_DEFAULT}) */
  retentionDays: 'wxoa.message.retention_days',
  /** copy inbound images, voice and video thumbnails to local storage (WeChat keeps them 3 days) */
  copyInbound: 'wxoa.media.copy_inbound',
} as const
export const WXOA_RETENTION_DAYS_DEFAULT = 180

/** Every resource's `browse`: any one of them reads the account options (`GET /accounts/options`). */
export const WXOA_BROWSE_PERMS: readonly string[] = Object.values(wxoaPerms).map((p) => p.browse)

/**
 * Storage tag of an account's WeChat media copies (`biz_ref` {@link wxoaMediaRef}). Internal: not in
 * `STORAGE_BIZ_TAGS`, so the generic upload, presign and confirm refuse it; private (not a public tag).
 */
export const WXOA_MEDIA_TAG = 'wxoa.media'
export const wxoaMediaRef = (accountId: number) => `wxoa:${accountId}`

// Codes of the dicts `wxoa.*` (labels in both languages are seeded).
export const WXOA_ACCOUNT_KINDS = ['service', 'subscription', 'sandbox'] as const
export type WxoaAccountKind = (typeof WXOA_ACCOUNT_KINDS)[number]
export const WXOA_CRYPTO_MODES = ['plain', 'compat', 'secure'] as const
export type WxoaCryptoMode = (typeof WXOA_CRYPTO_MODES)[number]
export const WXOA_DIRECTIONS = ['in', 'out'] as const
export type WxoaDirection = (typeof WXOA_DIRECTIONS)[number]
export const WXOA_CHANNELS = ['push', 'passive', 'cs', 'template', 'preview', 'notice'] as const
export type WxoaChannel = (typeof WXOA_CHANNELS)[number]
/** Known message kinds; an inbound type WeChat adds later is stored as it came. */
export const WXOA_MSG_KINDS = [
  'text',
  'image',
  'voice',
  'video',
  'shortvideo',
  'location',
  'link',
  'event',
  'music',
  'news',
  'template',
] as const
export const WXOA_REPLY_TRIGGERS = ['subscribe', 'keyword', 'default', 'click', 'scan'] as const
export type WxoaReplyTrigger = (typeof WXOA_REPLY_TRIGGERS)[number]
export const WXOA_MATCH_MODES = ['exact', 'contains'] as const
export const WXOA_REPLY_KINDS = ['text', 'image', 'voice', 'video', 'music', 'news'] as const
export type WxoaReplyKind = (typeof WXOA_REPLY_KINDS)[number]
/** Menu button kinds a menu may be saved with. */
export const WXOA_BUTTON_KINDS = [
  'click',
  'view',
  'miniprogram',
  'scancode_push',
  'scancode_waitmsg',
  'pic_sysphoto',
  'pic_photo_or_album',
  'pic_weixin',
  'location_select',
  'article_id',
  'article_view_limited',
] as const
/** Retired kinds: kept when a menu is pulled from WeChat, never added or changed by a save. */
export const WXOA_LEGACY_BUTTON_KINDS = ['media_id', 'view_limited'] as const
export type WxoaButtonKind =
  (typeof WXOA_BUTTON_KINDS)[number] | (typeof WXOA_LEGACY_BUTTON_KINDS)[number]
export const WXOA_MENU_KINDS = ['default', 'conditional'] as const
export type WxoaMenuKind = (typeof WXOA_MENU_KINDS)[number]
export const WXOA_CLIENT_PLATFORMS = ['ios', 'android', 'other'] as const
export const WXOA_MEDIA_KINDS = ['image', 'voice', 'video', 'thumb'] as const
export type WxoaMediaKind = (typeof WXOA_MEDIA_KINDS)[number]
export const WXOA_MATERIAL_ORIGINS = ['local', 'pulled'] as const
export const WXOA_QR_KINDS = ['temporary', 'permanent'] as const
export const WXOA_SEND_STATES = ['pending', 'sent', 'delivered', 'failed', 'user_blocked'] as const

/** AppID (sandbox accounts are assumed to use the same format). */
export const WXOA_APP_ID = /^wx[0-9a-f]{16}$/
export const WXOA_APP_SECRET = /^[0-9a-fA-F]{32}$/
/** The push Token set on WeChat's side. */
export const WXOA_TOKEN = /^[A-Za-z0-9]{3,32}$/
export const WXOA_AES_KEY = /^[A-Za-z0-9]{43}$/
/** String scene of a channel QR code, also the event key of a scan reply rule. */
export const WXOA_SCENE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Whether WeChat takes the text in an XML reply: none of U+0000–U+0008, U+000B, U+000C, U+000E–U+001F,
 * U+FFFE, U+FFFF or an unpaired surrogate (XML 1.0 forbids them; WeChat drops the whole reply).
 */
export function wxoaXmlSafe(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 ? c !== 0x09 && c !== 0x0a && c !== 0x0d : c === 0xfffe || c === 0xffff)
      return false
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

/** A text WeChat limits in UTF-8 bytes (menu names, keys, urls): `validation.wxoa.bytes` `{ maxBytes }`. */
export const wxoaBytes = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((s) => utf8Bytes(s) <= maxBytes, {
      error: 'validation.wxoa.bytes',
      params: { maxBytes },
    })

/** An http(s) link of at most `maxBytes` UTF-8 bytes that an XML reply can carry. */
export const wxoaHttpUrl = (maxBytes = 1024) =>
  wxoaBytes(maxBytes)
    .refine(wxoaXmlSafe, { error: 'validation.wxoa.xml_char' })
    .pipe(z.url({ protocol: /^https?$/ }))

const MMBIZ_HOSTS = ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn']

/**
 * A WeChat image link as stored and shown: on `mmbiz.qpic.cn` / `mmbiz.qlogo.cn` (default port, no
 * credentials) the `https:` form; any other host or no link → null (the page shows a placeholder).
 */
export function wxoaImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password || url.port || !MMBIZ_HOSTS.includes(url.hostname)) return null
  url.protocol = 'https:'
  return url.href
}

/** A field given exactly when `wanted`: missing → `validation.required`, foreign → `validation.invalid`. */
export function wxoaNeed(value: unknown, wanted: boolean, prop: string, ctx: z.RefinementCtx) {
  if ((value != null) !== wanted)
    ctx.addIssue({
      code: 'custom',
      path: [prop],
      message: wanted ? 'validation.required' : 'validation.invalid',
    })
}

/** Upstream tag ids (`wxoa_tag.tag_id`, an `int unsigned`). */
export const wxoaTagId = z.number().int().min(0).max(4_294_967_295)
export const wxoaId = z.number().int().positive()
/** An id in a query string (missing or blank → `validation.required`). */
export const wxoaQueryId = z.preprocess(
  (v) => (v === '' ? undefined : typeof v === 'string' ? Number(v) : v),
  z.number().int().positive(),
)

/**
 * Query or body of a route acting on an account as a whole (syncs, menu pull / clear / try-match,
 * material counts, template list and industry, template delete): the account must be alive (404) and
 * enabled (`B6011`).
 */
export const wxoaAccountScope = z
  .object({ accountId: wxoaQueryId })
  .register(fieldDomains, { domain: 'wxoa.account' })
export type WxoaAccountScope = z.infer<typeof wxoaAccountScope>
export const wxoaAccountRef = z
  .object({ accountId: wxoaId })
  .register(fieldDomains, { domain: 'wxoa.account' })
export type WxoaAccountRef = z.infer<typeof wxoaAccountRef>

/** Background syncs (fans, materials): one per account and kind across instances, else `B6010`. */
export const WXOA_SYNC_STATES = ['idle', 'running', 'done', 'failed', 'interrupted'] as const
export const wxoaSyncVo = z.object({
  /** `interrupted`: the instance running it stopped; it may run again */
  state: z.enum(WXOA_SYNC_STATES),
  done: z.number().int(),
  total: z.number().int().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  /** the error code of a failed run */
  code: z.string().nullable(),
})
export type WxoaSyncVo = z.infer<typeof wxoaSyncVo>
