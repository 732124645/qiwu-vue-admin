import { describe, expect, it } from 'vitest'
import { Err } from '../../common/error-codes.js'
import { RT } from '../../common/realtime.js'
import { RESERVED_NAMES } from '../../common/reserved-names.js'
import {
  STORAGE_BIZ_TAGS,
  STORAGE_PRIVATE_TAGS,
  STORAGE_PUBLIC_TAGS,
} from '../storage/storage.schema.js'
import { fieldDomainOf } from '../../validation/zod-i18n.js'
import { wxoaAccountCreate, wxoaAccountUpdate } from './account.schema.js'
import { wxoaFanRemarkBody, wxoaFanTaggingBody } from './fan.schema.js'
import { wxoaMaterialCreate } from './material.schema.js'
import {
  wxoaButtons,
  wxoaMenuCreate,
  wxoaMenuPullResult,
  wxoaMenuTryMatchVo,
  wxoaMenuUpdate,
  wxoaMenuUpdateFor,
  wxoaStoredButtons,
} from './menu.schema.js'
import { wxoaMessageQuery, wxoaMessageSend } from './message.schema.js'
import { wxoaQrcodeCreate, wxoaQrcodeUpdate } from './qrcode.schema.js'
import { wxoaReplyRuleCreate, wxoaReplyRuleUpdate } from './reply-rule.schema.js'
import { wxoaTemplateSendBody, wxoaTemplateValueMax } from './template.schema.js'
import {
  WXOA_BROWSE_PERMS,
  WXOA_MEDIA_TAG,
  wxoaImageUrl,
  wxoaMediaRef,
  wxoaPerms,
  wxoaXmlSafe,
} from './wxoa.schema.js'

type Schema = {
  safeParse: (v: unknown) => { error?: { issues: { path: PropertyKey[]; message: string }[] } }
}
/** `path:message` of every issue, [] when valid. */
const issues = (schema: Schema, v: unknown) =>
  (schema.safeParse(v).error?.issues ?? []).map((i) => `${i.path.join('.')}:${i.message}`)

const APP_ID = 'wx0123456789abcdef'
const cjk = (n: number) => '菜'.repeat(n)

describe('wxoa permissions, codes and names', () => {
  it('every perm is wxoa.<resource>.<verb>; the browse list is derived from them', () => {
    const all = Object.values(wxoaPerms).flatMap((p) => Object.values(p))
    for (const perm of all) expect(perm).toMatch(/^wxoa\.[a-z]+\.[a-z-]+$/)
    expect(WXOA_BROWSE_PERMS).toEqual(Object.values(wxoaPerms).map((p) => p.browse))
    expect(WXOA_BROWSE_PERMS).toHaveLength(15)
    expect(WXOA_BROWSE_PERMS).toContain('wxoa.qrcode.browse')
    expect(wxoaPerms.account['clear-quota']).toBe('wxoa.account.clear-quota')
  })

  it('error codes B6001–B6011 and the content codes under error.wxoa.*', () => {
    const wxoa = Object.values(Err).filter((e) => e.code.startsWith('B6'))
    expect(wxoa.map((e) => e.code)).toEqual([
      ...Array.from({ length: 11 }, (_, i) => `B60${String(i + 1).padStart(2, '0')}`),
      'B6101',
      'B6102',
      'B6103',
    ])
    for (const e of wxoa) expect(e.key).toMatch(/^error\.wxoa\.[a-z_]+$/)
    expect([Err.WXOA_UPSTREAM.status, Err.WXOA_QUOTA_EXCEEDED.status]).toEqual([502, 429])
    expect(Err.WXOA_SYNC_RUNNING.status).toBe(409)
  })

  it('realtime event, reserved domain and the internal media tag', () => {
    expect(RT.wxoaMessage).toBe('wxoa:message')
    expect(RESERVED_NAMES.has('wxoa')).toBe(true)
    expect(WXOA_MEDIA_TAG).toBe('wxoa.media')
    expect(wxoaMediaRef(7)).toBe('wxoa:7')
    expect(STORAGE_BIZ_TAGS as readonly string[]).not.toContain(WXOA_MEDIA_TAG)
    expect(STORAGE_PRIVATE_TAGS as readonly string[]).not.toContain(WXOA_MEDIA_TAG)
    expect(STORAGE_PUBLIC_TAGS as readonly string[]).not.toContain(WXOA_MEDIA_TAG)
  })
})

