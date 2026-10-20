// Demo site sample of the WeChat Official Account pages (see docs/design-notes.md#wxoa): with
// APP_DEMO_MODE and APP_WXOA both on, one made-up service account with fans (tagged, blocked,
// unsubscribed), tags, a published default menu, reply rules, a permanent channel QR code and a short
// message history, so the pages have something to show. Created once and found by its AppID: an
// account an administrator deleted stays deleted, a live one only gets its sample messages back (the
// retention purge deletes them; each has a fixed dedup key). Its secrets are random SecretBox boxes
// that never leave the database: in demo mode the gateway sends nothing. The content is the account's
// own (made-up text, like what WeChat sends), not i18n keys. Runs after seedWxoa.
import { createHash, randomBytes } from 'node:crypto'
import type { WxoaButton } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import type { AppConfigService } from '../../../core/config/config.module.js'
import { demoMode } from '../../../core/config/demo-mode.js'
import { wxoaOn } from '../../../core/config/wxoa-switch.js'
import { tenantId } from '../../../core/context/tenant.js'
import { SecretBox } from '../../../core/crypto/secret-box.js'
import { wxoaMenuDigest } from '../../../modules/platform/wxoa/menu/menu.service.js'
import { findRow, insertRow, type Row } from '../upsert.js'

/** The sample account's AppID (made up). */
export const WXOA_DEMO_APP_ID = 'wx000000000000de30'

const MINUTE = 60_000
const HOUR = 60
const DAY = 24 * HOUR
const SCENE = 'store_entrance'
const TICKET = 'gQDemo-store-entrance-ticket'
const CLICK_KEY = 'LATEST_EVENTS'

/** upstream tag id → name */
const TAGS: [tagId: number, name: string][] = [
  [100, '老客户'],
  [101, '活动报名'],
  [102, '扫码到店'],
]
const QR_TAG = 102

const REPLY = {
  subscribe: '感谢关注栖梧示例服务号！回复“营业时间”查看门店营业时间，回复“活动”了解本月活动。',
  hours: '门店营业时间：每天 9:00–21:00，节假日照常营业。',
  events: '本月活动：周末到店消费满 100 元赠送饮品一杯，详情请咨询店员。',
  click: '最新活动：周六下午新品试饮，欢迎带朋友一起来。',
  scan: '欢迎光临门店！扫码后可在店内领取一张优惠券。',
  fallback: '消息已收到，店员会尽快回复您。',
}

const RULES: Row[] = [
  { name: '关注欢迎语', trigger_kind: 'subscribe', content: REPLY.subscribe },
  {
    name: '营业时间',
    trigger_kind: 'keyword',
    match_mode: 'exact',
    keywords: ['营业时间'],
    priority: 10,
    content: REPLY.hours,
  },
  {
    name: '活动咨询',
    trigger_kind: 'keyword',
    match_mode: 'contains',
    keywords: ['活动', '优惠'],
    priority: 5,
    content: REPLY.events,
  },
  { name: '菜单：最新活动', trigger_kind: 'click', event_key: CLICK_KEY, content: REPLY.click },
  { name: '门店海报扫码', trigger_kind: 'scan', event_key: SCENE, content: REPLY.scan },
  { name: '默认回复', trigger_kind: 'default', content: REPLY.fallback },
]

const MENU: WxoaButton[] = [
  { name: '最新活动', kind: 'click', key: CLICK_KEY },
  {
    name: '门店服务',
    subButtons: [
      { name: '门店位置', kind: 'location_select', key: 'STORE_LOCATION' },
      { name: '扫码核销', kind: 'scancode_waitmsg', key: 'STORE_SCAN' },
    ],
  },
  {
    name: '关于我们',
    subButtons: [
      { name: '品牌故事', kind: 'view', url: 'https://example.com/story' },
      { name: '加入我们', kind: 'view', url: 'https://example.com/jobs' },
    ],
  },
]

interface Fan {
  remark?: string
  tags?: number[]
  blocked?: boolean
  /** minutes ago */
  subscribed: number
  unsubscribed?: number
  scene: string
  qrScene?: string
  inbound?: number
  event?: number
}

