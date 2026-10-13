import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { Err, type MePayload, type MeTenant, type TenancyVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import {
  accessToken,
  api,
  refreshAccessToken,
  sessionEnd,
  setSessionHint,
} from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import SmsLoginForm from '@/views/login/SmsLoginForm.vue'
import LoginView from '@/views/login/index.vue'
import PasswordResetView from '@/views/password-reset/index.vue'
import { fail, me, mockApi, ok, type Route } from './mock-api'

const openDialog = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | undefined>>())
vi.mock('@/core/dialog', () => ({ openDialog }))

const ON = ok({ enabled: true } satisfies TenancyVo)
const BOUND = ok({
  enabled: true,
  tenant: { code: 'acme', name: 'Acme', brandName: null, logoUrl: null },
} satisfies TenancyVo)
const TOKEN = ok({ accessToken: 'at-1', expiresIn: 900 })
const body = (call: { data?: unknown }) => JSON.parse(String(call.data))
const sent = (calls: { url?: string; data?: unknown }[], url: string) =>
  body(calls.findLast((c) => c.url === url)!)

async function open(
  view: typeof LoginView | typeof PasswordResetView,
  path: string,
  routes: Record<string, Route>,
) {
  const calls = mockApi({
    'GET /settings/params/public/captcha.mode': ok({ key: 'captcha.mode', value: 'off' }),
    ...routes,
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', component: LoginView },
      { path: '/password-reset', component: PasswordResetView },
      { path: '/home', component: { template: '<div />' } },
      { path: '/register', component: { template: '<div />' } },
    ],
  })
  await router.push(path)
  const wrapper = mount(view, { global: { plugins: [createPinia(), router, i18n, ElementPlus] } })
  await flushPromises()
  return { wrapper, router, calls }
}

const field = (wrapper: VueWrapper) => wrapper.find<HTMLInputElement>('input[name="tenantCode"]')
const rememberBox = (wrapper: VueWrapper) =>
  wrapper.find<HTMLInputElement>('.login__options input[type="checkbox"]')
/** the form holding the input named `name` (the tenant field has a form of its own) */
const formWith = (wrapper: VueWrapper, name: string) =>
  wrapper.findAll('form').find((f) => f.find(`input[name="${name}"]`).exists())!