describe('wxoa accounts', () => {
  const account = {
    label: 'Demo',
    accountKind: 'service',
    appId: APP_ID,
    appSecret: 'a'.repeat(32),
    token: 'tok3n',
  }

  it('AppID, AppSecret, Token and EncodingAESKey formats', () => {
    expect(issues(wxoaAccountCreate, account)).toEqual([])
    for (const appId of ['wx0123456789ABCDEF', 'wx0123456789abcde', 'xx0123456789abcdef', ''])
      expect(issues(wxoaAccountCreate, { ...account, appId })).toEqual([
        expect.stringMatching(/^appId:/),
      ])
    expect(issues(wxoaAccountCreate, { ...account, appSecret: 'g'.repeat(32) })).toHaveLength(1)
    expect(issues(wxoaAccountCreate, { ...account, token: 'ab' })).toHaveLength(1)
    expect(issues(wxoaAccountCreate, { ...account, token: 'a'.repeat(33) })).toHaveLength(1)
    expect(issues(wxoaAccountCreate, { ...account, aesKey: 'A'.repeat(43) })).toEqual([])
    expect(issues(wxoaAccountCreate, { ...account, aesKey: 'A'.repeat(42) })).toHaveLength(1)
  })

  it('a sandbox account pushes in plain mode only', () => {
    const sandbox = { ...account, accountKind: 'sandbox' }
    expect(issues(wxoaAccountCreate, { ...sandbox, cryptoMode: 'plain' })).toEqual([])
    expect(issues(wxoaAccountCreate, { ...sandbox, cryptoMode: 'secure' })).toEqual([
      'cryptoMode:validation.invalid',
    ])
    expect(issues(wxoaAccountUpdate, { accountKind: 'sandbox', cryptoMode: 'compat' })).toEqual([
      'cryptoMode:validation.invalid',
    ])
  })

  it('update: no AppID; empty or absent secrets are kept, wrong ones refused', () => {
    expect(issues(wxoaAccountUpdate, { appId: APP_ID })).toEqual([':validation.unrecognized_keys'])
    expect(issues(wxoaAccountUpdate, { appSecret: '', token: '', aesKey: '' })).toEqual([])
    expect(issues(wxoaAccountUpdate, {})).toEqual([])
    expect(issues(wxoaAccountUpdate, { appSecret: 'short' })).toEqual([
      'appSecret:validation.invalid_format.other',
    ])
  })
})

