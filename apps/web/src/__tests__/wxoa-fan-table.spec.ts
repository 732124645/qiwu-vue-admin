// Fan page of an official account (see docs/design-notes.md#wxoa): the list always names the chosen
// account and drops the tag filter when the account changes, export takes the same filters, the remark,
// tagging and blocking calls name the selected fans of their own account, the background sync is polled
// until it ends, the tag panel edits tags on WeChat, and actions follow the permissions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import {
  wxoaFanRemarkBody,
  type WxoaAccountOption,
  type WxoaFanVo,
  type WxoaSyncVo,
  type WxoaTagVo,
} from '@qiwu/shared'
import { wxoaFanApi } from '@/api/platform/wxoa/fan'
import { dialogs } from '@/core/dialog'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { useWxoaAccount } from '@/views/platform/wxoa/components/use-wxoa-account'
import FanPage from '@/views/platform/wxoa/fan/index.vue'
import FanTagging from '@/views/platform/wxoa/fan/tagging.vue'
import TextForm from '@/views/platform/wxoa/fan/text-form.vue'
import { fail, me, mockApi, ok, type Route } from './mock-api'

const AT = '2026-10-06T01:00:00.000Z'
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
const FANS = [fan(1, { tagIds: [100, 101], remark: 'Alice' }), fan(2)]
const TAGS: WxoaTagVo[] = [{ id: 11, accountId: 2, tagId: 100, name: 'VIP', fanCount: 1 }]
const OPTIONS: WxoaAccountOption[] = [
  { id: 2, label: 'Shop', accountKind: 'service', verified: true, enabled: true },
  { id: 3, label: 'News', accountKind: 'subscription', verified: false, enabled: true },
]
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
  'GET /settings/dicts/core.yes_no/entries': entries(['true', 'Yes'], ['false', 'No']),
  'GET /iam/profile/prefs/table.wxoa.fan': ok({ value: null }),
  'GET /wxoa/accounts/options': ok(OPTIONS),
  'GET /wxoa/fans': ok({ items: FANS, total: 2 }),
  'GET /wxoa/tags': ok(TAGS),
  'GET /wxoa/fans/sync': ok(IDLE),
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
const button = (text: string) => w.findAll('button').find((b) => b.text() === text)
async function click(text: string) {
  await button(text)!.trigger('click')
  await flushPromises()
}
const rows = () => w.findAll('.el-table__body tr')
const confirm = () => vi.spyOn(ElMessageBox, 'confirm')

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
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

