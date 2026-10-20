import { wxoaImageUrl, wxoaXmlSafe } from '@qiwu/shared'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { z } from 'zod'

// Push bodies and passive replies (see docs/design-notes.md#wxoa). Bodies are parsed only, never built
// with the library: no DTD, tag values kept as the strings they came as (a 64-bit MsgId beyond the safe
// integers stays exact), entities left as written. Replies come from fixed templates with CDATA.

/** Why a push body was refused (the callback answers 400 whatever the reason). */
export type WxoaXmlFault = 'doctype' | 'syntax' | 'root' | 'shape'

export class WxoaXmlError extends Error {
  constructor(readonly fault: WxoaXmlFault) {
    super(`wxoa push body refused: ${fault}`)
  }
}

const parser = new XMLParser({
  parseTagValue: false,
  ignoreAttributes: true,
  processEntities: false,
  ignoreDeclaration: true,
})

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Index just past the first `close` at or after `from`, -1 when there is none. */
function after(s: string, close: string, from: number): number {
  const at = s.indexOf(close, from)
  return at === -1 ? -1 : at + close.length
}

/** Index just past the first `close` outside quotes at or after `from` (how the parser ends a tag). */
function afterTag(s: string, close: string, from: number): number {
  for (let i = from, quote = ''; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (s.startsWith(close, i)) return i + close.length
  }
  return -1
}

/**
 * Whether the parser would reach a `<!DOCTYPE` or `<!ENTITY` (any case): one pass, left to right, over
 * the markup the way the parser reads it, so a comment, a CDATA section (any `<![`), a processing
 * instruction or a tag (quoted attribute values included) is skipped whole and an opener inside one of
 * them cannot hide a declaration outside it. Stops at the first construct left open: the parser refuses
 * that body anyway.
 */
function reachesDoctype(s: string): boolean {
  for (let i = s.indexOf('<'); i !== -1;) {
    let end: number
    if (s.startsWith('<!--', i)) end = after(s, '-->', i + 4)
    else if (s.startsWith('<![', i)) end = after(s, ']]>', i + 3)
    else if (/^<!(?:DOCTYPE|ENTITY)/i.test(s.slice(i, i + 9))) return true
    else if (s[i + 1] === '/') end = after(s, '>', i + 2)
    else if (s[i + 1] === '?') end = afterTag(s, '?>', i + 1)
    else end = afterTag(s, '>', i + 1)
    if (end === -1) return false
    i = s.indexOf('<', end)
  }
  return false
}

/**
 * The children of a push body's `<xml>` root element. Refused: a DOCTYPE or ENTITY the parser would
 * read as one (`doctype`; text in comments, CDATA sections and attribute values is not one, and
 * entities are never expanded anyway), a body that is not well-formed (`syntax`), any other root or
 * none (`root`).
 */
export function wxoaParseXml(body: string): Record<string, unknown> {
  if (reachesDoctype(body)) throw new WxoaXmlError('doctype')
  if (XMLValidator.validate(body) !== true) throw new WxoaXmlError('syntax')
  let doc: unknown
  try {
    doc = parser.parse(body)
  } catch {
    throw new WxoaXmlError('syntax')
  }
  if (!isRecord(doc) || Object.keys(doc).length !== 1 || !isRecord(doc.xml))
    throw new WxoaXmlError('root')
  return doc.xml
}

/**
 * The `Encrypt` of an encrypted push (compat and secure mode), null when it has none or an empty one;
 * a repeated `Encrypt` is refused (`shape`).
 */
export function wxoaEncryptOf(fields: Record<string, unknown>): string | null {
  const v = fields.Encrypt
  if (v === undefined || v === '') return null
  if (typeof v !== 'string') throw new WxoaXmlError('shape')
  return v
}

/** A single text value: a repeated tag (array) or child elements (object) fail it. */
const text = z.string()
/** Child elements (WeChat may send the element empty). */
const group = (shape: Record<string, z.ZodType>) =>
  z.preprocess((v) => (v === '' ? {} : v), z.object(shape).partial())