describe('wxoa menus', () => {
  const click = (name: string, key = 'k') => ({ name, kind: 'click', key })
  const menu = (buttons: unknown) =>
    issues(wxoaMenuCreate, { accountId: 1, menuKind: 'default', label: 'M', buttons })

  it('names: ≤ 16 UTF-8 bytes on top, ≤ 60 below', () => {
    expect(menu([click('a'.repeat(16)), click(cjk(5))])).toEqual([])
    expect(menu([click('a'.repeat(17))])).toEqual(['buttons.0.name:validation.wxoa.bytes'])
    expect(menu([click(cjk(6))])).toEqual(['buttons.0.name:validation.wxoa.bytes'])
    expect(menu([{ name: 'P', subButtons: [click(cjk(20))] }])).toEqual([])
    expect(menu([{ name: 'P', subButtons: [click(`${cjk(19)}abcd`)] }])).toEqual([
      'buttons.0.subButtons.0.name:validation.wxoa.bytes',
    ])
    expect(menu([click('   ')])).toEqual(['buttons.0.name:validation.required'])
  })

  it('keys ≤ 128 bytes and links ≤ 1024 bytes (multi-byte counted as UTF-8)', () => {
    expect(menu([click('a', 'k'.repeat(128))])).toEqual([])
    expect(menu([click('a', '键'.repeat(42))])).toEqual([])
    expect(menu([click('a', '键'.repeat(43))])).toEqual(['buttons.0.key:validation.wxoa.bytes'])
    const url = (n: number) => `https://example.com/${'p'.repeat(n - 20)}`
    expect(url(1024)).toHaveLength(1024)
    expect(menu([{ name: 'v', kind: 'view', url: url(1024) }])).toEqual([])
    expect(menu([{ name: 'v', kind: 'view', url: url(1025) }])).toEqual([
      'buttons.0.url:validation.wxoa.bytes',
    ])
    expect(menu([{ name: 'v', kind: 'view', url: 'ftp://example.com/x' }])).toEqual([
      'buttons.0.url:validation.invalid_format.url',
    ])
  })

  it('counts: 1–3 buttons, 1–5 sub-buttons', () => {
    expect(menu([click('a'), click('b'), click('c')])).toEqual([])
    expect(menu([click('a'), click('b'), click('c'), click('d')])).toEqual([
      'buttons:validation.too_big.array',
    ])
    expect(menu([])).toEqual(['buttons:validation.too_small.array'])
    const subs = (n: number) => Array.from({ length: n }, (_, i) => click(`s${i}`))
    expect(menu([{ name: 'P', subButtons: subs(5) }])).toEqual([])
    expect(menu([{ name: 'P', subButtons: subs(6) }])).toEqual([
      'buttons.0.subButtons:validation.too_big.array',
    ])
  })

  it('each kind needs exactly its own fields; a parent has a name only', () => {
    const one = (b: object) => menu([{ name: 'b', ...b }])
    for (const kind of ['click', 'scancode_push', 'pic_weixin', 'location_select'])
      expect(one({ kind })).toEqual(['buttons.0.key:validation.required'])
    expect(one({ kind: 'view' })).toEqual(['buttons.0.url:validation.required'])
    expect(one({ kind: 'miniprogram', url: 'https://example.com' })).toEqual([
      'buttons.0.appId:validation.required',
      'buttons.0.pagePath:validation.required',
    ])
    expect(
      one({ kind: 'miniprogram', url: 'https://e.com', appId: APP_ID, pagePath: 'pages/a' }),
    ).toEqual([])
    expect(one({ kind: 'article_id' })).toEqual(['buttons.0.articleId:validation.required'])
    expect(one({ kind: 'click', key: 'k', url: 'https://e.com' })).toEqual([
      'buttons.0.url:validation.invalid',
    ])
    expect(one({})).toEqual(['buttons.0.kind:validation.required'])
    expect(one({ kind: 'click', key: 'k', subButtons: [click('s')] })).toEqual([
      'buttons.0.kind:validation.invalid',
      'buttons.0.key:validation.invalid',
    ])
    expect(one({ kind: 'click', key: 'k', extra: 1 })).toEqual([
      'buttons.0:validation.unrecognized_keys',
    ])
  })

  it('retired kinds: never on a new menu; a PUT keeps or drops the stored ones, adds or changes none', () => {
    const legacy = { name: 'm', kind: 'media_id' as const, mediaId: 'MEDIA' }
    expect(issues(wxoaStoredButtons, [legacy])).toEqual([])
    expect(issues(wxoaButtons, [legacy])).toEqual(['0.kind:validation.invalid_value'])
    const nested = { ...legacy, name: 'n' }
    const stored = {
      menuKind: 'default' as const,
      buttons: [legacy, { name: 'P', subButtons: [nested] }],
    }
    const put = (buttons: unknown[]) => issues(wxoaMenuUpdateFor(stored), { label: 'M', buttons })
    expect(put([click('a'), { name: 'Q', subButtons: [nested, click('b')] }, legacy])).toEqual([])
    expect(put([click('a')])).toEqual([])
    expect(put([{ ...legacy, name: 'x' }])).toEqual(['buttons.0.kind:validation.invalid'])
    expect(put([{ ...legacy, mediaId: 'OTHER' }])).toEqual(['buttons.0.kind:validation.invalid'])
    expect(put([legacy, legacy])).toEqual(['buttons.1.kind:validation.invalid'])
    expect(
      put([{ name: 'P', subButtons: [{ name: 'v', kind: 'view_limited', mediaId: 'V' }] }]),
    ).toEqual(['buttons.0.subButtons.0.kind:validation.invalid'])
  })

  it('a conditional menu matches something; a default one nothing; PUT has no accountId or kind', () => {
    const base = { accountId: 1, label: 'M', buttons: [click('a')] }
    expect(issues(wxoaMenuCreate, { ...base, menuKind: 'conditional' })).toEqual([
      'matchTagId:validation.wxoa.menu_match',
    ])
    expect(
      issues(wxoaMenuCreate, { ...base, menuKind: 'conditional', matchPlatform: 'ios' }),
    ).toEqual([])
    expect(issues(wxoaMenuCreate, { ...base, menuKind: 'default', matchTagId: 2 })).toEqual([
      'matchTagId:validation.invalid',
    ])
    const { accountId: _, ...update } = base
    expect(issues(wxoaMenuUpdate, update)).toEqual([])
    for (const extra of [{ accountId: 1 }, { menuKind: 'default' }])
      expect(issues(wxoaMenuUpdate, { ...update, ...extra })).toEqual([
        ':validation.unrecognized_keys',
      ])
    const conditional = wxoaMenuUpdateFor({ menuKind: 'conditional', buttons: [] })
    expect(fieldDomainOf(conditional)).toBe('wxoa.menu')
    expect(issues(conditional, update)).toEqual(['matchTagId:validation.wxoa.menu_match'])
    expect(issues(conditional, { ...update, matchTagId: 2 })).toEqual([])
    const byDefault = wxoaMenuUpdateFor({ menuKind: 'default', buttons: [] })
    expect(issues(byDefault, { ...update, matchPlatform: 'ios' })).toEqual([
      'matchPlatform:validation.invalid',
    ])
  })

  it('pull and try-match answers: skipped menus by kind, menuid and reason; buttons in the stored camelCase shape', () => {
    const skipped = (s: object) => issues(wxoaMenuPullResult, { menus: [], skipped: [s] })
    expect(skipped({ menuKind: 'conditional', wxMenuId: '603', reason: 'no_match' })).toEqual([])
    expect(skipped({ menuKind: 'default', wxMenuId: null, reason: 'invalid' })).toEqual([])
    expect(skipped({ menuKind: 'conditional', reason: 'no_match' })).toEqual([
      'skipped.0.wxMenuId:validation.required',
    ])
    expect(skipped({ menuKind: 'conditional', wxMenuId: '1', reason: 'other' })).toEqual([
      'skipped.0.reason:validation.invalid_value',
    ])
    expect(issues(wxoaMenuPullResult, { skipped: [] })).toEqual(['menus:validation.required'])

    const tried = (buttons: unknown) => issues(wxoaMenuTryMatchVo, { buttons })
    expect(tried([])).toEqual([])
    expect(
      tried([
        { name: 'A', kind: 'click', key: 'K' },
        { name: 'P', subButtons: [{ name: 'm', kind: 'media_id', mediaId: 'M' }] },
      ]),
    ).toEqual([])
    expect(tried([{ name: 'A', type: 'click', key: 'K', sub_button: [] }])).toEqual([
      'buttons.0:validation.unrecognized_keys',
      'buttons.0.kind:validation.required',
      'buttons.0.key:validation.invalid',
    ])
  })
})

