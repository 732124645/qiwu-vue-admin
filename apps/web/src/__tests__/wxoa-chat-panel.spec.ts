// Conversation and message log pages of an official account (see docs/design-notes.md#wxoa): recent
// conversations of the chosen account, one fan's messages as plain text (images from the local copy or an
// mmbiz link only, amr voice downloaded with its recognized text), the two send windows, sending by type
// (media from a material or a forwarded inbound copy, never an upload) once while pending, a reload 1.5 s
// after the first push of the account, the reading permission the page needs, and the message log table.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, KeepAlive, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import type {
  WxoaAccountOption,
  WxoaFanVo,
  WxoaMaterialVo,
  WxoaMessageVo,
  WxoaSendWindowVo,
} from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import ChatPage from '@/views/platform/wxoa/chat/index.vue'
import { useWxoaAccount } from '@/views/platform/wxoa/components/use-wxoa-account'
import MessagePage from '@/views/platform/wxoa/message/index.vue'
import { me, mockApi, ok, type Route } from './mock-api'

/** the fake socket: subscriptions kept by type so a test can push, dropped with the page */
const pushes = vi.hoisted(() => new Map<string, (payload: unknown) => void>())
vi.mock('@/core/realtime/socket', async () => {
  const { getCurrentScope, onScopeDispose } = await import('vue')
  return {
    onRealtime: (type: string, fn: (payload: unknown) => void) => {
      pushes.set(type, fn)
      const off = () => void pushes.delete(type)
      if (getCurrentScope()) onScopeDispose(off)
      return off
    },
  }
})

const AT = '2026-10-06T01:00:00.000Z'
const OPTIONS: WxoaAccountOption[] = [
  { id: 2, label: 'Shop', accountKind: 'service', verified: true, enabled: true },
  { id: 3, label: 'News', accountKind: 'subscription', verified: false, enabled: true },
]
const fan = (id: number, p: Partial<WxoaFanVo> = {}): WxoaFanVo => ({
  id,
  accountId: 2,
  openId: `o-fan-${id}`,
  unionId: null,
  subscribed: true,
  subscribedAt: AT,
  unsubscribedAt: null,
  subscribeScene: null,
  qrScene: null,
  remark: null,
  lang: null,
  tagIds: [],
  blocked: false,
  lastInboundAt: AT,
  lastEventAt: null,
  syncedAt: null,
  createdAt: AT,
  ...p,
})
const FANS = [fan(7, { remark: 'Alice' }), fan(8, { subscribed: false, blocked: true })]
const msg = (id: number, p: Partial<WxoaMessageVo> = {}): WxoaMessageVo => ({
  id,
  accountId: 2,
  openId: 'o-fan-7',
  direction: 'in',
  channel: 'push',
  msgKind: 'text',
  eventKind: null,
  eventKey: null,
  payload: {},
  objectId: null,
  wxMsgId: null,
  sendState: null,
  errcode: null,
  operatorId: null,
  occurredAt: AT,
  ...p,
})
// as the server answers: newest first
const MESSAGES = [
  msg(14, {
    direction: 'out',
    channel: 'cs',
    payload: { content: 'Hello back' },
    sendState: 'sent',
  }),
  msg(13, {
    msgKind: 'voice',
    objectId: 41,
    payload: { MediaId: 'm', Format: 'amr', Recognition: 'see you at noon' },
  }),
  msg(12, { msgKind: 'image', objectId: 31, payload: { PicUrl: 'http://mmbiz.qpic.cn/x/0' } }),
  msg(11, { msgKind: 'event', eventKind: 'CLICK', eventKey: 'MENU_A' }),
  msg(10, { payload: { Content: '<b>bold</b> <img src=x onerror=alert(1)>' } }),
]
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()
const WINDOW: WxoaSendWindowVo = {
  inbound: { until: inHours(1), used: 2, max: 5 },
  event: { until: null, used: 0, max: 3 },
}
const material = (id: number, p: Partial<WxoaMaterialVo> = {}): WxoaMaterialVo => ({
  id,
  accountId: 2,
  mediaKind: 'image',
  mediaId: `media-${id}`,
  title: null,
  intro: null,
  fileName: `pic-${id}.png`,
  byteSize: 2048,
  wxUrl: null,
  objectId: null,
  origin: 'local',
  createdAt: AT,
  ...p,
})

