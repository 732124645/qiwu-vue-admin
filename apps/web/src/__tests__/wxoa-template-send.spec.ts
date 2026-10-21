// Template message and channel QR code pages of an official account (see docs/design-notes.md#wxoa):
// the templates of the chosen account (refreshed from WeChat on demand, deleted after a confirmation),
// the send dialog (one field per data key of the template, each within the length WeChat takes, at most
// 100 followed fans, once while pending), the send records (the message log's template rows); QR codes
// with their image copy, auto tag and counts, the create / edit form, the image download, deleting with
// the permanent-code warning, the daily stats chart, and actions following the permissions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElInputNumber, ElMessage, ElMessageBox, ElSelect } from 'element-plus'
import type {
  WxoaAccountOption,
  WxoaFanVo,
  WxoaQrcodeVo,
  WxoaTagVo,
  WxoaTemplateVo,
} from '@qiwu/shared'
import QwChart from '@/core/components/QwChart.vue'
import { dialogs } from '@/core/dialog'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { appSettings } from '@/core/stores/app'
import { useAuthStore } from '@/core/stores/auth'
import { useWxoaAccount } from '@/views/platform/wxoa/components/use-wxoa-account'
import QrcodeForm from '@/views/platform/wxoa/qrcode/form.vue'
import QrcodePage from '@/views/platform/wxoa/qrcode/index.vue'
import QrcodeStats from '@/views/platform/wxoa/qrcode/stats.vue'
import TemplatePage from '@/views/platform/wxoa/template/index.vue'
import TemplateSend from '@/views/platform/wxoa/template/send.vue'
import { wxoaTemplateFields } from '@/views/platform/wxoa/template/template-fields'
import { me, mockApi, ok, type Route } from './mock-api'

const AT = '2026-10-06T01:00:00.000Z'
const OPTIONS: WxoaAccountOption[] = [
  { id: 2, label: 'Shop', accountKind: 'service', verified: true, enabled: true },
  { id: 3, label: 'News', accountKind: 'subscription', verified: false, enabled: true },
]
const TPL: WxoaTemplateVo = {
  templateId: 'TPL-ship_1',
  title: 'Order shipped',
  primaryIndustry: 'IT',
  deputyIndustry: 'Internet',
  content:
    '{{first.DATA}}\nProduct：{{thing1.DATA}}\nBuyer: {{name2.DATA}}\nShipped at {{time3.DATA}}\n{{remark.DATA}}',
  example: 'Product: Tea',
}
const OTHER_TPL: WxoaTemplateVo = { ...TPL, templateId: 'TPL-news', title: 'Newsletter' }
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
  lastInboundAt: null,
  lastEventAt: null,
  syncedAt: null,
  createdAt: AT,
  ...p,
})
const FANS = [fan(7, { remark: 'Alice' }), fan(8)]
const TAGS: WxoaTagVo[] = [
  { id: 11, accountId: 2, tagId: 100, name: 'VIP', fanCount: 1 },
  { id: 12, accountId: 2, tagId: 101, name: 'Poster', fanCount: 0 },
]
const qr = (id: number, p: Partial<WxoaQrcodeVo> = {}): WxoaQrcodeVo => ({
  id,
  accountId: 2,
  label: `Code ${id}`,
  qrKind: 'permanent',
  scene: `scene_${id}`,
  expiresAt: null,
  ticket: `ticket-${id}`,
  qrUrl: `http://weixin.qq.com/q/${id}`,
  objectId: null,
  tagId: null,
  scanCount: 0,
  subscribeCount: 0,
  createdAt: AT,
  ...p,
})
const CODES = [
  qr(5, { label: 'Spring poster', objectId: 31, tagId: 100, scanCount: 12, subscribeCount: 3 }),
  qr(6, { qrKind: 'temporary', expiresAt: '2020-01-01T00:00:00.000Z', tagId: 999 }),
]

const entries = (...pairs: [string, string][]) =>
  ok({ version: 1, entries: pairs.map(([value, label]) => ({ value, label, labelI18n: null })) })