describe('fan list', () => {
  it("lists the chosen account's fans; a picked tag filters, another account starts unfiltered", async () => {
    const calls = mockApi(BASE)
    await show(FanPage)

    expect(last(calls, 'get', '/wxoa/fans')!.params).toEqual({
      page: 1,
      pageSize: 20,
      accountId: 2,
    })
    expect(last(calls, 'get', '/wxoa/tags')!.params).toEqual({ accountId: 2 })
    const text = w.find('.el-table__body').text()
    expect(text).toContain('o-fan-1')
    // a tag not loaded here shows as its WeChat id
    expect(text).toContain('VIP')
    expect(text).toContain('#101')

    await w.find('.wxoa-tags button[aria-pressed="false"]').trigger('click')
    await flushPromises()
    expect(last(calls, 'get', '/wxoa/fans')!.params).toEqual({
      page: 1,
      pageSize: 20,
      tagId: 100,
      accountId: 2,
    })

    useWxoaAccount().accountId.value = 3
    await flushPromises()
    expect(last(calls, 'get', '/wxoa/fans')!.params).toEqual({
      page: 1,
      pageSize: 20,
      accountId: 3,
    })
    expect(last(calls, 'get', '/wxoa/tags')!.params).toEqual({ accountId: 3 })
    expect(last(calls, 'get', '/wxoa/fans/sync')!.params).toEqual({ accountId: 3 })
  })

  it('another account: the fans and selection of the previous one go, even if its list fails', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/fans': (c) =>
        c.params.accountId === 2 ? ok({ items: FANS, total: 2 }) : fail(500, 'B0001'),
      // the other account's tags arrive: the tagging button must not offer them for these fans
      'GET /wxoa/tags': (c) =>
        ok(
          c.params.accountId === 2 ? TAGS : [{ ...TAGS[0]!, id: 31, accountId: 3, name: 'Other' }],
        ),
    })
    await show(FanPage)
    await rows()[0]!.find('.el-checkbox input').setValue(true)
    await flushPromises()
    expect(button('Tag')).toBeDefined()

    useWxoaAccount().accountId.value = 3
    await flushPromises()
    expect(last(calls, 'get', '/wxoa/fans')!.params).toMatchObject({ accountId: 3 })
    expect(w.find('.el-table__body').text()).not.toContain('o-fan-1')
    expect(w.find('.table-toolbar__actions').text()).not.toMatch(/Tag|Block/)
  })

  it('exports with the filters of the list and its account', async () => {
    const calls = mockApi({ ...BASE, 'GET /wxoa/fans/export': [200, new Blob(['xlsx'])] })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    await show(FanPage)

    await w.find('input[name="openId"]').setValue('o-fan-1')
    await click('Search')
    await click('Export')
    expect(last(calls, 'get', '/wxoa/fans/export')!.params).toEqual({
      openId: 'o-fan-1',
      accountId: 2,
    })
  })

  it('without the permissions: no tag panel, sync, export or fan actions', async () => {
    useAuthStore().me = me(['wxoa.fan.browse'])
    const calls = mockApi(BASE)
    await show(FanPage)

    expect(w.text()).toContain('o-fan-1')
    expect(w.find('.wxoa-tags').exists()).toBe(false)
    expect(sent(calls, 'get', '/wxoa/tags')).toHaveLength(0)
    expect(sent(calls, 'get', '/wxoa/fans/sync')).toHaveLength(0)
    expect(button('Sync fans')).toBeUndefined()
    expect(button('Export')!.isVisible()).toBe(false)
    expect(button('Remark')).toBeUndefined()

    await rows()[0]!.find('.el-checkbox input').setValue(true)
    await flushPromises()
    for (const action of ['Tag', 'Block', 'Unblock']) expect(button(action)).toBeUndefined()
  })
})

describe('fan actions', () => {
  it('the remark goes through its own PUT; one over 30 characters never leaves', async () => {
    const calls = mockApi({ 'PUT /wxoa/fans/5/remark': ok(null) })
    const save = (b: { remark: string }) => wxoaFanApi.remark(5, b)
    await show(TextForm, {
      schema: wxoaFanRemarkBody,
      prop: 'remark',
      value: 'Al',
      maxlength: 30,
      save,
    })
    const input = w.find('input')
    expect((input.element as HTMLInputElement).value).toBe('Al')

    await input.setValue('x'.repeat(31))
    await click('Save')
    expect(sent(calls, 'put', '/wxoa/fans/5/remark')).toHaveLength(0)
    await vi.waitFor(() => expect(w.find('.el-form-item__error').exists()).toBe(true))

    await input.setValue('Alice')
    await click('Save')
    expect(body(last(calls, 'put', '/wxoa/fans/5/remark'))).toEqual({ remark: 'Alice' })
    expect(w.emitted('done')).toEqual([[true]])
  })

  it('remark from the row: the dialog starts from the stored remark, the list reloads once saved', async () => {
    const calls = mockApi(BASE)
    await show(FanPage)
    const loads = sent(calls, 'get', '/wxoa/fans').length

    // el-table also renders the slot once outside the body, without a row
    await w
      .find('.el-table__body')
      .findAll('button')
      .find((b) => b.text() === 'Remark')!
      .trigger('click')
    await flushPromises()
    expect(dialogs[0]!.props).toMatchObject({ prop: 'remark', value: 'Alice', maxlength: 30 })
    dialogs[0]!.settle(true)
    await flushPromises()
    expect(sent(calls, 'get', '/wxoa/fans')).toHaveLength(loads + 1)
  })

  it('tagging and blocking name the selected fans and their account', async () => {
    const calls = mockApi({
      ...BASE,
      'POST /wxoa/fans/blocking': ok(null),
      'POST /wxoa/fans/tagging': ok(null),
    })
    await show(FanPage)
    await rows()[0]!.find('.el-checkbox input').setValue(true)
    await rows()[1]!.find('.el-checkbox input').setValue(true)
    await flushPromises()

    await click('Tag')
    expect(dialogs[0]!.props).toEqual({ accountId: 2, fanIds: [1, 2], tags: TAGS })

    const ask = confirm()
      .mockRejectedValueOnce('cancel')
      .mockResolvedValueOnce('confirm' as never)
    await click('Block')
    expect(String(ask.mock.calls[0]![0])).toContain('(2)')
    expect(sent(calls, 'post', '/wxoa/fans/blocking')).toHaveLength(0)
    await click('Block')
    expect(body(last(calls, 'post', '/wxoa/fans/blocking'))).toEqual({
      accountId: 2,
      fanIds: [1, 2],
      blocked: true,
    })

    // the dialog itself: a tag must be picked; then the op as chosen
    w.unmount()
    await show(FanTagging, { accountId: 2, fanIds: [1, 2], tags: TAGS })
    await click('Save')
    expect(sent(calls, 'post', '/wxoa/fans/tagging')).toHaveLength(0)
    await w.find('.el-select__wrapper').trigger('click')
    await flushPromises()
    const option = [...document.querySelectorAll('.el-select-dropdown__item')].find(
      (o) => o.textContent?.trim() === 'VIP',
    ) as HTMLElement
    option.click()
    await flushPromises()
    await w
      .findAll('.el-radio')
      .find((r) => r.text() === 'Remove the tag')!
      .find('input')
      .setValue(true)
    await click('Save')
    expect(body(last(calls, 'post', '/wxoa/fans/tagging'))).toEqual({
      accountId: 2,
      fanIds: [1, 2],
      tagId: 100,
      op: 'remove',
    })
    expect(w.emitted('done')).toEqual([[true]])
  })
})