/** Longest list kept: WeChat's own lists hold a few items (9 pictures, 8 articles). */
const LIST_MAX = 20
/** A repeated element: one occurrence parses as a value, several as an array. */
const list = (item: z.ZodType) =>
  z.preprocess(
    (v) => (v === '' ? [] : Array.isArray(v) ? v.slice(0, LIST_MAX) : [v]),
    z.array(item),
  )
/** `<item>` children, the way WeChat wraps its lists. */
const items = (item: z.ZodType) => group({ item: list(item) })
/** The outer element of each subscribe-notice event: `<SubscribeMsgPopupEvent><List>…</List></…>`. */
export const WXOA_NOTICE_EVENTS: Readonly<Record<string, string>> = {
  subscribe_msg_popup_event: 'SubscribeMsgPopupEvent',
  subscribe_msg_change_event: 'SubscribeMsgChangeEvent',
  subscribe_msg_sent_event: 'SubscribeMsgSentEvent',
}
/** A subscribe-notice event: one `List` element per template inside its outer element. */
const noticeEvent = (kind: string, item: Record<string, z.ZodType>) => ({
  [WXOA_NOTICE_EVENTS[kind]!]: group({ List: list(group(item)) }),
})

/** The fields every push has, the ones of a kind without its own structure. */
const head = z.object({
  ToUserName: text,
  FromUserName: text.min(1),
  CreateTime: text.regex(/^\d{1,12}$/),
  MsgType: text.min(1),
  Event: text.optional(),
  EventKey: text.optional(),
  MsgId: text.optional(),
  MsgID: text.optional(),
})

/** A message quoting an article */
const fromArticle = { MsgDataId: text, Idx: text }
const video = { MediaId: text, ThumbMediaId: text, ...fromArticle }
const scan = { ScanCodeInfo: group({ ScanType: text, ScanResult: text }) }
const pics = {
  SendPicsInfo: group({ Count: text, PicList: items(group({ PicMd5Sum: text })) }),
}

/** Whitelisted fields of the user messages (`MsgType`); all of them carry a `MsgId`. */
const MESSAGES = new Map<string, Record<string, z.ZodType>>([
  ['text', { Content: text, ...fromArticle }],
  ['image', { PicUrl: text, MediaId: text, ...fromArticle }],
  ['voice', { MediaId: text, Format: text, Recognition: text, MediaId16K: text, ...fromArticle }],
  ['video', video],
  ['shortvideo', video],
  ['location', { Location_X: text, Location_Y: text, Scale: text, Label: text, ...fromArticle }],
  ['link', { Title: text, Description: text, Url: text, ...fromArticle }],
])

/** Whitelisted fields of the events (`MsgType` event, by `Event`) besides `EventKey` and `MsgID`. */
const EVENTS = new Map<string, Record<string, z.ZodType>>([
  ['subscribe', { Ticket: text }],
  ['unsubscribe', {}],
  ['SCAN', { Ticket: text }],
  ['LOCATION', { Latitude: text, Longitude: text, Precision: text }],
  ['CLICK', {}],
  ['VIEW', { MenuId: text }],
  ['view_miniprogram', { MenuId: text }],
  ['scancode_push', scan],
  ['scancode_waitmsg', scan],
  ['pic_sysphoto', pics],
  ['pic_photo_or_album', pics],
  ['pic_weixin', pics],
  [
    'location_select',
    {
      SendLocationInfo: group({
        Location_X: text,
        Location_Y: text,
        Scale: text,
        Label: text,
        Poiname: text,
      }),
    },
  ],
  ['TEMPLATESENDJOBFINISH', { Status: text }],
  [
    'MASSSENDJOBFINISH',
    {
      Status: text,
      TotalCount: text,
      FilterCount: text,
      SentCount: text,
      ErrorCount: text,
      CopyrightCheckResult: group({
        Count: text,
        ResultList: items(
          group({
            ArticleIdx: text,
            UserDeclareState: text,
            AuditState: text,
            OriginalArticleUrl: text,
            OriginalArticleType: text,
            CanReprint: text,
            NeedReplaceContent: text,
            NeedShowReprintSource: text,
          }),
        ),
        CheckState: text,
      }),
      ArticleUrlResult: group({
        Count: text,
        ResultList: items(group({ ArticleIdx: text, ArticleUrl: text })),
      }),
    },
  ],
  [
    'subscribe_msg_popup_event',
    noticeEvent('subscribe_msg_popup_event', {
      TemplateId: text,
      SubscribeStatusString: text,
      PopupScene: text,
    }),
  ],
  [
    'subscribe_msg_change_event',
    noticeEvent('subscribe_msg_change_event', { TemplateId: text, SubscribeStatusString: text }),
  ],
  [
    'subscribe_msg_sent_event',
    noticeEvent('subscribe_msg_sent_event', {
      TemplateId: text,
      MsgID: text,
      ErrorCode: text,
      ErrorStatus: text,
    }),
  ],
  [
    'PUBLISHJOBFINISH',
    {
      PublishEventInfo: group({
        publish_id: text,
        publish_status: text,
        article_id: text,
        article_detail: group({
          count: text,
          item: list(group({ idx: text, article_url: text })),
        }),
        fail_idx: list(text),
      }),
    },
  ],
])