/** fan n is FANS[n - 1] */
const FANS: Fan[] = [
  {
    remark: '王先生',
    tags: [100, 102],
    subscribed: 3 * DAY,
    scene: 'ADD_SCENE_QR_CODE',
    qrScene: SCENE,
    inbound: 32,
    event: 3 * DAY,
  },
  {
    remark: '李女士',
    tags: [101],
    subscribed: 10 * DAY,
    scene: 'ADD_SCENE_SEARCH',
    inbound: 2 * HOUR,
    event: 125,
  },
  { subscribed: 20 * DAY, scene: 'ADD_SCENE_PROFILE_CARD', inbound: DAY },
  { subscribed: 40 * DAY, unsubscribed: 5 * DAY, scene: 'ADD_SCENE_SEARCH', event: 40 * DAY },
  { remark: '广告账号', blocked: true, subscribed: 60 * DAY, scene: 'ADD_SCENE_OTHERS' },
  { tags: [100, 102], subscribed: 90 * DAY, scene: 'ADD_SCENE_SEARCH', event: 4 * HOUR },
  {
    remark: '赵经理',
    tags: [100, 101],
    subscribed: 120 * DAY,
    scene: 'ADD_SCENE_ACCOUNT_MIGRATION',
  },
  { blocked: true, subscribed: 150 * DAY, unsubscribed: 30 * DAY, scene: 'ADD_SCENE_OTHERS' },
]

/** `oQwDemo` + 21 digits: 28 characters like a real openid */
const openId = (fan: number) => `oQwDemo${String(fan).padStart(21, '0')}`

interface Sample {
  fan: number
  /** minutes ago */
  ago: number
  row: Row
}

const text = (fan: number, ago: number, content: string): Sample => ({
  fan,
  ago,
  row: { direction: 'in', channel: 'push', msg_kind: 'text', payload: { Content: content } },
})
const event = (fan: number, ago: number, kind: string, key: string | null = null): Sample => ({
  fan,
  ago,
  row: {
    direction: 'in',
    channel: 'push',
    msg_kind: 'event',
    event_kind: kind,
    event_key: key,
    payload: key && (kind === 'SCAN' || kind === 'subscribe') ? { Ticket: TICKET } : {},
  },
})
const reply = (fan: number, ago: number, content: string, channel = 'passive'): Sample => ({
  fan,
  ago,
  row: {
    direction: 'out',
    channel,
    msg_kind: 'text',
    payload: { content },
    send_state: 'sent',
    errcode: channel === 'cs' ? 0 : null,
  },
})

/** Append only: a message's place in the list is its dedup key (`sha256('demo|<n>')`, n from 1). */
const MESSAGES: Sample[] = [
  event(1, 3 * DAY, 'subscribe', `qrscene_${SCENE}`),
  reply(1, 3 * DAY, REPLY.scan),
  text(1, 45, '营业时间'),
  reply(1, 45, REPLY.hours),
  text(1, 32, '周末有什么活动吗？'),
  reply(1, 32, REPLY.events),
  reply(1, 30, '王先生您好，本周六下午有新品试饮，欢迎到店。', 'cs'),
  event(2, 10 * DAY, 'subscribe'),
  reply(2, 10 * DAY, REPLY.subscribe),
  event(2, 125, 'CLICK', CLICK_KEY),
  reply(2, 125, REPLY.click),
  text(2, 2 * HOUR, '可以开发票吗？'),
  reply(2, 2 * HOUR, REPLY.fallback),
  reply(2, 118, '可以的，消费后在收银台提供抬头即可开具电子发票。', 'cs'),
  text(3, DAY, '你好'),
  reply(3, DAY, REPLY.fallback),
  event(4, 40 * DAY, 'subscribe'),
  reply(4, 40 * DAY, REPLY.subscribe),
  event(4, 5 * DAY, 'unsubscribe'),
  event(6, 4 * HOUR, 'SCAN', SCENE),
  reply(6, 4 * HOUR, REPLY.scan),
  event(7, 10 * HOUR, 'VIEW', 'https://example.com/story'),
]

const dedupKey = (n: number) => createHash('sha256').update(`demo|${n}`).digest('hex')
const hex = (length: number) =>
  randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length)

/** SecretBox under the seed process's APP_SECRET (the one the server opens it with). */
function secretBox(): SecretBox {
  const secret = process.env.APP_SECRET
  if (!secret)
    throw new Error('seedWxoaDemo: APP_SECRET is not set (the sample secrets are SecretBox boxes)')
  return new SecretBox({ get: () => secret } as unknown as AppConfigService)
}

export async function seedWxoaDemo(q: EntityManager): Promise<string[]> {
  // 公众号模块关闭（APP_WXOA）时不建演示样例
  if (!demoMode() || !wxoaOn()) return []
  const found = await findRow(q, 'wxoa_account', { app_id: WXOA_DEMO_APP_ID })
  if (found?.deleted) return []
  const accountId = found?.id ?? (await createSample(q, Date.now()))
  await addMessages(q, accountId, Date.now())
  return []
}