describe('fan sync', () => {
  it('starts the sync, polls its progress until it ends, then reloads fans and tags', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let state: WxoaSyncVo = IDLE
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/fans/sync': () => ok(state),
      'POST /wxoa/fans/sync': ok(null),
    })
    await show(FanPage)
    const polls = () => sent(calls, 'get', '/wxoa/fans/sync').length
    const fanLoads = () => sent(calls, 'get', '/wxoa/fans').length
    const tagLoads = () => sent(calls, 'get', '/wxoa/tags').length
    const [before, fansBefore, tagsBefore] = [polls(), fanLoads(), tagLoads()]

    state = { ...IDLE, state: 'running', done: 10, total: 50 }
    await click('Sync fans')
    expect(body(last(calls, 'post', '/wxoa/fans/sync'))).toEqual({ accountId: 2 })
    expect(w.text()).toContain('Syncing fans: 10 of 50 done')

    state = { ...state, done: 30 }
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()
    expect(w.text()).toContain('Syncing fans: 30 of 50 done')
    expect(fanLoads()).toBe(fansBefore)

    state = { ...state, state: 'done', done: 50, finishedAt: AT }
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()
    expect(w.text()).toContain('Last sync finished at')
    expect(fanLoads()).toBe(fansBefore + 1)
    expect(tagLoads()).toBe(tagsBefore + 1)

    // finished: no more polling
    const after = polls()
    expect(after).toBe(before + 3)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(polls()).toBe(after)
  })

  it('a poll still waiting is never overlapped; a failed one frees the button, a sync still running shows again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const RUNNING: WxoaSyncVo = { ...IDLE, state: 'running', done: 1, total: 9 }
    let answer: (r: ReturnType<typeof fail>) => void = () => {}
    let next: 'running' | 'hang' = 'running'
    const calls = mockApi({
      ...BASE,
      'GET /wxoa/fans/sync': () =>
        next === 'hang' ? new Promise((resolve) => (answer = resolve)) : ok(RUNNING),
      'POST /wxoa/fans/sync': fail(409, 'B6010'),
    })
    await show(FanPage)
    const polls = () => sent(calls, 'get', '/wxoa/fans/sync').length
    expect(w.text()).toContain('1 of 9')
    expect(button('Sync fans')!.classes()).toContain('is-loading')

    next = 'hang'
    await vi.advanceTimersByTimeAsync(2000)
    const waiting = polls()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(polls()).toBe(waiting)

    answer(fail(502, 'B0001'))
    await flushPromises()
    expect(w.text()).not.toContain('1 of 9')
    expect(button('Sync fans')!.classes()).not.toContain('is-loading')
    expect(button('Sync fans')!.attributes('disabled')).toBeUndefined()

    next = 'running'
    await click('Sync fans')
    expect(sent(calls, 'post', '/wxoa/fans/sync')).toHaveLength(1)
    expect(w.text()).toContain('1 of 9')
    const resumed = polls()
    await vi.advanceTimersByTimeAsync(2000)
    expect(polls()).toBe(resumed + 1)
  })

  it('an interrupted sync says so and may run again', async () => {
    mockApi({ ...BASE, 'GET /wxoa/fans/sync': ok({ ...IDLE, state: 'interrupted' }) })
    await show(FanPage)
    expect(w.text()).toContain('The last sync was interrupted')
    expect(button('Sync fans')!.attributes('disabled')).toBeUndefined()
  })
})