async function signIn(wrapper: VueWrapper) {
  await wrapper.find('input[name="username"]').setValue('admin')
  await wrapper.find('input[name="password"]').setValue('Secret123!')
  await formWith(wrapper, 'username').trigger('submit')
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  setLocale('en-US')
  accessToken.value = ''
  sessionEnd.value = null
  setSessionHint(false)
  openDialog.mockReset()
})
afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('tenant code field', () => {
  it.each([
    ['off', ok({ enabled: false } satisfies TenancyVo)],
    ['on, the host bound to a tenant', BOUND],
  ])(
    'is not rendered while multi-tenancy is %s: no code sent or remembered',
    async (_, tenancy) => {
      localStorage.setItem('qw.login.tenant', 'acme')
      const { wrapper, calls } = await open(LoginView, '/login?tenant=beta', {
        'GET /auth/tenancy': tenancy,
        'POST /auth/login': TOKEN,
      })
      expect(field(wrapper).exists()).toBe(false)
      await signIn(wrapper)
      expect(sent(calls, '/auth/login')).toEqual({
        username: 'admin',
        password: 'Secret123!',
        keepSignedIn: false,
      })
      expect(localStorage.getItem('qw.login.tenant')).toBe('acme')
      wrapper.unmount()
    },
  )

  it('prefills ?tenant= over the remembered code; a password sign-in follows "remember username": its code kept (a blank one forgets it), or none kept', async () => {
    localStorage.setItem('qw.login.tenant', 'acme')
    const routes = { 'GET /auth/tenancy': ON, 'POST /auth/login': TOKEN }
    const asked = await open(LoginView, '/login?tenant=beta', routes)
    expect(field(asked.wrapper).element.value).toBe('beta')
    asked.wrapper.unmount()

    // a remembered username: the box starts ticked
    localStorage.setItem('qw.login.username', 'admin')
    const { wrapper, calls } = await open(LoginView, '/login', routes)
    expect(field(wrapper).element.value).toBe('acme')
    expect(rememberBox(wrapper).element.checked).toBe(true)
    await field(wrapper).setValue('')
    await signIn(wrapper)
    expect(localStorage.getItem('qw.login.tenant')).toBeNull()
    await field(wrapper).setValue(' gamma ')
    await signIn(wrapper)
    expect(localStorage.getItem('qw.login.tenant')).toBe('gamma')

    // not ticked (a shared computer): this code is not kept and the kept one is forgotten
    await rememberBox(wrapper).setValue(false)
    await field(wrapper).setValue('delta')
    await signIn(wrapper)
    expect(sent(calls, '/auth/login')).toMatchObject({ tenantCode: 'delta' })
    expect(localStorage.getItem('qw.login.tenant')).toBeNull()
    expect(localStorage.getItem('qw.login.username')).toBeNull()
    wrapper.unmount()
  })

  it('an unanswered /auth/tenancy is not taken for off: a sign-in asks again and shows the error if that fails too, else carries the code', async () => {
    localStorage.setItem('qw.login.tenant', 'acme')
    let reply = fail(500, 'A0500')
    const { wrapper, calls } = await open(LoginView, '/login', {
      'GET /auth/tenancy': () => reply,
      'POST /auth/login': TOKEN,
    })
    const asked = () => calls.filter((c) => c.url === '/auth/tenancy').length
    expect(field(wrapper).exists()).toBe(false)
    expect(asked()).toBe(1)
    await signIn(wrapper)
    expect(asked()).toBe(2)
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)
    expect(wrapper.find('.login__error').text()).toContain('error A0500')

    reply = ON
    await signIn(wrapper)
    expect(asked()).toBe(3)
    expect(field(wrapper).element.value).toBe('acme')
    expect(sent(calls, '/auth/login')).toMatchObject({ tenantCode: 'acme' })
    wrapper.unmount()
  })

  it('a field first shown by the sign-in asking again, with no code to fill in, stops that sign-in so the user sees it', async () => {
    let reply = fail(500, 'A0500')
    const { wrapper, calls } = await open(LoginView, '/login', {
      'GET /auth/tenancy': () => reply,
      'POST /auth/login': TOKEN,
    })
    expect(field(wrapper).exists()).toBe(false)
    reply = ON
    await signIn(wrapper)
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)
    expect(field(wrapper).exists()).toBe(true)
    expect(field(wrapper).element.value).toBe('')

    // seen now: a blank field is the default tenant
    await signIn(wrapper)
    expect(sent(calls, '/auth/login')).not.toHaveProperty('tenantCode')
    wrapper.unmount()
  })

  it('a sign-in sent before /auth/tenancy answers waits for it and carries the kept code', async () => {
    localStorage.setItem('qw.login.tenant', 'acme')
    let answer!: (reply: ReturnType<typeof ok>) => void
    const { wrapper, calls } = await open(LoginView, '/login', {
      'GET /auth/tenancy': () => new Promise((resolve) => (answer = resolve)),
      'POST /auth/login': TOKEN,
    })
    expect(field(wrapper).exists()).toBe(false)
    await signIn(wrapper)
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)
    answer(ON)
    await vi.waitFor(() =>
      expect(sent(calls, '/auth/login')).toEqual({
        username: 'admin',
        password: 'Secret123!',
        keepSignedIn: false,
        tenantCode: 'acme',
      }),
    )
    expect(field(wrapper).element.value).toBe('acme')
    wrapper.unmount()
  })

  it('password sign-in, SMS code and SMS sign-in carry the code; a blank field sends none; the SMS tab (no remember box) keeps the code', async () => {
    const { wrapper, calls } = await open(LoginView, '/login', {
      'GET /auth/tenancy': ON,
      'POST /auth/login': TOKEN,
      'POST /auth/sms/code': ok({ cooldownSec: 0 }),
      'POST /auth/sms/login': TOKEN,
    })
    await field(wrapper).setValue('acme')
    await signIn(wrapper)
    expect(sent(calls, '/auth/login')).toEqual({
      username: 'admin',
      password: 'Secret123!',
      keepSignedIn: false,
      tenantCode: 'acme',
    })
    // "remember username" not ticked
    expect(localStorage.getItem('qw.login.tenant')).toBeNull()

    await wrapper.find('#tab-sms').trigger('click')
    await flushPromises()
    const sms = wrapper.findComponent(SmsLoginForm)
    await sms.find('input[name="mobile"]').setValue('13800138000')
    await sms
      .findAll('button')
      .find((b) => b.text() === 'Get code')!
      .trigger('click')
    await flushPromises()
    expect(sent(calls, '/auth/sms/code')).toEqual({
      mobile: '13800138000',
      scene: 'signin',
      tenantCode: 'acme',
    })
    await sms.find('input[name="code"]').setValue('123456')
    await sms.find('form').trigger('submit')
    await flushPromises()
    expect(sent(calls, '/auth/sms/login')).toEqual({
      mobile: '13800138000',
      code: '123456',
      keepSignedIn: false,
      tenantCode: 'acme',
    })
    expect(localStorage.getItem('qw.login.tenant')).toBe('acme')

    await field(wrapper).setValue('  ')
    await sms.find('form').trigger('submit')
    await flushPromises()
    expect(sent(calls, '/auth/sms/login')).toEqual({
      mobile: '13800138000',
      code: '123456',
      keepSignedIn: false,
    })
    await signIn(wrapper)
    expect(sent(calls, '/auth/login')).not.toHaveProperty('tenantCode')
    wrapper.unmount()
  })

  it('an ill-formed code stops the request with the message under the field; upper case passes', async () => {
    const { wrapper, calls } = await open(LoginView, '/login', {
      'GET /auth/tenancy': ON,
      'POST /auth/login': TOKEN,
      'POST /auth/sms/code': ok({ cooldownSec: 0 }),
    })
    await field(wrapper).setValue('a_b')
    await signIn(wrapper)
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)
    // el-form-item shows its message after a 100 ms debounce
    await vi.waitFor(() =>
      expect(formWith(wrapper, 'tenantCode').find('.el-form-item__error').text()).toBe(
        'Tenant code has an invalid format',
      ),
    )

    await wrapper.find('#tab-sms').trigger('click')
    await flushPromises()
    const sms = wrapper.findComponent(SmsLoginForm)
    await sms.find('input[name="mobile"]').setValue('13800138000')
    await sms
      .findAll('button')
      .find((b) => b.text() === 'Get code')!
      .trigger('click')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)

    await field(wrapper).setValue('ACME')
    await signIn(wrapper)
    expect(sent(calls, '/auth/login')).toMatchObject({ tenantCode: 'ACME' })
    wrapper.unmount()
  })

  it('the password reset page carries the code in the SMS code and the reset, then offers it at sign-in', async () => {
    const { wrapper, router, calls } = await open(PasswordResetView, '/password-reset', {
      'GET /auth/tenancy': ON,
      'POST /auth/sms/code': ok({ cooldownSec: 0 }),
      'POST /auth/password/reset-by-sms': ok(null),
    })
    await field(wrapper).setValue('acme')
    await wrapper.find('input[name="mobile"]').setValue('13800138000')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Get code')!
      .trigger('click')
    await flushPromises()
    expect(sent(calls, '/auth/sms/code')).toEqual({
      mobile: '13800138000',
      scene: 'reset_password',
      tenantCode: 'acme',
    })
    await wrapper.find('input[name="code"]').setValue('123456')
    await wrapper.find('input[name="newPassword"]').setValue('Secret123!')
    await wrapper.find('input[name="confirmPassword"]').setValue('Secret123!')
    await formWith(wrapper, 'mobile').trigger('submit')
    await flushPromises()
    expect(sent(calls, '/auth/password/reset-by-sms')).toEqual({
      mobile: '13800138000',
      code: '123456',
      newPassword: 'Secret123!',
      tenantCode: 'acme',
    })
    expect(router.currentRoute.value.fullPath).toBe('/login?tenant=acme')
    wrapper.unmount()
  })
})

