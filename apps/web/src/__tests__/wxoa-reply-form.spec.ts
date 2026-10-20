// Auto-reply and material pages of an official account (see docs/design-notes.md#wxoa): the rule form
// sends only the fields of its trigger and reply type (an edit never names the account), refuses what
// WeChat would drop before sending, takes media from the account's materials of the matching kind; the
// material page lists one kind per tab, checks a file before uploading it, shows a local copy as a blob
// and a WeChat image only from the mmbiz hosts without a Referer, polls the sync and deletes.
import { defineComponent, h, KeepAlive, ref } from 'vue'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElInputTag, ElMessage, ElMessageBox, ElSelect } from 'element-plus'
import type {
  WxoaAccountOption,
  WxoaMaterialVo,
  WxoaQrcodeVo,
  WxoaReplyRuleVo,
  WxoaSyncVo,
} from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import { uploadMaxSize } from '@/core/composables/use-upload'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import MaterialPicker from '@/views/platform/wxoa/components/MaterialPicker.vue'
import { useWxoaAccount } from '@/views/platform/wxoa/components/use-wxoa-account'
import WxoaMediaImage from '@/views/platform/wxoa/components/WxoaMediaImage.vue'
import MaterialPage from '@/views/platform/wxoa/material/index.vue'
import MaterialUpload from '@/views/platform/wxoa/material/upload.vue'
import ReplyForm from '@/views/platform/wxoa/reply/form.vue'
import ReplyPage from '@/views/platform/wxoa/reply/index.vue'
import { me, mockApi, ok, type Route } from './mock-api'

const AT = '2026-10-06T01:00:00.000Z'
const OPTIONS: WxoaAccountOption[] = [
  { id: 2, label: 'Shop', accountKind: 'service', verified: true, enabled: true },
]
const rule = (p: Partial<WxoaReplyRuleVo> = {}): WxoaReplyRuleVo => ({
  id: 5,
  accountId: 2,
  name: 'Greeting',
  triggerKind: 'keyword',
  matchMode: 'contains',
  keywords: ['hi', 'hello'],
  eventKey: null,
  priority: 3,
  replyKind: 'text',
  replyBody: { content: 'Welcome' },
  materialId: null,
  enabled: true,
  createdAt: AT,
  updatedAt: AT,
  ...p,
})
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
const QR: WxoaQrcodeVo = {
  id: 4,
  accountId: 2,
  label: 'Spring poster',
  qrKind: 'permanent',
  scene: 'spring_2026',
  expiresAt: null,
  ticket: 't',
  qrUrl: 'https://weixin.qq.com/q/x',
  objectId: null,
  tagId: null,
  scanCount: 0,
  subscribeCount: 0,
  createdAt: AT,
}
const IDLE: WxoaSyncVo = {
  state: 'idle',
  done: 0,
  total: null,
  startedAt: null,
  finishedAt: null,
  code: null,
}

const entries = (...pairs: [string, string][]) =>
  ok({ version: 1, entries: pairs.map(([value, label]) => ({ value, label, labelI18n: null })) })
const BASE: Record<string, Route> = {
  'GET /settings/dicts/wxoa.account_kind/entries': entries(['service', 'Service account']),
  'GET /settings/dicts/core.enabled/entries': entries(['true', 'On'], ['false', 'Off']),
  'GET /settings/dicts/wxoa.reply_trigger/entries': entries(
    ['subscribe', 'Follow'],
    ['keyword', 'Keyword'],
    ['default', 'Default reply'],
    ['click', 'Menu click'],
    ['scan', 'QR code scan'],
  ),
  'GET /settings/dicts/wxoa.match_mode/entries': entries(
    ['exact', 'Exact'],
    ['contains', 'Contains'],
  ),
  'GET /settings/dicts/wxoa.reply_kind/entries': entries(
    ['text', 'Text'],
    ['image', 'Image'],
    ['voice', 'Voice'],
    ['video', 'Video'],
    ['music', 'Music'],
    ['news', 'Article'],
  ),
  'GET /settings/dicts/wxoa.media_kind/entries': entries(
    ['image', 'Image'],
    ['voice', 'Voice'],
    ['video', 'Video'],
    ['thumb', 'Thumbnail'],
  ),
  'GET /wxoa/accounts/options': ok(OPTIONS),
  'GET /wxoa/qrcodes': ok({ items: [QR], total: 1 }),
}
type Call = { method?: string; url?: string; params?: unknown; data?: unknown }
const sent = (calls: Call[], method: string, url: string) =>
  calls.filter((c) => c.method === method && c.url === url)