const BASE: Record<string, Route> = {
  'GET /settings/dicts/wxoa.account_kind/entries': entries(['service', 'Service account']),
  'GET /settings/dicts/wxoa.qr_kind/entries': entries(
    ['temporary', 'Temporary'],
    ['permanent', 'Permanent'],
  ),
  'GET /settings/dicts/wxoa.send_state/entries': entries(['pending', 'Pending'], ['sent', 'Sent']),
  'GET /settings/dicts/wxoa.msg_kind/entries': entries(['template', 'Template message']),
  'GET /iam/profile/prefs/table.wxoa.template': ok({ value: null }),
  'GET /iam/profile/prefs/table.wxoa.template-send': ok({ value: null }),
  'GET /iam/profile/prefs/table.wxoa.qrcode': ok({ value: null }),
  'GET /wxoa/accounts/options': ok(OPTIONS),
  'GET /wxoa/templates': (c) => ok(c.params.accountId === 2 ? [TPL] : [OTHER_TPL]),
  'GET /wxoa/fans': ok({ items: FANS, total: 2 }),
  'GET /wxoa/tags': ok(TAGS),
  'GET /wxoa/qrcodes': ok({ items: CODES, total: 2 }),
  'GET /storage/objects/31/download': [200, new Blob(['png'], { type: 'image/png' })],
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
    global: {
      plugins: [ElementPlus, i18n, router],
      directives: { perm: vPerm },
      stubs: { QwChart: true },
    },
    attachTo: document.body,
  })
  await flushPromises()
}
const button = (text: string) => w.findAll('button').find((b) => b.text() === text)
async function click(text: string) {
  await button(text)!.trigger('click')
  await flushPromises()
}
/** a button in the rows of the table (el-table also renders the slot once outside the body) */
const rowButtons = (text: string) =>
  w
    .find('.el-table__body')
    .findAll('button')
    .filter((b) => b.text() === text)
const item = (label: string) =>
  w.findAll('.el-form-item').find((i) => i.find('.el-form-item__label').text() === label)
const errors = () => w.findAll('.el-form-item__error').map((e) => e.text())
const confirm = () => vi.spyOn(ElMessageBox, 'confirm')

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  // every row button inline: these cases look for them in the row, not in the "More" menu
  appSettings.value.tableActionsVisible = 9
  accessToken.value = 'at'
  localStorage.clear()
  useAuthStore().me = me(['*'])
  // the account list is shared by the wxoa pages: each test loads it anew
  useWxoaAccount().options.value = []
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

describe('template fields', () => {
  it('one field per data key in order, labelled by the text before it on its line', () => {
    expect(wxoaTemplateFields(TPL.content)).toEqual([
      { key: 'first', label: 'first' },
      { key: 'thing1', label: 'Product' },
      { key: 'name2', label: 'Buyer' },
      { key: 'time3', label: 'Shipped at' },
      { key: 'remark', label: 'remark' },
    ])
    expect(
      wxoaTemplateFields('From {{a1.DATA}} to {{ b2.DATA }}\nAgain {{a1.DATA}}\nNone here'),
    ).toEqual([
      { key: 'a1', label: 'From' },
      { key: 'b2', label: 'to' },
    ])
    expect(wxoaTemplateFields('plain text, {{not a key}}')).toEqual([])
  })
})