describe('wxoa reply rules', () => {
  const rule = {
    accountId: 1,
    name: 'R',
    triggerKind: 'keyword',
    matchMode: 'exact',
    keywords: ['hi'],
    replyKind: 'text',
    replyBody: { content: 'hello' },
  }

  it('trigger fields: keywords for keyword rules, a key for click, a scene for scan', () => {
    expect(issues(wxoaReplyRuleCreate, rule)).toEqual([])
    expect(issues(wxoaReplyRuleCreate, { ...rule, keywords: Array(21).fill('k') })).toEqual([
      'keywords:validation.too_big.array',
    ])
    expect(issues(wxoaReplyRuleCreate, { ...rule, keywords: ['x'.repeat(31)] })).toEqual([
      'keywords.0:validation.too_big.string',
    ])
    const click = { ...rule, triggerKind: 'click', matchMode: null, keywords: null }
    expect(issues(wxoaReplyRuleCreate, { ...click, eventKey: '菜单键' })).toEqual([])
    expect(issues(wxoaReplyRuleCreate, { ...click, eventKey: '键'.repeat(43) })).toEqual([
      'eventKey:validation.wxoa.bytes',
    ])
    expect(issues(wxoaReplyRuleCreate, click)).toEqual(['eventKey:validation.required'])
    const scan = { ...click, triggerKind: 'scan' }
    expect(issues(wxoaReplyRuleCreate, { ...scan, eventKey: 'Shop_01-a' })).toEqual([])
    expect(issues(wxoaReplyRuleCreate, { ...scan, eventKey: 'shop 1' })).toEqual([
      'eventKey:validation.invalid_format.other',
    ])
    expect(issues(wxoaReplyRuleCreate, { ...scan, eventKey: 'a'.repeat(65) })).toEqual([
      'eventKey:validation.invalid_format.other',
    ])
    expect(issues(wxoaReplyRuleCreate, { ...rule, triggerKind: 'subscribe' })).toEqual([
      'matchMode:validation.invalid',
      'keywords:validation.invalid',
    ])
  })

  it('reply text: XML-forbidden control characters and unpaired surrogates are refused', () => {
    const text = (content: string) =>
      issues(wxoaReplyRuleCreate, { ...rule, replyBody: { content } })
    expect(text('line\n\ttab\r 😀')).toEqual([])
    for (const bad of ['a\u0000', 'a\u0008', 'a\u000b', 'a\u000c', 'a\u001f', 'a￾', 'a￿'])
      expect(text(bad)).toEqual(['replyBody.content:validation.wxoa.xml_char'])
    expect(text('a\ud83d')).toEqual(['replyBody.content:validation.wxoa.xml_char'])
    expect(text('\ude00a')).toEqual(['replyBody.content:validation.wxoa.xml_char'])
    expect(wxoaXmlSafe('😀')).toBe(true)
    expect(wxoaXmlSafe('\ude00\ud83d')).toBe(false)
    expect(text('字'.repeat(682))).toEqual([])
    expect(text('字'.repeat(683))).toEqual(['replyBody.content:validation.wxoa.bytes'])
  })

  it('media replies reference a material; the body follows the reply kind', () => {
    const image = { ...rule, replyKind: 'image', replyBody: {} }
    expect(issues(wxoaReplyRuleCreate, image)).toEqual(['materialId:validation.required'])
    expect(issues(wxoaReplyRuleCreate, { ...image, materialId: 3 })).toEqual([])
    expect(issues(wxoaReplyRuleCreate, { ...rule, materialId: 3 })).toEqual([
      'materialId:validation.invalid',
    ])
    const news = {
      title: 'T',
      description: 'D',
      url: 'https://e.com',
      picUrl: 'https://e.com/p.jpg',
    }
    expect(issues(wxoaReplyRuleCreate, { ...rule, replyKind: 'news', replyBody: news })).toEqual([])
    expect(
      issues(wxoaReplyRuleCreate, {
        ...rule,
        replyKind: 'news',
        replyBody: { ...news, title: 'T\u0001' },
      }),
    ).toEqual(['replyBody.title:validation.wxoa.xml_char'])
    expect(
      issues(wxoaReplyRuleCreate, { ...rule, replyKind: 'news', replyBody: { title: 'T' } }),
    ).toEqual([
      'replyBody.description:validation.required',
      'replyBody.url:validation.required',
      'replyBody.picUrl:validation.required',
    ])
  })

  it('PUT: every field but accountId', () => {
    const { accountId: _, ...update } = rule
    expect(issues(wxoaReplyRuleUpdate, update)).toEqual([])
    expect(issues(wxoaReplyRuleUpdate, rule)).toEqual([':validation.unrecognized_keys'])
  })
})