const entries = (...pairs: [string, string][]) =>
  ok({ version: 1, entries: pairs.map(([value, label]) => ({ value, label, labelI18n: null })) })
const BASE: Record<string, Route> = {
  'GET /settings/dicts/wxoa.account_kind/entries': entries(['service', 'Service account']),
  'GET /settings/dicts/wxoa.channel/entries': entries(['push', 'Push'], ['cs', 'Customer service']),
  'GET /settings/dicts/wxoa.send_state/entries': entries(['sent', 'Sent']),
  'GET /settings/dicts/wxoa.msg_kind/entries': entries(
    ['text', 'Text'],
    ['image', 'Picture'],
    ['voice', 'Voice note'],
    ['event', 'Event'],
  ),
  'GET /settings/dicts/wxoa.reply_kind/entries': entries(
    ['text', 'Text'],
    ['image', 'Image'],
    ['voice', 'Voice'],
    ['video', 'Video'],
    ['music', 'Music'],
    ['news', 'Article'],
  ),
  'GET /wxoa/accounts/options': ok(OPTIONS),
  'GET /wxoa/conversations': ok({ items: FANS, total: 2 }),
  'GET /wxoa/conversations/7/messages': ok(MESSAGES),
  'GET /wxoa/conversations/7/window': ok(WINDOW),
  'GET /wxoa/conversations/8/messages': ok([]),
  'GET /wxoa/conversations/8/window': ok(WINDOW),
  'GET /storage/objects/31/download': [200, new Blob(['png'])],
  'GET /storage/objects/41/download': [200, new Blob(['amr'])],
}
type Call = { method?: string; url?: string; params?: unknown; data?: unknown }
const sent = (calls: Call[], method: string, url: string) =>
  calls.filter((c) => c.method === method && c.url === url)
const last = (calls: Call[], method: string, url: string) => sent(calls, method, url).at(-1)
const body = (c: Call | undefined) => JSON.parse(String(c?.data)) as Record<string, unknown>