describe('templates', () => {
  it("lists the chosen account's templates; refresh asks WeChat again; another account starts empty", async () => {
    let release = () => {}
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/templates': (c) =>
        c.params.accountId === 3
          ? new Promise((r) => (release = () => r(ok([OTHER_TPL]))))
          : ok([TPL]),
    })
    await show(TemplatePage)
    expect(last(calls, 'get', '/wxoa/templates')!.params).toEqual({ accountId: 2 })
    const table = w.find('.el-table__body').text()
    expect(table).toContain('Order shipped')
    expect(table).toContain('IT / Internet')
    expect(table).toContain('Product：{{thing1.DATA}}')

    await click('Refresh from WeChat')
    expect(last(calls, 'get', '/wxoa/templates')!.params).toEqual({ accountId: 2, refresh: true })

    useWxoaAccount().accountId.value = 3
    await flushPromises()
    expect(last(calls, 'get', '/wxoa/templates')!.params).toEqual({ accountId: 3 })
    // nothing of the previous account while the next one loads
    expect(w.find('.el-table__body').text()).not.toContain('Order shipped')
    release()
    await flushPromises()
    expect(w.find('.el-table__body').text()).toContain('Newsletter')
  })

  it('delete: after a confirmation, on WeChat for the account the list came from; then reloads', async () => {
    const calls = mockApi({ ...BASE, 'DELETE /wxoa/templates/TPL-ship_1': ok(null) })
    await show(TemplatePage)
    const ask = confirm()
      .mockRejectedValueOnce('cancel')
      .mockResolvedValueOnce('confirm' as never)
    await rowButtons('Delete')[0]!.trigger('click')
    await flushPromises()
    expect(String(ask.mock.calls[0]![0])).toContain('deleted on WeChat too')
    expect(sent(calls, 'delete', '/wxoa/templates/TPL-ship_1')).toHaveLength(0)

    const loads = sent(calls, 'get', '/wxoa/templates').length
    await rowButtons('Delete')[0]!.trigger('click')
    await flushPromises()
    expect(last(calls, 'delete', '/wxoa/templates/TPL-ship_1')!.params).toEqual({ accountId: 2 })
    expect(sent(calls, 'get', '/wxoa/templates')).toHaveLength(loads + 1)
  })

  it('send opens the dialog for the template and its account; the records reload once queued', async () => {
    const calls = mockApi({ ...BASE, 'GET /wxoa/messages': ok({ items: [], total: 0 }) })
    await show(TemplatePage)
    // the records tab loads only once shown
    expect(sent(calls, 'get', '/wxoa/messages')).toHaveLength(0)
    await w
      .findAll('.el-tabs__item')
      .find((tab) => tab.text() === 'Send records')!
      .trigger('click')
    await flushPromises()
    expect(last(calls, 'get', '/wxoa/messages')!.params).toEqual({
      page: 1,
      pageSize: 20,
      sort: '-occurredAt',
      accountId: 2,
      channel: 'template',
    })

    await rowButtons('Send')[0]!.trigger('click')
    await flushPromises()
    expect(dialogs[0]!.props).toEqual({ accountId: 2, template: TPL })
    dialogs[0]!.settle(2)
    await flushPromises()
    expect(sent(calls, 'get', '/wxoa/messages')).toHaveLength(2)
    expect(ElMessage.success).toHaveBeenCalledWith(expect.stringContaining('2 messages queued'))
  })

  it('without send, delete or the message log: no such buttons and no records tab', async () => {
    useAuthStore().me = me(['wxoa.template.browse'])
    const calls = mockApi(BASE)
    await show(TemplatePage)
    expect(w.find('.el-table__body').text()).toContain('Order shipped')
    for (const action of ['Send', 'Delete'])
      expect(rowButtons(action).every((b) => !b.isVisible())).toBe(true)
    expect(w.findAll('.el-tabs__item').map((tab) => tab.text())).toEqual(['Templates'])
    expect(sent(calls, 'get', '/wxoa/messages')).toHaveLength(0)
  })
})