describe('wxoa customer-service messages', () => {
  const send = { accountId: 1, fanId: 2, kind: 'image', body: {} }

  it('media from exactly one of materialId and objectId; video and music need a thumbnail', () => {
    expect(issues(wxoaMessageSend, { ...send, materialId: 3 })).toEqual([])
    expect(issues(wxoaMessageSend, { ...send, objectId: 4 })).toEqual([])
    expect(issues(wxoaMessageSend, send)).toEqual(['materialId:validation.required'])
    expect(issues(wxoaMessageSend, { ...send, materialId: 3, objectId: 4 })).toEqual([
      'objectId:validation.invalid',
    ])
    expect(issues(wxoaMessageSend, { ...send, kind: 'video', objectId: 4 })).toEqual([
      'thumbMaterialId:validation.required',
    ])
    expect(
      issues(wxoaMessageSend, { ...send, kind: 'text', body: { content: 'hi' }, objectId: 4 }),
    ).toEqual(['objectId:validation.invalid'])
    expect(issues(wxoaMessageSend, { ...send, kind: 'text', body: { content: ' ' } })).toEqual([
      'body.content:validation.required',
    ])
  })

  it('list query: accountId required', () => {
    expect(issues(wxoaMessageQuery, { accountId: '1' })).toEqual([])
    expect(issues(wxoaMessageQuery, {})).toEqual(['accountId:validation.required'])
    expect(issues(wxoaMessageQuery, { accountId: '' })).toEqual(['accountId:validation.required'])
    expect(issues(wxoaMessageQuery, { accountId: '0' })).toEqual([
      'accountId:validation.too_small.number_exclusive',
    ])
    expect(issues(wxoaMessageQuery, { accountId: 'x' })).toEqual([
      'accountId:validation.invalid_type',
    ])
  })
})