let w: VueWrapper
async function show(component: object) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  w = mount(component, {
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
}
const button = (text: string) => w.findAll('button').find((b) => b.text() === text)
async function click(text: string) {
  await button(text)!.trigger('click')
  await flushPromises()
}
async function openFan(name: string) {
  await w
    .findAll('.wxoa-chat__fan')
    .find((b) => b.text().includes(name))!
    .trigger('click')
  await flushPromises()
}
const item = (label: string) =>
  w.findAll('.el-form-item').find((i) => i.find('.el-form-item__label').text() === label)
async function choose(text: string) {
  await w
    .findAll('.el-radio')
    .find((r) => r.text() === text)!
    .find('input')
    .setValue(true)
  await flushPromises()
}
const errors = () => w.findAll('.el-form-item__error').map((e) => e.text())
const stream = () => w.find('.wxoa-chat__stream')
/** a message of MESSAGES (ids 10–14, shown oldest first) */
const bubble = (id: number) => w.findAll('.wxoa-chat__item')[id - 10]!
/** what a reload of the open conversation with fan 7 requests */
const reloads = (calls: Call[]) => [
  sent(calls, 'get', '/wxoa/conversations').length,
  sent(calls, 'get', '/wxoa/conversations/7/messages').length,
  sent(calls, 'get', '/wxoa/conversations/7/window').length,
]
/** a full page of fan 7's messages, newest first */
const FULL_PAGE = Array.from({ length: 50 }, (_, i) => msg(200 - i))
const OLDER = msg(150, { payload: { Content: 'older one' } })

let objectUrls = 0
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  localStorage.clear()
  useAuthStore().me = me(['*'])
  useWxoaAccount().options.value = []
  objectUrls = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:url-${++objectUrls}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  w?.unmount()
  dialogs.splice(0)
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('conversations', () => {
  it("lists the chosen account's conversations; a fan's messages oldest first with its windows", async () => {
    const calls = mockApi(BASE)
    await show(ChatPage)
    expect(last(calls, 'get', '/wxoa/conversations')!.params).toEqual({
      accountId: 2,
      page: 1,
      pageSize: 50,
      sort: '-lastInboundAt',
    })
    const list = w.find('.wxoa-chat__fans').text()
    expect(list).toContain('Alice')
    expect(list).toContain('o-fan-8')
    expect(list).toContain('Unfollowed')
    expect(list).toContain('Blocked')
    expect(w.text()).toContain('Choose a conversation on the left')

    await openFan('Alice')
    expect(last(calls, 'get', '/wxoa/conversations/7/messages')!.params).toEqual({ limit: 50 })
    expect(sent(calls, 'get', '/wxoa/conversations/7/window')).toHaveLength(1)
    const items = w.findAll('.wxoa-chat__item')
    expect(items.map((i) => i.classes().find((c) => c.startsWith('is-')))).toEqual([
      'is-in',
      'is-in',
      'is-in',
      'is-in',
      'is-out',
    ])
    expect(items[0]!.text()).toContain('<b>bold</b>')
    expect(items[1]!.text()).toContain('Menu click')
    expect(items[1]!.text()).toContain('MENU_A')
    expect(items[4]!.text()).toContain('Hello back')
    expect(items[4]!.text()).toContain('Sent')

    const windows = w.find('.wxoa-chat__windows').text()
    expect(windows).toMatch(/48-hour message window\s*Until .+, 2\/5 used/)
    expect(windows).toContain('1-minute event window')
    expect(windows).toContain('Not opened')
    expect(w.text()).not.toContain('Both send windows are closed')
  })

  it('the content stays text: markup a fan sent never becomes elements', async () => {
    mockApi(BASE)
    await show(ChatPage)
    await openFan('Alice')
    const html = stream().html()
    expect(stream().find('b').exists()).toBe(false)
    expect(stream().findAll('img[src="x"]')).toHaveLength(0)
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;')
  })

  it('images: the local copy, else only an mmbiz link as https without a Referer; others a placeholder', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/conversations/7/messages': ok([
        msg(22, { msgKind: 'image', payload: { PicUrl: 'https://images.example.com/a.png' } }),
        msg(21, { msgKind: 'image', payload: { PicUrl: 'http://mmbiz.qpic.cn/a/0?wx_fmt=png' } }),
        msg(20, {
          msgKind: 'image',
          objectId: 31,
          payload: { PicUrl: 'http://mmbiz.qpic.cn/b/0' },
        }),
      ]),
    })
    await show(ChatPage)
    await openFan('Alice')
    const [copy, remote, foreign] = w.findAll('.wxoa-chat__item')
    expect(sent(calls, 'get', '/storage/objects/31/download')).toHaveLength(1)
    expect(copy!.find('img').attributes('src')).toBe('blob:url-1')
    const img = remote!.find('img')
    expect(img.attributes('src')).toBe('https://mmbiz.qpic.cn/a/0?wx_fmt=png')
    expect(img.attributes('referrerpolicy')).toBe('no-referrer')
    expect(foreign!.find('img').exists()).toBe(false)
    expect(foreign!.find('[role=img]').exists()).toBe(true)
  })

  it('voice: the amr copy is downloaded, the recognized text is shown', async () => {
    const calls = mockApi(BASE)
    const saved: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download)
    })
    await show(ChatPage)
    await openFan('Alice')
    const voice = bubble(13)
    expect(voice.text()).toContain('Voice note')
    expect(voice.text()).toContain('Recognized speech: see you at noon')
    expect(voice.find('audio').exists()).toBe(false)

    await voice
      .findAll('button')
      .find((b) => b.text() === 'Download voice')!
      .trigger('click')
    await flushPromises()
    expect(last(calls, 'get', '/storage/objects/41/download')).toMatchObject({
      responseType: 'blob',
    })
    expect(saved).toEqual(['voice-13.amr'])
  })

  it('earlier messages load before the oldest shown', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/conversations/7/messages': (c) => ok(c.params.beforeId ? [OLDER] : FULL_PAGE),
    })
    await show(ChatPage)
    await openFan('Alice')
    await click('Earlier messages')
    expect(last(calls, 'get', '/wxoa/conversations/7/messages')!.params).toEqual({
      beforeId: 151,
      limit: 50,
    })
    expect(w.findAll('.wxoa-chat__item')[0]!.text()).toContain('older one')
    expect(button('Earlier messages')).toBeUndefined()
  })

  it('both windows closed: a warning', async () => {
    mockApi({
      ...BASE,
      'GET /wxoa/conversations/7/window': ok({
        inbound: { until: inHours(-1), used: 5, max: 5 },
        event: { until: null, used: 0, max: 3 },
      }),
    })
    await show(ChatPage)
    await openFan('Alice')
    expect(w.find('.wxoa-chat__windows').text()).toMatch(/Closed at .+ \(5\/5 used\)/)
    expect(w.text()).toContain('Both send windows are closed')
  })

  it('another account: its conversations, nothing of the previous one open', async () => {
    const calls = mockApi(BASE)
    await show(ChatPage)
    await openFan('Alice')
    useWxoaAccount().accountId.value = 3
    await flushPromises()
    expect(last(calls, 'get', '/wxoa/conversations')!.params).toMatchObject({ accountId: 3 })
    expect(w.findAll('.wxoa-chat__item')).toHaveLength(0)
    expect(w.text()).toContain('Choose a conversation on the left')
  })

  it('a late answer for the previous account never lists its fans under the next one', async () => {
    let release = () => {}
    mockApi({
      ...BASE,
      'GET /wxoa/conversations': (c) =>
        c.params.accountId === 2
          ? new Promise((r) => (release = () => r(ok({ items: FANS, total: 2 }))))
          : ok({ items: [fan(9, { accountId: 3, remark: 'Carol' })], total: 1 }),
    })
    await show(ChatPage)
    useWxoaAccount().accountId.value = 3
    await flushPromises()
    release()
    await flushPromises()
    const list = w.find('.wxoa-chat__fans').text()
    expect(list).toContain('Carol')
    expect(list).not.toContain('Alice')
    expect(list).not.toContain('o-fan-8')
  })

  it('a late answer for the previous fan never shows its messages under the next one', async () => {
    let release = () => {}
    mockApi({
      ...BASE,
      'GET /wxoa/conversations/7/messages': () =>
        new Promise((r) => (release = () => r(ok(MESSAGES)))),
    })
    await show(ChatPage)
    await openFan('Alice')
    await openFan('o-fan-8')
    release()
    await flushPromises()
    expect(w.findAll('.wxoa-chat__item')).toHaveLength(0)
    expect(w.find('.wxoa-chat__head').text()).toContain('o-fan-8')
  })

  it('a reload merges into what is shown by then: earlier messages loaded meanwhile stay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let latest = 0
    let release = () => {}
    const newest = [msg(201, { payload: { Content: 'newest one' } }), ...FULL_PAGE.slice(0, 49)]
    mockApi({
      ...BASE,
      'GET /wxoa/conversations/7/messages': (c) =>
        c.params.beforeId
          ? ok([OLDER])
          : ++latest === 1
            ? ok(FULL_PAGE)
            : new Promise((r) => (release = () => r(ok(newest)))),
    })
    await show(ChatPage)
    await openFan('Alice')
    pushes.get('wxoa:message')!({ accountId: 2, messageId: 201 })
    await vi.advanceTimersByTimeAsync(1500)
    await click('Earlier messages')
    expect(w.findAll('.wxoa-chat__item')[0]!.text()).toContain('older one')

    release()
    await flushPromises()
    const items = w.findAll('.wxoa-chat__item')
    expect(items).toHaveLength(52)
    expect(items[0]!.text()).toContain('older one')
    expect(items.at(-1)!.text()).toContain('newest one')
  })

  it('a reload ending while earlier messages load keeps them from loading twice', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let release = () => {}
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/conversations/7/messages': (c) =>
        c.params.beforeId ? new Promise((r) => (release = () => r(ok([OLDER])))) : ok(FULL_PAGE),
    })
    await show(ChatPage)
    await openFan('Alice')
    const earlier = () =>
      sent(calls, 'get', '/wxoa/conversations/7/messages').filter(
        (c) => (c.params as { beforeId?: number }).beforeId,
      )
    await click('Earlier messages')
    pushes.get('wxoa:message')!({ accountId: 2, messageId: 201 })
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    await click('Earlier messages')
    expect(earlier()).toHaveLength(1)

    release()
    await flushPromises()
    expect(w.findAll('.wxoa-chat__item')[0]!.text()).toContain('older one')
  })
})