describe('send dialog', () => {
  it('fields from the template, each within its length; fans searched among the followed ones', async () => {
    const calls = mockApi({ ...BASE, 'POST /wxoa/templates/TPL-ship_1/send': ok([]) })
    await show(TemplateSend, { accountId: 2, template: TPL })
    for (const label of ['first', 'Product', 'Buyer', 'Shipped at', 'remark'])
      expect(item(label)).toBeDefined()
    expect(item('Product')!.text()).toContain('0/20')
    expect(last(calls, 'get', '/wxoa/fans')!.params).toEqual({
      accountId: 2,
      subscribed: true,
      pageSize: 50,
      sort: '-lastInboundAt',
    })
    const select = w.findComponent(ElSelect)
    expect(select.props('multipleLimit')).toBe(100)

    // a remark, or an OpenID once the text looks like one
    const search = select.props('remoteMethod') as (q: string) => void
    search('Ali')
    await flushPromises()
    expect(last(calls, 'get', '/wxoa/fans')!.params).toMatchObject({ remark: 'Ali' })
    search('oAbCdEfGhIjKlMnOpQrStUvWxYz0')
    await flushPromises()
    expect(last(calls, 'get', '/wxoa/fans')!.params).toMatchObject({
      openId: 'oAbCdEfGhIjKlMnOpQrStUvWxYz0',
    })

    // no fan and a value over its limit: nothing leaves
    await item('Product')!.find('input').setValue('x'.repeat(21))
    // a name with a Chinese character holds 10
    await item('Buyer')!.find('input').setValue('张'.repeat(11))
    expect(item('Buyer')!.text()).toContain('11/10')
    await click('Send')
    expect(sent(calls, 'post', '/wxoa/templates/TPL-ship_1/send')).toHaveLength(0)
    await vi.waitFor(() =>
      expect(errors()).toEqual(
        expect.arrayContaining([
          'Recipient fans must have at least 1 items',
          'Product must be at most 20 characters',
          'Buyer must be at most 10 characters',
        ]),
      ),
    )
  })

  it('sends the values and the chosen fans once while pending', async () => {
    let release = () => {}
    const calls = mockApi({
      ...BASE,
      'POST /wxoa/templates/TPL-ship_1/send': () =>
        new Promise((r) => (release = () => r(ok([{ id: 1 }, { id: 2 }])))),
    })
    await show(TemplateSend, { accountId: 2, template: TPL })
    w.findComponent(ElSelect).vm.$emit('update:modelValue', [7, 8])
    await flushPromises()
    await item('Product')!.find('input').setValue('Tea')
    await item('Buyer')!.find('input').setValue('张三')
    await item('Link')!.find('input').setValue('https://shop.example.com/o/1')

    await click('Send')
    await click('Send')
    release()
    await flushPromises()
    expect(sent(calls, 'post', '/wxoa/templates/TPL-ship_1/send')).toHaveLength(1)
    expect(body(last(calls, 'post', '/wxoa/templates/TPL-ship_1/send'))).toEqual({
      accountId: 2,
      fanIds: [7, 8],
      data: { first: '', thing1: 'Tea', name2: '张三', time3: '', remark: '' },
      url: 'https://shop.example.com/o/1',
    })
    expect(w.emitted('done')).toEqual([[2]])
  })

  it('a link that is not http(s) is refused', async () => {
    const calls = mockApi({ ...BASE, 'POST /wxoa/templates/TPL-ship_1/send': ok([]) })
    await show(TemplateSend, { accountId: 2, template: TPL })
    w.findComponent(ElSelect).vm.$emit('update:modelValue', [7])
    await item('Link')!.find('input').setValue('javascript:alert(1)')
    await click('Send')
    expect(sent(calls, 'post', '/wxoa/templates/TPL-ship_1/send')).toHaveLength(0)
  })

  it('without the fan view: a hint instead of the fan list, nothing searched or sent', async () => {
    useAuthStore().me = me(['wxoa.template.send'])
    const calls = mockApi(BASE)
    await show(TemplateSend, { accountId: 2, template: TPL })
    expect(sent(calls, 'get', '/wxoa/fans')).toHaveLength(0)
    expect(w.findComponent(ElSelect).props('disabled')).toBe(true)
    expect(w.text()).toContain('Choosing fans needs the permission to browse fans')
    expect(button('Send')!.attributes('disabled')).toBeDefined()
  })
})