const last = (calls: Call[], method: string, url: string) => sent(calls, method, url).at(-1)
const body = (c: Call | undefined) => JSON.parse(String(c?.data)) as Record<string, unknown>

let w: VueWrapper
async function show(component: object, props: Record<string, unknown> = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  w = mount(component, {
    props,
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
}
const item = (label: string) =>
  w.findAll('.el-form-item').find((i) => i.find('.el-form-item__label').text() === label)
const field = (label: string) => item(label)!.find('input, textarea')
const radio = (text: string) => w.findAll('.el-radio').find((r) => r.text() === text)!
const button = (text: string) => w.findAll('button').find((b) => b.text() === text)
async function click(text: string) {
  await button(text)!.trigger('click')
  await flushPromises()
}
/** a button of the first table row */
async function rowButton(text: string) {
  await w
    .find('.el-table__body tr')
    .findAll('button')
    .find((b) => b.text() === text)!
    .trigger('click')
  await flushPromises()
}
async function choose(text: string) {
  await radio(text).find('input').setValue(true)
  await flushPromises()
}
const errors = () => w.findAll('.el-form-item__error').map((e) => e.text())
/** saves and waits for the request it sends (the form validates asynchronously) */
async function save(calls: Call[], method: string, url: string) {
  const before = sent(calls, method, url).length
  await click('Save')
  await vi.waitFor(() => expect(sent(calls, method, url)).toHaveLength(before + 1))
  return body(last(calls, method, url))
}
/** saves and waits for the problem shown; nothing is sent */
async function refused(calls: Call[], message: string) {
  await click('Save')
  await vi.waitFor(() => expect(errors()).toContain(message))
  expect(calls.filter((c) => c.method !== 'get')).toHaveLength(0)
}

// the server's upload limit is read once per page: unreadable here, the default applies
beforeAll(async () => {
  mockApi({})
  await uploadMaxSize()
})
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

describe('reply rule form', () => {
  it('a keyword rule: its match fields and the text reply only, under the account', async () => {
    const calls = mockApi({ ...BASE, 'POST /wxoa/reply-rules': ok(rule()) })
    await show(ReplyForm, { accountId: 2 })

    await field('Rule name').setValue('Greeting')
    w.findComponent(ElInputTag).vm.$emit('update:modelValue', ['hi', 'Hello'])
    await field('Text').setValue('Welcome!')
    expect(item('Text')!.text()).toContain('8/2048 bytes')

    expect(await save(calls, 'post', '/wxoa/reply-rules')).toEqual({
      accountId: 2,
      name: 'Greeting',
      triggerKind: 'keyword',
      matchMode: 'exact',
      keywords: ['hi', 'Hello'],
      eventKey: null,
      priority: 0,
      replyKind: 'text',
      replyBody: { content: 'Welcome!' },
      materialId: null,
      enabled: true,
    })
    expect(w.emitted('done')).toHaveLength(1)
  })

  it('a click rule: the menu key instead of keywords, its bytes checked before sending', async () => {
    const calls = mockApi({ ...BASE, 'POST /wxoa/reply-rules': ok(rule()) })
    await show(ReplyForm, { accountId: 2 })
    await field('Rule name').setValue('Menu A')
    await field('Text').setValue('Hi')
    // a priority set as a keyword rule is not kept by another trigger
    await item('Priority')!.find('input').setValue('50')
    await choose('Menu click')
    expect(item('Keywords')).toBeUndefined()
    expect(item('Match mode')).toBeUndefined()

    // 43 three-byte characters: 129 bytes
    await field('Menu key').setValue('菜'.repeat(43))
    expect(item('Menu key')!.text()).toContain('129/128 bytes')
    await refused(calls, 'Menu key or QR scene must be at most 128 bytes')

    await field('Menu key').setValue('菜单A')
    expect(await save(calls, 'post', '/wxoa/reply-rules')).toMatchObject({
      triggerKind: 'click',
      eventKey: '菜单A',
      matchMode: null,
      keywords: null,
      priority: 0,
    })
  })

  it("a scan rule: the scene from the account's QR codes or typed, in the scene format", async () => {
    const calls = mockApi({ ...BASE, 'POST /wxoa/reply-rules': ok(rule()) })
    await show(ReplyForm, { accountId: 2 })
    expect(sent(calls, 'get', '/wxoa/qrcodes')).toHaveLength(0)
    await field('Rule name').setValue('Poster')
    await field('Text').setValue('Hi')
    await choose('QR code scan')

    expect(last(calls, 'get', '/wxoa/qrcodes')!.params).toEqual({
      accountId: 2,
      pageSize: 200,
      sort: '-createdAt',
    })
    const options = [...document.querySelectorAll('.el-select-dropdown__item')].map(
      (o) => o.textContent,
    )
    expect(options).toContain('Spring poster (spring_2026)')

    const select = w.findComponent(ElSelect)
    select.vm.$emit('update:modelValue', 'not a scene!')
    await flushPromises()
    await refused(calls, 'Menu key or QR scene has an invalid format')

    select.vm.$emit('update:modelValue', 'spring_2026')
    await flushPromises()
    expect(await save(calls, 'post', '/wxoa/reply-rules')).toMatchObject({
      triggerKind: 'scan',
      eventKey: 'spring_2026',
    })
  })

  it('without the QR code and material views: the scene is typed, no material to choose', async () => {
    useAuthStore().me = me(['wxoa.reply.create'])
    const calls = mockApi({ ...BASE, 'POST /wxoa/reply-rules': ok(rule()) })
    await show(ReplyForm, { accountId: 2 })
    await choose('QR code scan')
    expect(item('QR code scene')).toBeDefined()
    await choose('Image')
    expect(button('Choose material')).toBeUndefined()
    expect(item('Image material')!.text()).toContain(
      'Choosing a material also needs the permission to view materials',
    )
    expect(sent(calls, 'get', '/wxoa/qrcodes')).toHaveLength(0)
  })

  it('media replies take a material of the kind; another media kind drops the one picked', async () => {
    const calls = mockApi({ ...BASE, 'POST /wxoa/reply-rules': ok(rule()) })
    await show(ReplyForm, { accountId: 2 })
    await field('Rule name').setValue('Poster')
    await choose('Follow')
    await choose('Image')
    expect(item('Text')).toBeUndefined()
    expect(item('Image material')!.text()).toContain('None chosen')

    await refused(calls, 'Material is required')

    await click('Choose material')
    expect(dialogs[0]!.props).toEqual({ accountId: 2, mediaKind: 'image' })
    dialogs[0]!.settle(material(9, { title: 'Poster', objectId: 31 }))
    await flushPromises()
    expect(item('Image material')!.text()).toContain('Poster')
    expect(await save(calls, 'post', '/wxoa/reply-rules')).toMatchObject({
      replyKind: 'image',
      replyBody: {},
      materialId: 9,
    })

    await choose('Voice')
    expect(item('Voice material')!.text()).toContain('None chosen')

    // music: the thumbnail is the material; the optional high-quality link stays out when blank
    await choose('Music')
    await click('Choose material')
    expect(dialogs[1]!.props).toEqual({ accountId: 2, mediaKind: 'thumb' })
    dialogs[1]!.settle(material(12, { mediaKind: 'thumb', fileName: 'cover.jpg' }))
    await flushPromises()
    await field('Title').setValue('Song')
    await field('Description').setValue('A song')
    await field('Music link').setValue('https://example.com/song.mp3')
    expect(await save(calls, 'post', '/wxoa/reply-rules')).toMatchObject({
      replyKind: 'music',
      replyBody: { title: 'Song', description: 'A song', musicUrl: 'https://example.com/song.mp3' },
      materialId: 12,
    })
  })

  it('what WeChat would drop never leaves: control characters, text over 2048 bytes', async () => {
    const calls = mockApi({ ...BASE, 'POST /wxoa/reply-rules': ok(rule()) })
    await show(ReplyForm, { accountId: 2 })
    await field('Rule name').setValue('Greeting')
    w.findComponent(ElInputTag).vm.$emit('update:modelValue', ['hi'])

    await field('Text').setValue('a\u0001b')
    await refused(
      calls,
      'Text contains control characters or broken characters that cannot be sent',
    )

    await field('Text').setValue('é'.repeat(1025))
    expect(item('Text')!.text()).toContain('2050/2048 bytes')
    await refused(calls, 'Text must be at most 2048 bytes')
  })

  it("editing: the rule's fields loaded, the PUT is the whole rule without the account", async () => {
    const stored = rule({
      triggerKind: 'click',
      matchMode: null,
      keywords: null,
      eventKey: 'MENU_A',
      priority: 0,
      replyKind: 'news',
      replyBody: {
        title: 'Spring',
        description: 'New season',
        url: 'https://example.com/a',
        picUrl: 'https://example.com/p.png',
      },
    })
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/reply-rules/5': ok(stored),
      'PUT /wxoa/reply-rules/5': ok(null),
    })
    await show(ReplyForm, { id: 5, accountId: 2 })

    expect((field('Menu key').element as HTMLInputElement).value).toBe('MENU_A')
    expect((field('Title').element as HTMLInputElement).value).toBe('Spring')
    await field('Title').setValue('Summer')
    expect(await save(calls, 'put', '/wxoa/reply-rules/5')).toEqual({
      name: 'Greeting',
      triggerKind: 'click',
      matchMode: null,
      keywords: null,
      eventKey: 'MENU_A',
      priority: 0,
      replyKind: 'news',
      replyBody: { ...stored.replyBody, title: 'Summer' },
      materialId: null,
      enabled: true,
    })
  })

  it('editing a media rule keeps its material, known by id', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/reply-rules/5': ok(rule({ replyKind: 'image', replyBody: {}, materialId: 9 })),
      'PUT /wxoa/reply-rules/5': ok(null),
    })
    await show(ReplyForm, { id: 5, accountId: 2 })
    expect(item('Image material')!.text()).toContain('Material #9')
    const put = await save(calls, 'put', '/wxoa/reply-rules/5')
    expect(put).toMatchObject({ replyKind: 'image', replyBody: {}, materialId: 9 })
    expect(put).not.toHaveProperty('accountId')
  })
})