describe('sending', () => {
  it('text: checked by the shared schema, sent once while pending, then the stream and windows reload', async () => {
    let answer: () => void = () => {}
    const calls = mockApi({
      ...BASE,
      'POST /wxoa/messages': () =>
        new Promise((resolve) => (answer = () => resolve(ok(msg(15, { direction: 'out' }))))),
    })
    await show(ChatPage)
    await openFan('Alice')

    await click('Send')
    await vi.waitFor(() => expect(errors()).toContain('Text is required'))
    expect(sent(calls, 'post', '/wxoa/messages')).toHaveLength(0)

    await item('Text')!.find('textarea').setValue('你好')
    expect(item('Text')!.text()).toContain('6/2048 bytes')
    const loads = sent(calls, 'get', '/wxoa/conversations/7/messages').length
    await click('Send')
    await vi.waitFor(() => expect(sent(calls, 'post', '/wxoa/messages')).toHaveLength(1))
    expect(button('Send')!.classes()).toContain('is-loading')
    await click('Send')
    expect(sent(calls, 'post', '/wxoa/messages')).toHaveLength(1)
    expect(body(last(calls, 'post', '/wxoa/messages'))).toEqual({
      accountId: 2,
      fanId: 7,
      kind: 'text',
      body: { content: '你好' },
      materialId: null,
      objectId: null,
      thumbMaterialId: null,
    })

    answer()
    await flushPromises()
    expect(sent(calls, 'get', '/wxoa/conversations/7/messages')).toHaveLength(loads + 1)
    expect(sent(calls, 'get', '/wxoa/conversations/7/window')).toHaveLength(2)
    expect((item('Text')!.find('textarea').element as HTMLTextAreaElement).value).toBe('')
    expect(button('Send')!.classes()).not.toContain('is-loading')
  })

  it('a refused send keeps the message for another try', async () => {
    const calls = mockApi({
      ...BASE,
      'POST /wxoa/messages': [422, { code: 'B6007', msg: 'closed', data: null, traceId: 't' }],
    })
    await show(ChatPage)
    await openFan('Alice')
    await item('Text')!.find('textarea').setValue('again')
    await click('Send')
    await vi.waitFor(() => expect(sent(calls, 'post', '/wxoa/messages')).toHaveLength(1))
    await flushPromises()
    expect((item('Text')!.find('textarea').element as HTMLTextAreaElement).value).toBe('again')
    expect(button('Send')!.classes()).not.toContain('is-loading')
  })

  it('media: a material of the kind, or an inbound copy forwarded; nothing is uploaded', async () => {
    const calls = mockApi({ ...BASE, 'POST /wxoa/messages': ok(msg(15)) })
    await show(ChatPage)
    await openFan('Alice')
    expect(w.find('input[type=file]').exists()).toBe(false)

    await choose('Image')
    expect(item('Text')).toBeUndefined()
    await click('Send')
    await vi.waitFor(() => expect(errors()).toContain('Material is required'))

    await click('Choose material')
    expect(dialogs[0]!.props).toEqual({ accountId: 2, mediaKind: 'image' })
    dialogs[0]!.settle(material(9, { title: 'Poster' }))
    await flushPromises()
    expect(item('Image')!.text()).toContain('Poster')
    await click('Send')
    await vi.waitFor(() => expect(sent(calls, 'post', '/wxoa/messages')).toHaveLength(1))
    expect(body(last(calls, 'post', '/wxoa/messages'))).toMatchObject({
      kind: 'image',
      body: {},
      materialId: 9,
      objectId: null,
    })
    await flushPromises()

    // the inbound voice copy, to the other fan
    await bubble(13)
      .findAll('button')
      .find((b) => b.text() === 'Forward')!
      .trigger('click')
    await flushPromises()
    await openFan('o-fan-8')
    expect(item('Voice')!.text()).toContain('Media file #41 of a conversation')
    await click('Send')
    await vi.waitFor(() => expect(sent(calls, 'post', '/wxoa/messages')).toHaveLength(2))
    expect(body(last(calls, 'post', '/wxoa/messages'))).toEqual({
      accountId: 2,
      fanId: 8,
      kind: 'voice',
      body: {},
      materialId: null,
      objectId: 41,
      thumbMaterialId: null,
    })
  })

  it('video needs its thumbnail material too', async () => {
    const calls = mockApi({ ...BASE, 'POST /wxoa/messages': ok(msg(15)) })
    await show(ChatPage)
    await openFan('Alice')
    await choose('Video')
    await click('Choose material')
    expect(dialogs[0]!.props).toEqual({ accountId: 2, mediaKind: 'video' })
    dialogs[0]!.settle(material(5, { mediaKind: 'video', title: 'Clip' }))
    await flushPromises()
    await click('Send')
    await vi.waitFor(() => expect(errors()).toContain('Thumbnail material is required'))
    expect(sent(calls, 'post', '/wxoa/messages')).toHaveLength(0)

    await item('Thumbnail')!
      .findAll('button')
      .find((b) => b.text() === 'Choose material')!
      .trigger('click')
    expect(dialogs[1]!.props).toEqual({ accountId: 2, mediaKind: 'thumb' })
    dialogs[1]!.settle(material(6, { mediaKind: 'thumb' }))
    await flushPromises()
    await click('Send')
    await vi.waitFor(() => expect(sent(calls, 'post', '/wxoa/messages')).toHaveLength(1))
    expect(body(last(calls, 'post', '/wxoa/messages'))).toMatchObject({
      kind: 'video',
      materialId: 5,
      thumbMaterialId: 6,
    })
  })
})

