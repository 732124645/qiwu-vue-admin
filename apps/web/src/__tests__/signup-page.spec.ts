import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { i18n, setLocale } from '@/core/i18n'
import RegisterView from '@/views/register/index.vue'
import { fail, mockApi, ok } from './mock-api'

const openDialog = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | undefined>>())
vi.mock('@/core/dialog', () => ({ openDialog }))

const setting = (value: string) => ok({ key: 'auth.signup.enabled', value })
const mode = (value: string) => ok({ key: 'captcha.mode', value })
const body = (call: { data?: unknown }) => JSON.parse(String(call.data))

async function page() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/register', component: RegisterView },
      { path: '/login', component: { template: '<div />' } },
    ],
  })
  await router.push('/register')
  const wrapper = mount(RegisterView, {
    global: { plugins: [createPinia(), router, i18n, ElementPlus] },
  })
  await flushPromises()
  return { wrapper, router }
}

async function fill(wrapper: Awaited<ReturnType<typeof page>>['wrapper'], displayName = '') {
  await wrapper.find('input[name="username"]').setValue('new.user')
  await wrapper.find('input[name="displayName"]').setValue(displayName)
  await wrapper.find('input[name="password"]').setValue('Secret123!')
  await wrapper.find('input[name="confirmPassword"]').setValue('Secret123!')
}

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  openDialog.mockReset()
})
afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('sign-up page', () => {
  it.each([{ answer: setting('false') }, { answer: fail(404, 'A0440') }])(
    'keeps the form closed when the switch is off or missing',
    async ({ answer }) => {
      const calls = mockApi({ 'GET /settings/params/public/auth.signup.enabled': answer })
      const { wrapper } = await page()
      expect(wrapper.find('form').exists()).toBe(false)
      expect(wrapper.text()).toContain('Sign-up is not open')
      expect(wrapper.find('a[href="/login"]').exists()).toBe(true)
      expect(calls.map((c) => c.url)).toEqual(['/settings/params/public/auth.signup.enabled'])
      wrapper.unmount()
    },
  )

  it('rejects invalid fields and sends only the contract body in off mode', async () => {
    const calls = mockApi({
      'GET /settings/params/public/auth.signup.enabled': setting('true'),
      'GET /settings/params/public/captcha.mode': mode('off'),
      'POST /auth/signup': ok(null),
    })
    const { wrapper, router } = await page()
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)
    await fill(wrapper)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(body(calls.find((c) => c.url === '/auth/signup')!)).toEqual({
      username: 'new.user',
      password: 'Secret123!',
    })
    expect(router.currentRoute.value.path).toBe('/login')
    wrapper.unmount()
  })

  it('sends only the CAPTCHA ticket with a display name; closing the dialog sends nothing', async () => {
    const calls = mockApi({
      'GET /settings/params/public/auth.signup.enabled': setting('true'),
      'GET /settings/params/public/captcha.mode': mode('slider'),
      'POST /auth/signup': ok(null),
    })
    const { wrapper } = await page()
    await fill(wrapper, 'New User')
    openDialog.mockResolvedValueOnce(undefined).mockResolvedValueOnce('ticket-1')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(openDialog.mock.calls[0]?.[1]).toEqual({ scene: 'signup' })
    expect(body(calls.find((c) => c.url === '/auth/signup')!)).toEqual({
      username: 'new.user',
      password: 'Secret123!',
      displayName: 'New User',
      captchaTicket: 'ticket-1',
    })
    wrapper.unmount()
  })

  it('shows the server message inline and stays on sign-up', async () => {
    const calls = mockApi({
      'GET /settings/params/public/auth.signup.enabled': setting('true'),
      'GET /settings/params/public/captcha.mode': mode('off'),
      'POST /auth/signup': fail(400, 'A0400', 'A stricter password is required'),
    })
    const { wrapper, router } = await page()
    await fill(wrapper)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(1)
    expect(wrapper.text()).toContain('A stricter password is required')
    expect(router.currentRoute.value.path).toBe('/register')
    wrapper.unmount()
  })

  it('accepts an eight-character lowercase password when one class is configured', async () => {
    const calls = mockApi({
      'GET /settings/params/public/auth.signup.enabled': setting('true'),
      'GET /settings/params/public/iam.password_char_classes': ok({
        key: 'iam.password_char_classes',
        value: '1',
      }),
      'GET /settings/params/public/captcha.mode': mode('off'),
      'POST /auth/signup': ok(null),
    })
    const { wrapper } = await page()
    await fill(wrapper)
    await wrapper.find('input[name="password"]').setValue('abcdefgh')
    await wrapper.find('input[name="confirmPassword"]').setValue('abcdefgh')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(body(calls.find((c) => c.url === '/auth/signup')!)).toMatchObject({
      password: 'abcdefgh',
    })
    wrapper.unmount()
  })

  it('rejects a ten-character password when twelve characters are configured', async () => {
    const calls = mockApi({
      'GET /settings/params/public/auth.signup.enabled': setting('true'),
      'GET /settings/params/public/iam.password_min_length': ok({
        key: 'iam.password_min_length',
        value: '12',
      }),
    })
    const { wrapper } = await page()
    await fill(wrapper)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)
    wrapper.unmount()
  })
})
