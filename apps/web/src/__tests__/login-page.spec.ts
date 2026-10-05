import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import SmsLoginForm from '@/views/login/SmsLoginForm.vue'
import LoginView from '@/views/login/index.vue'
import { fail, mockApi, ok, type Route } from './mock-api'

const openDialog = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | undefined>>())
vi.mock('@/core/dialog', () => ({ openDialog }))

const setting = (key: string, value: string) => ok({ key, value })
const body = (call: { data?: unknown }) => JSON.parse(String(call.data))

async function page(
  mode: string,
  login: Route = ok({ accessToken: 'at-1', expiresIn: 900 }),
  signup = 'false',
) {
  const calls = mockApi({
    'GET /settings/params/public/auth.signup.enabled': setting('auth.signup.enabled', signup),
    'GET /settings/params/public/captcha.mode': setting('captcha.mode', mode),
    'POST /auth/login': login,
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', component: LoginView },
      { path: '/home', component: { template: '<div />' } },
      { path: '/register', component: { template: '<div />' } },
      { path: '/password-reset', component: { template: '<div />' } },
    ],
  })
  await router.push('/login?redirect=/home')
  const wrapper = mount(LoginView, {
    global: { plugins: [createPinia(), router, i18n, ElementPlus] },
  })
  await flushPromises()
  return { wrapper, router, calls }
}

async function submit(wrapper: Awaited<ReturnType<typeof page>>['wrapper']) {
  await wrapper.find('input[name="username"]').setValue('admin')
  await wrapper.find('input[name="password"]').setValue('Secret123!')
  await wrapper.find('form').trigger('submit')
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = ''
  openDialog.mockReset()
})
afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('sign-in page', () => {
  it('shows the sign-up route when the switch is enabled', async () => {
    const { wrapper, router } = await page('off', ok(null), 'true')
    expect(wrapper.find('a[href="/register"]').exists()).toBe(true)
    await wrapper.find('a[href="/register"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/register')
    wrapper.unmount()
  })

  it('off mode sends no ticket, hides sign-up, and links to password reset', async () => {
    const { wrapper, router, calls } = await page('off')
    expect(wrapper.find('a[href="/register"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/password-reset"]').exists()).toBe(true)
    await submit(wrapper)
    expect(body(calls.find((call) => call.url === '/auth/login')!)).toEqual({
      username: 'admin',
      password: 'Secret123!',
      keepSignedIn: false,
    })
    expect(openDialog).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/home')
    wrapper.unmount()
  })

  it('slider mode sends only a ticket; closing the dialog sends nothing', async () => {
    const { wrapper, calls } = await page('slider')
    openDialog.mockResolvedValueOnce(undefined).mockResolvedValueOnce('ticket-1')
    await submit(wrapper)
    expect(calls.filter((call) => call.url === '/auth/login')).toHaveLength(0)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(openDialog.mock.calls[0]?.[1]).toEqual({ scene: 'signin' })
    expect(body(calls.find((call) => call.url === '/auth/login')!)).toMatchObject({
      captchaTicket: 'ticket-1',
    })
    wrapper.unmount()
  })

  it('retries A1021 once with a ticket even when mode is off', async () => {
    let attempts = 0
    const { wrapper, router, calls } = await page('off', () =>
      ++attempts === 1 ? fail(403, 'A1021') : ok({ accessToken: 'at-1', expiresIn: 900 }),
    )
    openDialog.mockResolvedValue('ticket-2')
    await submit(wrapper)
    expect(calls.filter((call) => call.url === '/auth/login').map(body)).toEqual([
      { username: 'admin', password: 'Secret123!', keepSignedIn: false },
      { username: 'admin', password: 'Secret123!', keepSignedIn: false, captchaTicket: 'ticket-2' },
    ])
    expect(router.currentRoute.value.path).toBe('/home')
    wrapper.unmount()
  })

  it('SMS done uses the same safe redirect', async () => {
    const { wrapper, router } = await page('off')
    // the SMS pane mounts on first use
    expect(wrapper.findComponent(SmsLoginForm).exists()).toBe(false)
    await wrapper.find('#tab-sms').trigger('click')
    await flushPromises()
    wrapper.findComponent(SmsLoginForm).vm.$emit('done')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/home')
    wrapper.unmount()
  })
})