describe('tag panel', () => {
  it('adds, deletes and syncs tags on the account, reloading tags and fans after each', async () => {
    const calls = mockApi({
      ...BASE,
      'POST /wxoa/tags': ok({ id: 12 }),
      'DELETE /wxoa/tags/11': ok(null),
      'POST /wxoa/tags/sync': ok(null),
    })
    await show(FanPage)
    const tagLoads = () => sent(calls, 'get', '/wxoa/tags').length
    const fanLoads = () => sent(calls, 'get', '/wxoa/fans').length
    let [tags, fans] = [tagLoads(), fanLoads()]
    const reloaded = () => {
      expect([tagLoads(), fanLoads()]).toEqual([tags + 1, fans + 1])
      ;[tags, fans] = [tagLoads(), fanLoads()]
    }

    await w.find('button[aria-label="New tag"]').trigger('click')
    const props = dialogs[0]!.props as { prop: string; save: (b: object) => Promise<unknown> }
    expect(props.prop).toBe('name')
    await props.save({ name: 'Gold' })
    expect(body(last(calls, 'post', '/wxoa/tags'))).toEqual({ accountId: 2, name: 'Gold' })
    dialogs[0]!.settle(true)
    await flushPromises()
    reloaded()

    // deleting the tag the list is filtered by drops the filter
    await w.find('.wxoa-tags button[aria-pressed="false"]').trigger('click')
    await flushPromises()
    fans = fanLoads()
    confirm().mockResolvedValueOnce('confirm' as never)
    await w.find('button[aria-label="Delete VIP"]').trigger('click')
    await flushPromises()
    expect(sent(calls, 'delete', '/wxoa/tags/11')).toHaveLength(1)
    expect(last(calls, 'get', '/wxoa/fans')!.params).not.toHaveProperty('tagId')

    ;[tags, fans] = [tagLoads(), fanLoads()]
    await w.find('button[aria-label="Sync tags from WeChat"]').trigger('click')
    await flushPromises()
    expect(body(last(calls, 'post', '/wxoa/tags/sync'))).toEqual({ accountId: 2 })
    reloaded()
  })

  it('a rename sends only the name; an account with 100 tags cannot add one', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      ...TAGS[0]!,
      id: 11 + i,
      tagId: 100 + i,
      name: i ? `T${i}` : 'VIP',
    }))
    const calls = mockApi({ ...BASE, 'GET /wxoa/tags': ok(many), 'PUT /wxoa/tags/11': ok(null) })
    await show(FanPage)

    expect(w.find('button[aria-label="New tag"]').exists()).toBe(false)
    const add = w.find('button[aria-label="An account has at most 100 tags"]')
    expect(add.attributes('disabled')).toBeDefined()

    await w.find('button[aria-label="Edit VIP"]').trigger('click')
    const props = dialogs[0]!.props as { value: string; save: (b: object) => Promise<unknown> }
    expect(props.value).toBe('VIP')
    await props.save({ name: 'Gold' })
    expect(body(last(calls, 'put', '/wxoa/tags/11'))).toEqual({ name: 'Gold' })
  })

  it('browsing tags only: the panel filters, but nothing adds, renames, deletes or syncs', async () => {
    useAuthStore().me = me(['wxoa.fan.browse', 'wxoa.tag.browse'])
    mockApi(BASE)
    await show(FanPage)

    expect(w.find('.wxoa-tags').text()).toContain('VIP')
    for (const label of ['New tag', 'Edit VIP', 'Delete VIP', 'Sync tags from WeChat'])
      expect(w.find(`button[aria-label="${label}"]`).exists()).toBe(false)
  })
})