/** The account with its fans, tags, menu, rules and QR code; returns the account id. */
async function createSample(q: EntityManager, now: number): Promise<number> {
  const at = (ago: number | undefined) => (ago === undefined ? null : new Date(now - ago * MINUTE))
  const box = secretBox()
  const accountId = await insertRow(q, 'wxoa_account', {
    label: '栖梧示例服务号',
    app_id: WXOA_DEMO_APP_ID,
    account_kind: 'service',
    verified: 1,
    crypto_mode: 'plain',
    // AppSecret: 32 hex, Token: 32 alphanumerics, EncodingAESKey: 43 alphanumerics
    app_secret_enc: box.encrypt(hex(32)),
    push_token_enc: box.encrypt(hex(32)),
    aes_key_enc: box.encrypt(hex(43)),
    callback_key: randomBytes(16).toString('base64url'),
    last_push_at: at(32),
    note: '演示站样例账号：数据均为虚构，演示模式下不连接微信。',
  })
  for (const [tagId, name] of TAGS)
    await insertRow(q, 'wxoa_tag', {
      account_id: accountId,
      tag_id: tagId,
      name,
      fan_count: FANS.filter((f) => f.tags?.includes(tagId)).length,
    })
  for (const [i, f] of FANS.entries())
    await insertRow(q, 'wxoa_fan', {
      account_id: accountId,
      open_id: openId(i + 1),
      subscribed: f.unsubscribed === undefined ? 1 : 0,
      subscribed_at: at(f.subscribed),
      unsubscribed_at: at(f.unsubscribed),
      subscribe_scene: f.scene,
      qr_scene: f.qrScene ?? null,
      remark: f.remark ?? null,
      lang: 'zh_CN',
      tag_ids: f.tags ?? [],
      blocked: f.blocked ? 1 : 0,
      last_inbound_at: at(f.inbound),
      last_event_at: at(f.event),
      synced_at: at(DAY),
    })
  const menu = {
    menuKind: 'default',
    buttons: MENU,
    matchTagId: null,
    matchPlatform: null,
  } as const
  await insertRow(q, 'wxoa_menu', {
    account_id: accountId,
    menu_kind: 'default',
    label: '默认菜单',
    buttons: MENU,
    published_at: at(2 * DAY),
    published_digest: wxoaMenuDigest(menu),
  })
  for (const { content, ...rule } of RULES)
    await insertRow(q, 'wxoa_reply_rule', {
      account_id: accountId,
      ...rule,
      reply_kind: 'text',
      reply_body: { content },
    })
  await insertRow(q, 'wxoa_qrcode', {
    account_id: accountId,
    label: '门店入口海报',
    qr_kind: 'permanent',
    scene: SCENE,
    ticket: TICKET,
    qr_url: `http://weixin.qq.com/q/${TICKET}`,
    tag_id: QR_TAG,
    // the sample messages: one scan-subscribe, one scan
    scan_count: MESSAGES.filter((m) => m.row.event_kind === 'SCAN').length,
    subscribe_count: MESSAGES.filter((m) => String(m.row.event_key).startsWith('qrscene_')).length,
  })
  return accountId
}

/** The sample messages the account lacks (by dedup key), dated back from now. */
async function addMessages(q: EntityManager, accountId: number, now: number): Promise<void> {
  const keys = MESSAGES.map((_, i) => dedupKey(i + 1))
  const have = new Set(
    (
      await q.query(
        'SELECT dedup_key AS k FROM wxoa_message WHERE tenant_id = ? AND account_id = ? AND dedup_key IN (?) AND deleted_at IS NULL',
        [tenantId(), accountId, keys],
      )
    ).map((r: { k: string }) => r.k),
  )
  for (const [i, m] of MESSAGES.entries()) {
    if (have.has(keys[i]!)) continue
    const inboundText = m.row.direction === 'in' && m.row.msg_kind === 'text'
    await insertRow(q, 'wxoa_message', {
      account_id: accountId,
      open_id: openId(m.fan),
      ...m.row,
      // a 64-bit MsgId, a string
      wx_msg_id: inboundText ? `24000000000000${String(i + 1).padStart(5, '0')}` : null,
      dedup_key: keys[i],
      occurred_at: new Date(now - m.ago * MINUTE),
    })
  }
}