describe('reply rule page', () => {
  it("lists the chosen account's rules; add, edit and delete name the rule and its account", async () => {
    const calls = mockApi({
      ...BASE,
      'GET /iam/profile/prefs/table.wxoa.reply': ok({ value: null }),
      'GET /wxoa/reply-rules': ok({ items: [rule()], total: 1 }),
      'DELETE /wxoa/reply-rules/5': ok(null),
    })
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    await show(ReplyPage)

    expect(last(calls, 'get', '/wxoa/reply-rules')!.params).toMatchObject({
      accountId: 2,
      sort: '-priority',
    })
    const row = w.find('.el-table__body tr')
    expect(row.text()).toContain('Greeting')
    expect(row.text()).toContain('hello')

    await click('Add')
    expect(dialogs[0]!.props).toEqual({ id: undefined, accountId: 2 })
    await rowButton('Edit')
    expect(dialogs[1]!.props).toEqual({ id: 5, accountId: 2 })
    await rowButton('Delete')
    expect(sent(calls, 'delete', '/wxoa/reply-rules/5')).toHaveLength(1)
  })
})

describe('material picker', () => {
  it("lists the account's materials of one kind; a pick is the result", async () => {
    const thumb = material(12, { mediaKind: 'thumb', title: 'Cover' })
    const calls = mockApi({ ...BASE, 'GET /wxoa/materials': ok({ items: [thumb], total: 1 }) })
    await show(MaterialPicker, { accountId: 2, mediaKind: 'thumb' })
    expect(last(calls, 'get', '/wxoa/materials')!.params).toMatchObject({
      accountId: 2,
      mediaKind: 'thumb',
    })
    await click('Cover')
    expect(w.emitted('done')).toEqual([[thumb]])
  })
})