describe('wxoa templates, QR codes, fans and materials', () => {
  it('template values are limited by their key prefix', () => {
    expect(wxoaTemplateValueMax('thing1')).toBe(20)
    expect(wxoaTemplateValueMax('thing01')).toBe(20)
    expect(wxoaTemplateValueMax('character_string2')).toBe(32)
    expect(wxoaTemplateValueMax('phrase3')).toBe(5)
    expect(wxoaTemplateValueMax('phone_number4')).toBe(17)
    expect(wxoaTemplateValueMax('car_number5')).toBe(8)
    expect(wxoaTemplateValueMax('name1', 'Alice')).toBe(20)
    expect(wxoaTemplateValueMax('name1', '张三')).toBe(10)
    expect(wxoaTemplateValueMax('time3')).toBe(200)
    expect(wxoaTemplateValueMax('constructor')).toBe(200)
    const body = (data: Record<string, string>) =>
      issues(wxoaTemplateSendBody, { accountId: 1, fanIds: [1], data })
    expect(body({ thing1: '字'.repeat(20), phrase2: '配送中' })).toEqual([])
    expect(body({ thing1: '字'.repeat(21) })).toEqual(['data.thing1:validation.too_big.string'])
    expect(body({ thing1: '😀'.repeat(20) })).toEqual([])
    expect(body({ name2: '张'.repeat(11) })).toEqual(['data.name2:validation.too_big.string'])
    expect(body({ 'Thing.1': 'x' })).toHaveLength(1)
    const fans = (n: number) =>
      issues(wxoaTemplateSendBody, { accountId: 1, fanIds: Array(n).fill(1), data: {} })
    expect(fans(100)).toEqual([])
    expect(fans(101)).toEqual(['fanIds:validation.too_big.array'])
  })

  it('QR codes: string scenes, 60 s – 30 days for temporary ones, an optional tag', () => {
    const qr = { accountId: 1, label: 'Q', qrKind: 'permanent', scene: 'shop_1' }
    expect(issues(wxoaQrcodeCreate, { ...qr, tagId: 100 })).toEqual([])
    expect(issues(wxoaQrcodeCreate, { ...qr, scene: '店铺' })).toHaveLength(1)
    expect(issues(wxoaQrcodeCreate, { ...qr, scene: 'a'.repeat(64) })).toEqual([])
    expect(issues(wxoaQrcodeCreate, { ...qr, scene: 'a'.repeat(65) })).toHaveLength(1)
    expect(issues(wxoaQrcodeCreate, { ...qr, expireSeconds: 60 })).toEqual([
      'expireSeconds:validation.invalid',
    ])
    const temp = { ...qr, qrKind: 'temporary' }
    expect(issues(wxoaQrcodeCreate, temp)).toEqual(['expireSeconds:validation.required'])
    expect(issues(wxoaQrcodeCreate, { ...temp, expireSeconds: 60 })).toEqual([])
    expect(issues(wxoaQrcodeCreate, { ...temp, expireSeconds: 2_592_000 })).toEqual([])
    expect(issues(wxoaQrcodeCreate, { ...temp, expireSeconds: 59 })).toHaveLength(1)
    expect(issues(wxoaQrcodeCreate, { ...temp, expireSeconds: 2_592_001 })).toHaveLength(1)
    expect(issues(wxoaQrcodeUpdate, { label: 'Q', tagId: null })).toEqual([])
    expect(issues(wxoaQrcodeUpdate, { label: 'Q', accountId: 1 })).toEqual([
      ':validation.unrecognized_keys',
    ])
  })

  it('fan remark: an empty one clears it; PUT has no accountId', () => {
    expect(issues(wxoaFanRemarkBody, { remark: '' })).toEqual([])
    expect(issues(wxoaFanRemarkBody, { remark: 'r', accountId: 1 })).toEqual([
      ':validation.unrecognized_keys',
    ])
  })

  it('fan tagging: 1–200 fans, add or remove', () => {
    const tagging = { accountId: 1, fanIds: [1, 2], tagId: 100, op: 'add' }
    expect(issues(wxoaFanTaggingBody, tagging)).toEqual([])
    expect(issues(wxoaFanTaggingBody, { ...tagging, op: 'toggle' })).toHaveLength(1)
    expect(issues(wxoaFanTaggingBody, { ...tagging, fanIds: Array(201).fill(1) })).toHaveLength(1)
  })

  it('materials: a video needs a title and an introduction', () => {
    const m = { accountId: '1', mediaKind: 'video', title: 'T', intro: 'I' }
    expect(issues(wxoaMaterialCreate, m)).toEqual([])
    expect(issues(wxoaMaterialCreate, { ...m, intro: '' })).toEqual(['intro:validation.required'])
    expect(issues(wxoaMaterialCreate, { accountId: '1', mediaKind: 'image', title: '' })).toEqual(
      [],
    )
  })
})