describe('qr codes', () => {
  it("lists the account's codes: image copy or placeholder, tag names, expiry; another account starts empty", async () => {
    const urls = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:qr')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    let releaseCodes = () => {}
    let releaseTags = () => {}
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/qrcodes': (c) =>
        c.params.accountId === 3
          ? new Promise(
              (r) =>
                (releaseCodes = () =>
                  r(
                    ok({
                      items: [qr(20, { accountId: 3, label: 'Autumn flyer', tagId: 100 })],
                      total: 1,
                    }),
                  )),
            )
          : ok({ items: CODES, total: 2 }),
      // the same tag id names another tag in another account
      'GET /wxoa/tags': (c) =>
        c.params.accountId === 3
          ? new Promise(
              (r) =>
                (releaseTags = () =>
                  r(ok([{ id: 21, accountId: 3, tagId: 100, name: 'Gold', fanCount: 0 }]))),
            )
          : ok(TAGS),
    })
    await show(QrcodePage)
    expect(last(calls, 'get', '/wxoa/qrcodes')!.params).toEqual({
      page: 1,
      pageSize: 20,
      sort: '-createdAt',
      accountId: 2,
    })
    expect(last(calls, 'get', '/wxoa/tags')!.params).toEqual({ accountId: 2 })
    const rows = w.findAll('.el-table__body tr')
    expect(urls).toHaveBeenCalledTimes(1)
    expect(rows[0]!.find('img').attributes('src')).toBe('blob:qr')
    expect(rows[0]!.text()).toContain('VIP')
    expect(rows[0]!.text()).toContain('Never expires')
    expect(rows[0]!.text()).toContain('12')
    // no image copy: a placeholder; a tag not known here as its id
    expect(rows[1]!.find('img').exists()).toBe(false)
    expect(rows[1]!.find('[role=img]').exists()).toBe(true)
    expect(rows[1]!.text()).toContain('#999')
    expect(rows[1]!.text()).toContain('Expired')
    // only a code with an image copy downloads
    expect(rows[0]!.findAll('button').some((b) => b.text() === 'Download')).toBe(true)
    expect(rows[1]!.findAll('button').some((b) => b.text() === 'Download')).toBe(false)

    useWxoaAccount().accountId.value = 3
    await flushPromises()
    expect(last(calls, 'get', '/wxoa/qrcodes')!.params).toMatchObject({ accountId: 3 })
    expect(last(calls, 'get', '/wxoa/tags')!.params).toEqual({ accountId: 3 })
    // nothing of the previous account while the next one loads
    const table = () => w.find('.el-table__body').text()
    expect(table()).not.toContain('Spring poster')
    expect(table()).not.toContain('VIP')
    releaseCodes()
    await flushPromises()
    expect(table()).toContain('Autumn flyer')
    expect(table()).toContain('#100')
    expect(table()).not.toContain('VIP')
    releaseTags()
    await flushPromises()
    expect(table()).toContain('Gold')
  })

  it('the image downloads with its type, named after the scene', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:qr')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const saved: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download)
    })
    const calls = mockApi(BASE)
    await show(QrcodePage)
    await rowButtons('Download')[0]!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'get', '/storage/objects/31/download')).toHaveLength(2)
    expect(saved).toEqual(['qrcode-scene_5.png'])
  })

  it('create and edit open the form with the code and its own account tags; the list reloads', async () => {
    const calls = mockApi(BASE)
    await show(QrcodePage)
    await click('Add')
    expect(dialogs[0]!.props).toEqual({ accountId: 2, row: null, tags: TAGS })
    dialogs[0]!.settle(true)
    await flushPromises()

    const loads = sent(calls, 'get', '/wxoa/qrcodes').length
    await rowButtons('Edit')[0]!.trigger('click')
    await flushPromises()
    expect(dialogs[1]!.props).toEqual({ accountId: 2, row: CODES[0], tags: TAGS })
    dialogs[1]!.settle(true)
    await flushPromises()
    expect(sent(calls, 'get', '/wxoa/qrcodes')).toHaveLength(loads + 1)
  })

  it('delete warns that a permanent code keeps working on WeChat', async () => {
    const calls = mockApi({ ...BASE, 'DELETE /wxoa/qrcodes/5': ok(null) })
    await show(QrcodePage)
    const ask = confirm().mockResolvedValue('confirm' as never)
    await rowButtons('Delete')[0]!.trigger('click')
    await flushPromises()
    expect(String(ask.mock.calls[0]![0])).toContain('keeps working on WeChat')
    expect(sent(calls, 'delete', '/wxoa/qrcodes/5')).toHaveLength(1)
  })

  it('without the other permissions: stats only, no tags loaded', async () => {
    useAuthStore().me = me(['wxoa.qrcode.browse'])
    const calls = mockApi(BASE)
    await show(QrcodePage)
    expect(sent(calls, 'get', '/wxoa/tags')).toHaveLength(0)
    expect(w.find('.el-table__body').text()).toContain('#100')
    expect(button('Add')!.isVisible()).toBe(false)
    expect(rowButtons('Edit')).toHaveLength(0)
    expect(rowButtons('Delete').every((b) => !b.isVisible())).toBe(true)
    expect(rowButtons('Stats')).toHaveLength(2)
  })
})