describe('realtime', () => {
  it("a push of the account reloads what is shown once, 1.5 s after the first; another account's none", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const calls = mockApi(BASE)
    await show(ChatPage)
    await openFan('Alice')
    const counts = () => reloads(calls)
    const before = counts()
    const push = pushes.get('wxoa:message')!

    push({ accountId: 3, messageId: 99 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(counts()).toEqual(before)

    push({ accountId: 2, messageId: 15 })
    await vi.advanceTimersByTimeAsync(1000)
    push({ accountId: 2, messageId: 16 })
    await vi.advanceTimersByTimeAsync(499)
    expect(counts()).toEqual(before)
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(counts()).toEqual(before.map((n) => n + 1))

    await vi.advanceTimersByTimeAsync(5000)
    expect(counts()).toEqual(before.map((n) => n + 1))
  })

  it('kept alive: nothing reloads while hidden, once when shown again after a push', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const calls = mockApi(BASE)
    const visible = ref(true)
    await show(
      defineComponent({
        setup: () => () => h(KeepAlive, null, [visible.value ? h(ChatPage) : h('p', 'other')]),
      }),
    )
    await openFan('Alice')
    const before = reloads(calls)
    const toggle = async (v: boolean) => {
      visible.value = v
      await flushPromises()
    }

    await toggle(false)
    await toggle(true)
    expect(reloads(calls)).toEqual(before)

    await toggle(false)
    pushes.get('wxoa:message')!({ accountId: 2, messageId: 15 })
    pushes.get('wxoa:message')!({ accountId: 2, messageId: 16 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(reloads(calls)).toEqual(before)

    await toggle(true)
    expect(reloads(calls)).toEqual(before.map((n) => n + 1))
    await vi.advanceTimersByTimeAsync(5000)
    expect(reloads(calls)).toEqual(before.map((n) => n + 1))
  })
})

describe('permissions', () => {
  it('without the message log view: a hint, nothing loaded', async () => {
    useAuthStore().me = me(['wxoa.message.send'])
    const calls = mockApi(BASE)
    await show(ChatPage)
    expect(w.text()).toContain('also needs the view permission of the message log')
    expect(calls).toHaveLength(0)
    pushes.get('wxoa:message')?.({ accountId: 2, messageId: 1 })
    await flushPromises()
    expect(calls).toHaveLength(0)
  })

  it('without sending: no composer and no forwarding', async () => {
    useAuthStore().me = me(['wxoa.message.browse'])
    mockApi(BASE)
    await show(ChatPage)
    await openFan('Alice')
    expect(w.findAll('.wxoa-chat__item')).toHaveLength(5)
    expect(button('Send')).toBeUndefined()
    expect(button('Forward')).toBeUndefined()
  })

  it('without the material view: no material to choose, forwarding still works', async () => {
    useAuthStore().me = me(['wxoa.message.browse', 'wxoa.message.send'])
    mockApi(BASE)
    await show(ChatPage)
    await openFan('Alice')
    await choose('Image')
    expect(button('Choose material')).toBeUndefined()
    expect(item('Image')!.text()).toContain('also needs the permission to view materials')
    expect(button('Forward')).toBeDefined()
  })
})

describe('message log', () => {
  it("lists the account's messages with the filters; content as text, per-user columns", async () => {
    const calls = mockApi({
      ...BASE,
      'GET /iam/profile/prefs/table.wxoa.message': ok({ value: null }),
      'GET /wxoa/messages': ok({ items: MESSAGES, total: 5 }),
    })
    await show(MessagePage)
    expect(last(calls, 'get', '/wxoa/messages')!.params).toEqual({
      page: 1,
      pageSize: 20,
      sort: '-occurredAt',
      accountId: 2,
    })
    expect(sent(calls, 'get', '/iam/profile/prefs/table.wxoa.message')).toHaveLength(1)
    const table = w.find('.el-table__body')
    expect(table.text()).toContain('<b>bold</b>')
    expect(table.find('b').exists()).toBe(false)
    expect(table.text()).toContain('Received')
    expect(table.text()).toContain('Customer service')

    await w.find('input[name="openId"]').setValue('o-fan-7')
    await click('Search')
    expect(last(calls, 'get', '/wxoa/messages')!.params).toEqual({
      page: 1,
      pageSize: 20,
      sort: '-occurredAt',
      openId: 'o-fan-7',
      accountId: 2,
    })

    useWxoaAccount().accountId.value = 3
    await flushPromises()
    expect(last(calls, 'get', '/wxoa/messages')!.params).toMatchObject({ accountId: 3 })
  })
})