describe('material image', () => {
  it('the local copy as a blob first, even when a WeChat link is known', async () => {
    const calls = mockApi({ 'GET /storage/objects/31/download': [200, new Blob(['png'])] })
    await show(WxoaMediaImage, { objectId: 31, url: 'https://mmbiz.qpic.cn/a/0', alt: 'Poster' })
    expect(calls[0]).toMatchObject({ responseType: 'blob' })
    expect(w.find('img').attributes('src')).toBe('blob:url-1')
    w.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:url-1')
  })

  it('a WeChat link only on the mmbiz hosts, as https and without a Referer', async () => {
    const calls = mockApi({})
    await show(WxoaMediaImage, { url: 'http://mmbiz.qpic.cn/a/0?wx_fmt=png', alt: 'Pulled' })
    const img = w.find('img')
    expect(img.attributes('src')).toBe('https://mmbiz.qpic.cn/a/0?wx_fmt=png')
    expect(img.attributes('referrerpolicy')).toBe('no-referrer')
    w.unmount()

    await show(WxoaMediaImage, { url: 'https://images.example.com/a.png', alt: 'Elsewhere' })
    expect(w.find('img').exists()).toBe(false)
    expect(w.find('[role=img]').attributes('aria-label')).toBe('Elsewhere')
    expect(calls).toHaveLength(0)
  })

  it('a local copy that cannot be read shows the placeholder, never the WeChat link', async () => {
    const calls = mockApi({})
    await show(WxoaMediaImage, { objectId: 31, url: 'https://mmbiz.qpic.cn/a/0', alt: 'Poster' })
    expect(sent(calls, 'get', '/storage/objects/31/download')).toHaveLength(1)
    expect(w.find('img').exists()).toBe(false)
    expect(w.find('[role=img]').attributes('aria-label')).toBe('Poster')
  })

  it('with preview, a local copy opens large', async () => {
    mockApi({ 'GET /storage/objects/31/download': [200, new Blob(['png'])] })
    await show(WxoaMediaImage, { objectId: 31, alt: 'Poster', preview: true })
    await w.find('button').trigger('click')
    await flushPromises()
    expect(document.querySelector('.el-image-viewer__wrapper')).not.toBeNull()
  })
})