describe('qr code form', () => {
  it('create: a temporary code for 30 days by default, the scene checked, the auto tag optional', async () => {
    const calls = mockApi({ ...BASE, 'POST /wxoa/qrcodes': ok(qr(9)) })
    await show(QrcodeForm, { accountId: 2, row: null, tags: TAGS })
    await item('QR code name')!.find('input').setValue('Booth')
    await item('Scene')!.find('input').setValue('not a scene!')
    await click('Save')
    expect(sent(calls, 'post', '/wxoa/qrcodes')).toHaveLength(0)
    await vi.waitFor(() => expect(errors()).toContain('Scene has an invalid format'))

    await item('Scene')!.find('input').setValue('booth_2026')
    w.findAllComponents(ElSelect).at(-1)!.vm.$emit('update:modelValue', 101)
    await click('Save')
    expect(body(last(calls, 'post', '/wxoa/qrcodes'))).toEqual({
      accountId: 2,
      label: 'Booth',
      qrKind: 'temporary',
      scene: 'booth_2026',
      expireSeconds: 2_592_000,
      tagId: 101,
    })
    expect(w.emitted('done')).toEqual([[true]])
  })

  it('the validity: longer than 30 days is refused; a permanent code sends none', async () => {
    const calls = mockApi({ ...BASE, 'POST /wxoa/qrcodes': ok(qr(9)) })
    await show(QrcodeForm, { accountId: 2, row: null, tags: null })
    // no tags to offer: no auto tag field
    expect(item('Auto tag')).toBeUndefined()
    await item('QR code name')!.find('input').setValue('Booth')
    await item('Scene')!.find('input').setValue('booth')
    expect(item('Validity')).toBeDefined()
    w.findComponent(ElInputNumber).vm.$emit('update:modelValue', 31)
    await flushPromises()
    await click('Save')
    expect(sent(calls, 'post', '/wxoa/qrcodes')).toHaveLength(0)
    // the range, not a count of seconds
    await vi.waitFor(() => expect(errors()).toContain('From 60 seconds to 30 days'))

    // 12 hours
    w.findComponent(ElInputNumber).vm.$emit('update:modelValue', 12)
    w.findAllComponents(ElSelect)[0]!.vm.$emit('update:modelValue', 'hour')
    await flushPromises()
    await click('Save')
    expect(body(last(calls, 'post', '/wxoa/qrcodes'))).toMatchObject({ expireSeconds: 43_200 })

    await w
      .findAll('.el-radio')
      .find((r) => r.text() === 'Permanent')!
      .find('input')
      .setValue(true)
    await flushPromises()
    expect(item('Validity')).toBeUndefined()
    expect(w.text()).toContain('cannot be deleted on WeChat')
    await click('Save')
    expect(body(last(calls, 'post', '/wxoa/qrcodes'))).toMatchObject({
      qrKind: 'permanent',
      expireSeconds: null,
      tagId: null,
    })
  })

  it('edit sends the name and the auto tag only; without tags to offer the tag stays', async () => {
    const calls = mockApi({ ...BASE, 'PUT /wxoa/qrcodes/5': ok(null) })
    await show(QrcodeForm, { accountId: 2, row: CODES[0], tags: TAGS })
    expect(item('Scene')).toBeUndefined()
    expect(item('QR code type')).toBeUndefined()
    await item('QR code name')!.find('input').setValue('Summer poster')
    w.findComponent(ElSelect).vm.$emit('update:modelValue', undefined)
    await click('Save')
    expect(body(last(calls, 'put', '/wxoa/qrcodes/5'))).toEqual({
      label: 'Summer poster',
      tagId: null,
    })

    w.unmount()
    await show(QrcodeForm, { accountId: 2, row: CODES[0], tags: null })
    await click('Save')
    expect(body(last(calls, 'put', '/wxoa/qrcodes/5'))).toEqual({
      label: 'Spring poster',
      tagId: 100,
    })
  })
})

describe('qr code stats', () => {
  it('per day as bars over the chosen range, with the totals', async () => {
    const day = (d: string, scans: number, subscribes: number) => ({ day: d, scans, subscribes })
    const calls = mockApi({
      'GET /wxoa/qrcodes/5/stats': (c) =>
        ok(
          c.params.days === 7
            ? [day('2026-10-05', 1, 0), day('2026-10-06', 0, 0)]
            : [day('2026-10-05', 4, 1), day('2026-10-06', 8, 2)],
        ),
    })
    await show(QrcodeStats, { id: 5, label: 'Spring poster' })
    expect(last(calls, 'get', '/wxoa/qrcodes/5/stats')!.params).toEqual({ days: 30 })
    const chart = w.findComponent(QwChart)
    expect(chart.props('title')).toBe('Scans of Spring poster')
    type Option = {
      xAxis: { data: string[] }
      series: { type: string; name: string; data: number[] }[]
    }
    const option = () => chart.props('option') as Option
    const totals = () => w.findAll('[role=status] > span').map((s) => s.text())
    expect(option().xAxis.data).toEqual(['10-05', '10-06'])
    expect(option().series.map((s) => [s.type, s.name, s.data])).toEqual([
      ['bar', 'Scans', [4, 8]],
      ['bar', 'Follows', [1, 2]],
    ])
    expect(totals()).toEqual(['Scans: 12', 'Follows: 3'])

    await w
      .findAll('.el-radio-button')
      .find((b) => b.text() === 'Last 7 days')!
      .find('input')
      .setValue(true)
    await flushPromises()
    expect(last(calls, 'get', '/wxoa/qrcodes/5/stats')!.params).toEqual({ days: 7 })
    expect(totals()).toEqual(['Scans: 1', 'Follows: 0'])
    expect(option().xAxis.data).toEqual(['10-05', '10-06'])
    expect(option().series.map((s) => s.data)).toEqual([
      [1, 0],
      [0, 0],
    ])
  })
})