/** Largest `payload`, serialized, in UTF-8 bytes. */
export const WXOA_PAYLOAD_MAX = 16 * 1024

/** A push read: the common fields cut to their columns' widths, the whitelisted rest. */
export interface WxoaPush {
  /** the account's original id */
  toUser: string
  /** the sender (FromUserName): the fan, or `mphelper` for mass-send and publish receipts */
  openId: string
  /** seconds */
  createTime: number
  /** MsgType */
  msgKind: string
  /** Event */
  eventKind: string | null
  /** EventKey: a menu key, a QR scene (`qrscene_` prefixed on subscribe), a VIEW button's url */
  eventKey: string | null
  /** MsgId of a user message (64 bits, a string) */
  msgId: string | null
  /** MsgID of a template or mass-send receipt */
  msgID: string | null
  /** whether the kind has its own structure; without one only the common fields are read */
  known: boolean
  /** the kind's whitelisted fields ({} without a structure); `truncated: true` when texts were cut */
  payload: Record<string, unknown>
  /** a text message's Content or a voice message's Recognition, uncut: what keyword rules match */
  text: string | null
}

/** The first `max` characters (code points, as MySQL counts them). */
const cut = (s: string, max: number) => (s.length <= max ? s : [...s].slice(0, max).join(''))
const cutOrNull = (s: string | undefined, max: number) => (s === undefined ? null : cut(s, max))

/**
 * Reads the fields of a push (`wxoaParseXml`): the common ones must be single values (`shape`
 * otherwise), the kind's own structure is checked when it has one, a user message must carry a numeric
 * `MsgId`. Fields outside the whitelist are dropped; a payload over {@link WXOA_PAYLOAD_MAX} has its
 * longest texts cut, never refused.
 */
export function wxoaReadPush(fields: Record<string, unknown>): WxoaPush {
  const h = head.safeParse(fields)
  if (!h.success) throw new WxoaXmlError('shape')
  const { MsgType, Event } = h.data
  const message = MESSAGES.get(MsgType)
  const shape = message ?? (MsgType === 'event' && Event ? EVENTS.get(Event) : undefined)
  let payload: Record<string, unknown> = {}
  if (shape) {
    const own = z.object(shape).partial().safeParse(fields)
    if (!own.success || (message && !/^\d{1,20}$/.test(h.data.MsgId ?? '')))
      throw new WxoaXmlError('shape')
    payload = own.data
    if (typeof payload.PicUrl === 'string')
      payload.PicUrl = wxoaImageUrl(payload.PicUrl) ?? payload.PicUrl
  }
  const said =
    MsgType === 'text' ? payload.Content : MsgType === 'voice' ? payload.Recognition : null
  return {
    toUser: cut(h.data.ToUserName, 64),
    openId: cut(h.data.FromUserName, 64),
    createTime: Number(h.data.CreateTime),
    msgKind: cut(MsgType, 24),
    eventKind: cutOrNull(Event, 48),
    eventKey: cutOrNull(h.data.EventKey, 1024),
    msgId: cutOrNull(h.data.MsgId, 24),
    msgID: cutOrNull(h.data.MsgID, 24),
    known: shape !== undefined,
    payload: fitPayload(payload),
    text: typeof said === 'string' ? said : null,
  }
}