describe('material page', () => {
  const ROUTES: Record<string, Route> = {
    ...BASE,
    'GET /iam/profile/prefs/table.wxoa.material': ok({ value: null }),
    'GET /wxoa/materials/sync': ok(IDLE),
    'GET /storage/objects/31/download': [200, new Blob(['png'])],
    'GET /wxoa/materials': (c) =>
      (c.params as { mediaKind: string }).mediaKind === 'image'
        ? ok({
            items: [
              material(1, { objectId: 31, title: 'Local' }),
              material(2, { origin: 'pulled', wxUrl: 'http://mmbiz.qpic.cn/b/0', fileName: null }),
              material(3, { origin: 'pulled', wxUrl: 'https://cdn.example.com/c.png' }),
            ],
            total: 3,
          })
        : ok({ items: [material(4, { mediaKind: 'voice', fileName: 'hi.mp3' })], total: 1 }),
  }

  it('one kind per tab: local copies as blobs, WeChat images from the mmbiz hosts only', async () => {
    const calls = mockApi(ROUTES)
    await show(MaterialPage)
    expect(last(calls, 'get', '/wxoa/materials')!.params).toMatchObject({
      accountId: 2,
      mediaKind: 'image',
    })
    const imgs = w.findAll('.el-table__body img').map((i) => i.attributes('src'))
    expect(imgs).toEqual(['blob:url-1', 'https://mmbiz.qpic.cn/b/0'])
    for (const img of w.findAll('.el-table__body img'))
      expect(img.attributes('referrerpolicy') ?? 'no-referrer').toBe('no-referrer')

    await w
      .findAll('.el-tabs__item')
      .find((t) => t.text() === 'Voice')!
      .trigger('click')
    await flushPromises()
    expect(last(calls, 'get', '/wxoa/materials')!.params).toMatchObject({ mediaKind: 'voice' })
    expect(w.find('.el-table__body').text()).toContain('hi.mp3')

    await click('Upload material')
    expect(dialogs[0]!.props).toEqual({ accountId: 2, mediaKind: 'voice' })
  })

  it('deleting asks first, then deletes on the server and reloads', async () => {
    const calls = mockApi({ ...ROUTES, 'DELETE /wxoa/materials/1': ok(null) })
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    await show(MaterialPage)
    const loads = sent(calls, 'get', '/wxoa/materials').length
    await rowButton('Delete')
    expect(confirm.mock.calls[0]![0]).toContain('Local')
    expect(sent(calls, 'delete', '/wxoa/materials/1')).toHaveLength(1)
    expect(sent(calls, 'get', '/wxoa/materials').length).toBe(loads + 1)
  })

  it('the sync is started, polled while it runs, and the list reloads once it ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let state: WxoaSyncVo = IDLE
    const calls = mockApi({
      ...ROUTES,
      'GET /wxoa/materials/sync': () => ok(state),
      'POST /wxoa/materials/sync': ok(null),
    })
    await show(MaterialPage)
    const loads = sent(calls, 'get', '/wxoa/materials').length

    state = { ...IDLE, state: 'running', done: 3, total: 10 }
    await click('Sync materials')
    expect(body(last(calls, 'post', '/wxoa/materials/sync'))).toEqual({ accountId: 2 })
    expect(w.text()).toContain('Syncing materials: 3 of 10 done')

    state = { ...state, state: 'done', done: 10, finishedAt: AT }
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()
    expect(w.text()).toContain('Last sync finished at')
    expect(sent(calls, 'get', '/wxoa/materials').length).toBe(loads + 1)
  })

  it('a page parked by keep-alive stops polling, even when the account changes meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const calls = mockApi({
      ...ROUTES,
      'GET /wxoa/accounts/options': ok([...OPTIONS, { ...OPTIONS[0]!, id: 3, label: 'Club' }]),
      'GET /wxoa/materials/sync': ok({ ...IDLE, state: 'running', done: 1, total: 10 }),
    })
    const on = ref(true)
    const Host = defineComponent({
      setup: () => () => h(KeepAlive, null, [on.value ? h(MaterialPage) : h('p', 'other')]),
    })
    await show(Host)
    const polls = () => sent(calls, 'get', '/wxoa/materials/sync').length
    await vi.advanceTimersByTimeAsync(2000)
    const shown = polls()
    expect(shown).toBe(2)

    on.value = false
    await flushPromises()
    await vi.advanceTimersByTimeAsync(6000)
    expect(polls()).toBe(shown)

    // parked: another account's state is read once, not polled
    useWxoaAccount().accountId.value = 3
    await flushPromises()
    expect(polls()).toBe(shown + 1)
    await vi.advanceTimersByTimeAsync(6000)
    expect(polls()).toBe(shown + 1)
  })
})