describe('wxoaImageUrl', () => {
  it('upgrades mmbiz links to https and refuses every other host', () => {
    expect(wxoaImageUrl('http://mmbiz.qpic.cn/mmbiz_jpg/abc/0?wx_fmt=jpeg')).toBe(
      'https://mmbiz.qpic.cn/mmbiz_jpg/abc/0?wx_fmt=jpeg',
    )
    expect(wxoaImageUrl('https://mmbiz.qlogo.cn/x/0')).toBe('https://mmbiz.qlogo.cn/x/0')
    expect(wxoaImageUrl(' http://MMBIZ.QPIC.CN/a ')).toBe('https://mmbiz.qpic.cn/a')
    for (const bad of [
      'https://mmbiz.qpic.cn.evil.com/a',
      'https://evil.com/mmbiz.qpic.cn/a',
      'https://x.mmbiz.qpic.cn/a',
      'https://user@mmbiz.qpic.cn/a',
      'https://mmbiz.qpic.cn:8443/a',
      'http://mmbiz.qpic.cn:443/a',
      'ftp://mmbiz.qpic.cn/a',
      'javascript:alert(1)',
      '//mmbiz.qpic.cn/a',
      'not a url',
      '',
      null,
      undefined,
    ])
      expect(wxoaImageUrl(bad)).toBeNull()
  })
})