const bytes = (s: string) => Buffer.byteLength(s)

/** `s` cut to at most `max` UTF-8 bytes, never inside a character. */
function cutBytes(s: string, max: number): string {
  let size = 0
  let end = 0
  for (const ch of s) {
    size += bytes(ch)
    if (size > max) break
    end += ch.length
  }
  return s.slice(0, end)
}

/**
 * `payload` within {@link WXOA_PAYLOAD_MAX} once serialized: the longest text is cut by the excess
 * (removing n raw bytes shortens the JSON by at least n) until it fits, and `truncated` is set.
 */
function fitPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (bytes(JSON.stringify(payload)) <= WXOA_PAYLOAD_MAX) return payload
  payload.truncated = true
  for (
    let size = bytes(JSON.stringify(payload));
    size > WXOA_PAYLOAD_MAX;
    size = bytes(JSON.stringify(payload))
  ) {
    let longest = { node: payload, key: '', size: 0 }
    const walk = (node: Record<string, unknown>) => {
      for (const [key, v] of Object.entries(node))
        if (typeof v === 'string') {
          if (bytes(v) > longest.size) longest = { node, key, size: bytes(v) }
        } else if (typeof v === 'object' && v !== null) walk(v as Record<string, unknown>)
    }
    walk(payload)
    if (!longest.size) break
    const { node, key } = longest
    node[key] = cutBytes(node[key] as string, longest.size - (size - WXOA_PAYLOAD_MAX))
  }
  return payload
}

/** A passive reply, its media already WeChat media ids. */
export type WxoaReply =
  | { kind: 'text'; content: string }
  | { kind: 'image' | 'voice'; mediaId: string }
  | { kind: 'video'; mediaId: string; title?: string; description?: string }
  | {
      kind: 'music'
      title: string
      description: string
      musicUrl: string
      hqMusicUrl?: string
      thumbMediaId: string
    }
  /** one article linking out */
  | { kind: 'news'; title: string; description: string; url: string; picUrl: string }

/** `s` as CDATA, a `]]>` in it split over two sections. */
export const wxoaCdata = (s: string) => `<![CDATA[${s.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`

const el = (tag: string, v: string | undefined) =>
  v === undefined ? '' : `<${tag}>${wxoaCdata(v)}</${tag}>`

function replyBody(r: WxoaReply): string {
  switch (r.kind) {
    case 'text':
      return el('Content', r.content)
    case 'image':
      return `<Image>${el('MediaId', r.mediaId)}</Image>`
    case 'voice':
      return `<Voice>${el('MediaId', r.mediaId)}</Voice>`
    case 'video':
      return `<Video>${el('MediaId', r.mediaId)}${el('Title', r.title)}${el('Description', r.description)}</Video>`
    case 'music':
      return `<Music>${el('Title', r.title)}${el('Description', r.description)}${el('MusicUrl', r.musicUrl)}${el('HQMusicUrl', r.hqMusicUrl)}${el('ThumbMediaId', r.thumbMediaId)}</Music>`
    case 'news':
      return `<ArticleCount>1</ArticleCount><Articles><item>${el('Title', r.title)}${el('Description', r.description)}${el('PicUrl', r.picUrl)}${el('Url', r.url)}</item></Articles>`
  }
}

/**
 * The passive reply to `push` (to the sender, from the account), or null when one of its texts holds a
 * character XML 1.0 forbids: WeChat refuses such a reply whole, so the callback answers `success`.
 */
export function wxoaReplyXml(
  push: Pick<WxoaPush, 'openId' | 'toUser'>,
  reply: WxoaReply,
  now = Date.now(),
): string | null {
  const texts = [push.openId, push.toUser, ...Object.values(reply)]
  if (!texts.every((v) => typeof v !== 'string' || wxoaXmlSafe(v))) return null
  return `<xml>${el('ToUserName', push.openId)}${el('FromUserName', push.toUser)}<CreateTime>${Math.floor(now / 1000)}</CreateTime>${el('MsgType', reply.kind)}${replyBody(reply)}</xml>`
}
