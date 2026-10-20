// Official account page and account switch (see docs/design-notes.md#wxoa): write-only secrets left out
// of an untouched save, the fixed AppID never sent on edit, encryption mode following the account type,
// the callback URL on this origin (a new account opens again to show it, read-only without the edit
// permission), the meaning of a failed connection test, the confirmed quota reset, the per-user account
// choice kept through a failed reload.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VNode } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import type { WxoaAccountDetailVo, WxoaAccountOption, WxoaAccountVo } from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import AccountPage from '@/views/platform/wxoa/account/index.vue'
import AccountForm from '@/views/platform/wxoa/account/form.vue'
import AccountQuota from '@/views/platform/wxoa/account/quota.vue'
import AccountTest from '@/views/platform/wxoa/account/test.vue'
import AccountSwitch from '@/views/platform/wxoa/components/AccountSwitch.vue'
import { useWxoaAccount } from '@/views/platform/wxoa/components/use-wxoa-account'
import { fail, me, mockApi, ok, type Route } from './mock-api'

const AT = '2026-10-06T01:00:00.000Z'
const ROW: WxoaAccountVo = {
  id: 7,
  label: 'Main',
  appId: 'wx0123456789abcdef',
  accountKind: 'service',
  verified: true,
  cryptoMode: 'secure',
  enabled: true,
  lastPushAt: null,
  note: null,
  createdAt: AT,
  updatedAt: AT,
}
const DETAIL: WxoaAccountDetailVo = {
  ...ROW,
  callbackPath: '/api/wxoa/callback/AbCdEfGhIjKlMnOpQrStUv',
  hasAppSecret: true,
  hasToken: true,
  hasAesKey: true,
}
const SECRET = '0123456789abcdef0123456789abcdef'

const entries = (...pairs: [string, string][]) =>
  ok({ version: 1, entries: pairs.map(([value, label]) => ({ value, label, labelI18n: null })) })
const DICTS: Record<string, Route> = {
  'GET /settings/dicts/wxoa.account_kind/entries': entries(
    ['service', 'Service account'],
    ['subscription', 'Subscription account'],
    ['sandbox', 'Sandbox account'],
  ),
  'GET /settings/dicts/wxoa.crypto_mode/entries': entries(
    ['plain', 'Plaintext'],
    ['compat', 'Compatible'],
    ['secure', 'Secure'],
  ),
  'GET /settings/dicts/core.yes_no/entries': entries(['true', 'Yes'], ['false', 'No']),
  'GET /settings/dicts/core.enabled/entries': entries(['true', 'On'], ['false', 'Off']),
}
const body = (c: { data?: unknown } | undefined) =>
  JSON.parse(String(c?.data)) as Record<string, unknown>
const sent = <C extends { method?: string; url?: string }>(
  calls: C[],
  method: string,
  url: string,
) => calls.filter((c) => c.method === method && c.url === url)

let w: VueWrapper
const router = () =>
  createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      { path: '/wxoa/accounts', name: 'wxoa-account', component: { render: () => null } },
    ],
  })