describe('session tenant on the web', () => {
  const tenant = (id: number): MeTenant => ({
    id,
    code: id === 1 ? 'default' : `t${id}`,
    name: id === 1 ? 'seed.tenant.default' : `Tenant ${id}`,
    brandName: null,
    logoUrl: null,
    acting: false,
  })

  it('a /me without tenant is the default tenant: no reload; another tenant under a loaded /me reloads', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined)
    let next: MePayload = me(['*'])
    mockApi({ 'GET /auth/me': () => ok(next) })
    const auth = useAuthStore()
    await auth.fetchMe()
    await auth.fetchMe()
    next = { ...me(['*']), tenant: tenant(1) }
    await auth.fetchMe()
    expect(reload).not.toHaveBeenCalled()
    // signed out, then in as a user of another tenant: a new session, not a change
    auth.clear()
    next = { ...me(['*']), tenant: tenant(3) }
    await auth.fetchMe()
    expect(reload).not.toHaveBeenCalled()
    // a session without tenant moved to tenant 2 (the permission reload assigns /me itself)
    auth.clear()
    next = me(['*'])
    await auth.fetchMe()
    auth.me = { ...me(['*']), tenant: tenant(2) }
    expect(reload).toHaveBeenCalledOnce()
  })

  it('a session ended by A1042 makes the sign-in page say why; a plain refusal does not; signing in clears it', async () => {
    setSessionHint(true)
    mockApi({ 'POST /auth/refresh': fail(401, Err.AUTH_REFRESH_REJECTED.code) })
    await expect(refreshAccessToken()).rejects.toMatchObject({
      code: Err.AUTH_REFRESH_REJECTED.code,
    })
    expect(sessionEnd.value).toBeNull()
    setSessionHint(true)
    mockApi({ 'POST /auth/refresh': fail(401, Err.AUTH_TENANT_INACTIVE.code) })
    await expect(refreshAccessToken()).rejects.toMatchObject({
      code: Err.AUTH_TENANT_INACTIVE.code,
    })
    expect(sessionEnd.value).toBe('tenant_unavailable')

    const { wrapper } = await open(LoginView, '/login', {
      'GET /auth/tenancy': ON,
      'POST /auth/login': TOKEN,
    })
    const text = 'Your tenant is disabled or has expired'
    expect(wrapper.text()).toContain(text)
    await signIn(wrapper)
    expect(sessionEnd.value).toBeNull()
    expect(wrapper.text()).not.toContain(text)
    wrapper.unmount()
  })

  it('a page dropping the session on that 401 (lock screen, SSO, password change) keeps the reason for the sign-in page', async () => {
    setSessionHint(true)
    mockApi({ 'POST /auth/refresh': fail(401, Err.AUTH_TENANT_INACTIVE.code) })
    await expect(refreshAccessToken()).rejects.toMatchObject({
      code: Err.AUTH_TENANT_INACTIVE.code,
    })
    useAuthStore().clear()
    expect(sessionEnd.value).toBe('tenant_unavailable')

    const { wrapper } = await open(LoginView, '/login', {})
    expect(wrapper.text()).toContain('Your tenant is disabled or has expired')
    wrapper.unmount()
  })

  it('a late A1042 of a request sent before the next sign-in says nothing', async () => {
    let answer!: (reply: ReturnType<typeof fail>) => void
    const calls = mockApi({
      'GET /auth/me': () => new Promise((resolve) => (answer = resolve)),
      'POST /auth/login': TOKEN,
    })
    const late = api.get('/auth/me', { silent: true }).catch((e: unknown) => e)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    await useAuthStore().login({ username: 'admin', password: 'Secret123!', keepSignedIn: false })
    answer(fail(401, Err.AUTH_TENANT_INACTIVE.code))
    expect(await late).toMatchObject({ status: 401, code: Err.AUTH_TENANT_INACTIVE.code })
    expect(sessionEnd.value).toBeNull()
    // neither refreshed nor replayed
    expect(calls.map((c) => c.url)).toEqual(['/auth/me', '/auth/login'])
  })
})