describe('material upload', () => {
  const file = (name: string, size = 100) => {
    const f = new File(['x'], name)
    Object.defineProperty(f, 'size', { value: size })
    return f
  }
  async function pick(f: File) {
    const input = w.find('input[type=file]')
    Object.defineProperty(input.element, 'files', { value: [f], configurable: true })
    await input.trigger('change')
    await flushPromises()
  }

  it("WeChat's type and size for the kind are checked before anything is sent", async () => {
    const calls = mockApi(BASE)
    await show(MaterialUpload, { accountId: 2, mediaKind: 'thumb' })
    expect(w.find('input[type=file]').attributes('accept')).toBe('.jpg')

    await pick(file('cover.png'))
    expect(ElMessage.error).toHaveBeenLastCalledWith(
      '“cover.png” cannot be uploaded as Thumbnail: only jpg',
    )
    await pick(file('cover.jpg', 64 * 1024 + 1))
    expect(ElMessage.error).toHaveBeenLastCalledWith('"cover.jpg" is larger than 64 kB')
    await click('Upload')
    await vi.waitFor(() => expect(errors()).toContain('Choose the file to upload'))
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)
  })

  it('a video goes with its title and intro, the fields before the file', async () => {
    const saved = material(7, { mediaKind: 'video' })
    const calls = mockApi({ ...BASE, 'POST /wxoa/materials': ok(saved) })
    await show(MaterialUpload, { accountId: 2, mediaKind: 'image' })
    await choose('Video')
    await pick(file('clip.mp4', 5 * 1024 * 1024))
    await click('Upload')
    await vi.waitFor(() => expect(errors()).toContain('Title is required'))
    expect(sent(calls, 'post', '/wxoa/materials')).toHaveLength(0)

    await field('Title').setValue('Launch')
    await field('Introduction').setValue('The launch event')
    await click('Upload')
    await vi.waitFor(() => expect(sent(calls, 'post', '/wxoa/materials')).toHaveLength(1))
    const form = last(calls, 'post', '/wxoa/materials')!.data as FormData
    expect([...form.keys()]).toEqual(['accountId', 'mediaKind', 'title', 'intro', 'file'])
    expect(form.get('accountId')).toBe('2')
    expect(form.get('mediaKind')).toBe('video')
    expect(form.get('title')).toBe('Launch')
    expect((form.get('file') as File).name).toBe('clip.mp4')
    expect(w.emitted('done')).toEqual([[saved]])
  })

  it('another kind drops a chosen file it does not take; an image goes without title or intro', async () => {
    const calls = mockApi({ ...BASE, 'POST /wxoa/materials': ok(material(8)) })
    await show(MaterialUpload, { accountId: 2, mediaKind: 'voice' })
    await pick(file('hello.mp3'))
    expect(w.text()).toContain('hello.mp3')
    await choose('Image')
    expect(w.text()).not.toContain('hello.mp3')

    await pick(file('a.PNG'))
    await click('Upload')
    await vi.waitFor(() => expect(sent(calls, 'post', '/wxoa/materials')).toHaveLength(1))
    const form = last(calls, 'post', '/wxoa/materials')!.data as FormData
    expect([...form.keys()]).toEqual(['accountId', 'mediaKind', 'file'])
  })
})