async function show(component: object, props: Record<string, unknown> = {}, plugins = [router()]) {
  w = mount(component, {
    props,
    global: { plugins: [ElementPlus, i18n, ...plugins], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
}
const item = (label: string) =>
  w.findAll('.el-form-item').find((i) => i.find('.el-form-item__label').text() === label)
const input = (label: string) => item(label)!.find('input')
const radio = (text: string) => w.findAll('.el-radio').find((r) => r.text() === text)!
const button = (text: string) => w.findAll('button').find((b) => b.text() === text)
async function click(text: string) {
  await button(text)!.trigger('click')
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  localStorage.clear()
  useAuthStore().me = me(['*'])
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  w?.unmount()
  dialogs.splice(0)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('account form', () => {
  it('editing: the AppID read-only and never sent, blank secrets left out of the PUT', async () => {
    const calls = mockApi({
      ...DICTS,
      'GET /wxoa/accounts/7': ok(DETAIL),
      'PUT /wxoa/accounts/7': ok(null),
    })
    await show(AccountForm, { id: 7 })

    expect(item('AppID')!.text()).toContain('wx0123456789abcdef')
    expect(item('AppID')!.find('input').exists()).toBe(false)
    for (const label of ['AppSecret', 'Token', 'EncodingAESKey'])
      expect(input(label).attributes('placeholder')).toBe('Set; leave blank to keep')

    await input('Account name').setValue('Main 2')
    await click('Save')
    const [first] = sent(calls, 'put', '/wxoa/accounts/7')
    expect(body(first)).toEqual({
      label: 'Main 2',
      accountKind: 'service',
      verified: true,
      cryptoMode: 'secure',
      enabled: true,
      note: null,
    })

    // a secret typed in goes along; the ones left blank still do not
    await input('Token').setValue('newToken9')
    await click('Save')
    const second = body(sent(calls, 'put', '/wxoa/accounts/7')[1])
    expect(second.token).toBe('newToken9')
    for (const key of ['appId', 'appSecret', 'aesKey']) expect(second).not.toHaveProperty(key)
  })

  it('editing: the callback URL on this origin, copied with one click', async () => {
    mockApi({ ...DICTS, 'GET /wxoa/accounts/7': ok(DETAIL) })
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await show(AccountForm, { id: 7 })

    const url = `${location.origin}/api/wxoa/callback/AbCdEfGhIjKlMnOpQrStUv`
    expect(item('Server URL')!.text()).toContain(url)
    await click('Copy')
    expect(writeText).toHaveBeenCalledWith(url)
  })

  it('adding: an encrypted mode needs the AES key; a sandbox account is plaintext only', async () => {
    const calls = mockApi({ ...DICTS, 'POST /wxoa/accounts': ok({ ...DETAIL, id: 9 }) })
    await show(AccountForm)
    expect(item('Server URL')!.text()).toContain('shows here once saved')

    await input('Account name').setValue('Sandbox')
    await input('AppID').setValue('wx00000000000000aa')
    await input('AppSecret').setValue(SECRET)
    await input('Token').setValue('tok123')
    await radio('Compatible').find('input').setValue(true)
    await flushPromises()
    await click('Save')
    expect(sent(calls, 'post', '/wxoa/accounts')).toHaveLength(0)
    // el-form-item shows errors after a 100 ms debounce
    await vi.waitFor(() =>
      expect(w.findAll('.el-form-item__error').map((e) => e.text())).toEqual([
        'Compatible and secure modes need an EncodingAESKey',
      ]),
    )

    // a sandbox account falls back to plaintext and cannot pick another mode
    await radio('Sandbox account').find('input').setValue(true)
    await flushPromises()
    expect(radio('Plaintext').classes()).toContain('is-checked')
    expect(radio('Compatible').classes()).toContain('is-disabled')
    expect(radio('Secure').classes()).toContain('is-disabled')
    expect(item('EncodingAESKey')).toBeUndefined()

    await click('Save')
    expect(body(sent(calls, 'post', '/wxoa/accounts')[0])).toEqual({
      label: 'Sandbox',
      appId: 'wx00000000000000aa',
      accountKind: 'sandbox',
      verified: false,
      cryptoMode: 'plain',
      appSecret: SECRET,
      token: 'tok123',
      enabled: true,
      note: null,
    })
  })
})

describe('connection test', () => {
  it('explains a known error code; an unknown one shows alone', async () => {
    let code = 'B6006'
    mockApi({
      'POST /wxoa/accounts/7/test': () =>
        ok({ tokenOk: false, apiOk: false, code, ip: null, lastPushAt: null }),
    })
    await show(AccountTest, { id: 7 })
    expect(w.text()).toContain('B6006')
    expect(w.text()).toContain('WeChat does not accept the AppID or AppSecret')

    code = 'B6099'
    await click('Test again')
    expect(w.text()).toContain('B6099')
    expect(w.findAll('.field-hint')).toHaveLength(0)
  })
})

describe('quota dialog', () => {
  const QUOTA = [
    { api: '/cgi-bin/message/custom/send', dailyLimit: 500000, used: 3, remain: 499997 },
  ]

  it('resets the call counts only after a confirm naming the monthly limit', async () => {
    const calls = mockApi({
      'GET /wxoa/accounts/7/quota': ok(QUOTA),
      'POST /wxoa/accounts/7/quota/clear': ok(null),
    })
    const confirm = vi
      .spyOn(ElMessageBox, 'confirm')
      .mockRejectedValueOnce('cancel')
      .mockResolvedValueOnce('confirm' as never)
    await show(AccountQuota, { id: 7 })
    expect(w.text()).toContain('/cgi-bin/message/custom/send')

    await click('Reset call counts')
    expect(String(confirm.mock.calls[0]![0])).toContain('10 times a month')
    expect(sent(calls, 'post', '/wxoa/accounts/7/quota/clear')).toHaveLength(0)

    await click('Reset call counts')
    expect(sent(calls, 'post', '/wxoa/accounts/7/quota/clear')).toHaveLength(1)
    // reloaded after the reset
    expect(sent(calls, 'get', '/wxoa/accounts/7/quota')).toHaveLength(2)
  })

  it('no reset button without the reset permission', async () => {
    mockApi({ 'GET /wxoa/accounts/7/quota': ok(QUOTA) })
    useAuthStore().me = me(['wxoa.account.browse'])
    await show(AccountQuota, { id: 7 })
    expect(button('Reset call counts')!.isVisible()).toBe(false)
  })
})

describe('account page', () => {
  it('lists the accounts, an account without a push yet as not connected', async () => {
    mockApi({
      ...DICTS,
      'GET /wxoa/accounts': ok({ items: [ROW], total: 1 }),
      'GET /iam/profile/prefs/table.wxoa.account': ok({ value: null }),
    })
    await show(AccountPage)
    const text = w.find('.el-table__body').text()
    expect(text).toContain('wx0123456789abcdef')
    expect(text).toContain('Not connected')
    for (const action of ['Test connection', 'API quota', 'Edit', 'Delete'])
      expect(button(action)).toBeDefined()
  })

  it('a new account opens again for editing, where its callback URL shows', async () => {
    mockApi({
      ...DICTS,
      'GET /wxoa/accounts': ok({ items: [], total: 0 }),
      'GET /iam/profile/prefs/table.wxoa.account': ok({ value: null }),
    })
    await show(AccountPage)
    await click('Add')
    expect(dialogs.map((d) => d.props)).toEqual([{ id: undefined }])

    dialogs[0]!.settle({ id: 9 })
    await flushPromises()
    expect(dialogs.map((d) => d.props)).toEqual([{ id: undefined }, { id: 9 }])
    // saving the edit closes it for good
    dialogs[1]!.settle({ id: 9 })
    await flushPromises()
    expect(dialogs).toHaveLength(2)
  })

  it('without the edit permission a new account shows its callback URL read-only', async () => {
    useAuthStore().me = me(['wxoa.account.browse', 'wxoa.account.create'])
    const alert = vi.spyOn(ElMessageBox, 'alert').mockResolvedValue('confirm' as never)
    mockApi({
      ...DICTS,
      'GET /wxoa/accounts': ok({ items: [], total: 0 }),
      'GET /iam/profile/prefs/table.wxoa.account': ok({ value: null }),
    })
    await show(AccountPage)
    await click('Add')
    dialogs[0]!.settle({ id: 9, callbackPath: DETAIL.callbackPath })
    await flushPromises()

    expect(dialogs).toHaveLength(1)
    expect(alert).toHaveBeenCalledOnce()
    const [message, title] = alert.mock.calls[0]!
    expect(title).toBe('Server URL')
    const box = mount({ render: () => message as VNode })
    expect(box.find('code').text()).toBe(`${location.origin}${DETAIL.callbackPath}`)
    box.unmount()
  })
})

describe('account switch', () => {
  const otherUser = () => {
    const m = me(['*'])
    return { ...m, user: { ...m.user, id: 2 } }
  }
  const OPTIONS: WxoaAccountOption[] = [
    { id: 1, label: 'Old', accountKind: 'service', verified: true, enabled: false },
    { id: 2, label: 'Shop', accountKind: 'service', verified: true, enabled: true },
    { id: 3, label: 'News', accountKind: 'subscription', verified: false, enabled: true },
  ]

  it('keeps the choice per user; a disabled or unknown choice falls back to the first enabled', async () => {
    mockApi({ ...DICTS, 'GET /wxoa/accounts/options': ok(OPTIONS) })
    localStorage.setItem('qw.wxoa.account.1', '3')
    await show(AccountSwitch)
    const state = useWxoaAccount()
    expect(state.accountId.value).toBe(3)

    state.accountId.value = 2
    expect(localStorage.getItem('qw.wxoa.account.1')).toBe('2')
    localStorage.setItem('qw.wxoa.account.1', '1')
    await state.load()
    expect(state.accountId.value).toBe(2)

    // another user starts from the first enabled account, not from user 1's choice
    localStorage.setItem('qw.wxoa.account.1', '3')
    useAuthStore().me = otherUser()
    await state.load()
    expect(state.accountId.value).toBe(2)
    state.accountId.value = 2
    expect(localStorage.getItem('qw.wxoa.account.2')).toBe('2')
    expect(localStorage.getItem('qw.wxoa.account.1')).toBe('3')
  })

  it('a failed reload keeps the list; with nothing loaded it offers a retry', async () => {
    let down = false
    mockApi({
      ...DICTS,
      'GET /wxoa/accounts/options': () => (down ? fail(503, 'B0001') : ok(OPTIONS)),
    })
    localStorage.setItem('qw.wxoa.account.1', '3')
    await show(AccountSwitch)
    const state = useWxoaAccount()
    down = true
    await state.load()
    expect(state.accountId.value).toBe(3)
    expect(state.empty.value).toBe(false)

    // the list loaded before was another user's: it goes, even while the new one loads
    useAuthStore().me = otherUser()
    const loading = state.load()
    expect(state.options.value).toEqual([])
    await loading
    await flushPromises()
    expect(state.accountId.value).toBeNull()
    expect(state.empty.value).toBe(false)
    expect(w.text()).toContain('Could not load the account list')
    expect(w.text()).not.toContain('No official account available')

    down = false
    await click('Retry')
    expect(state.accountId.value).toBe(2)
  })

  it('no enabled account: points to the account page', async () => {
    mockApi({ ...DICTS, 'GET /wxoa/accounts/options': ok([OPTIONS[0]]) })
    const r = router()
    await r.push('/')
    await show(AccountSwitch, {}, [r])
    expect(w.text()).toContain('No official account available')
    await click('Add or enable an account')
    expect(r.currentRoute.value.path).toBe('/wxoa/accounts')
  })
})
