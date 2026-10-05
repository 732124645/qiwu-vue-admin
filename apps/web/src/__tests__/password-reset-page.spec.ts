import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { i18n, setLocale } from '@/core/i18n'
import PasswordResetView from '@/views/password-reset/index.vue'
import { fail, mockApi, ok } from './mock-api'

const openDialog = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | undefined>>())
vi.mock('@/core/dialog', () => ({ openDialog }))

const body = (call: { data?: unknown }) => JSON.parse(String(call.data))
async function page() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/password-reset', component: PasswordResetView },
      { path: '/login', component: { template: '<div />' } },
    ],
  })
  await router.push('/password-reset')
  const wrapper = mount(PasswordResetView, {
    global: { plugins: [createPinia(), router, i18n, ElementPlus] },
  })
  return { wrapper, router }
}
async function fill(wrapper: Awaited<ReturnType<typeof page>>['wrapper']) {
  await wrapper.find('input[name="mobile"]').setValue('13800138000')
  await wrapper.find('input[name="code"]').setValue('123456')
  await wrapper.find('input[name="newPassword"]').setValue('Secret123!')
  await wrapper.find('input[name="confirmPassword"]').setValue('Secret123!')
}

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  openDialog.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('password reset by SMS', () => {
  it('sends an OTP for reset_password with the sms_send CAPTCHA ticket', async () => {
    const calls = mockApi({
      'GET /settings/params/public/captcha.mode': ok({ key: 'captcha.mode', value: 'slider' }),
      'POST /auth/sms/code': ok({ cooldownSec: 60 }),
    })
    openDialog.mockResolvedValue('ticket-r')
    const { wrapper } = await page()
    await wrapper.find('input[name="mobile"]').setValue('13800138000')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Get code')!
      .trigger('click')
    await flushPromises()
    expect(openDialog.mock.calls[0]?.[1]).toEqual({ scene: 'sms_send' })
    expect(body(calls.find((c) => c.url === '/auth/sms/code')!)).toEqual({
      mobile: '13800138000',
      scene: 'reset_password',
      captchaTicket: 'ticket-r',
    })
    wrapper.unmount()
  })

  it('blocks mismatched confirmation, then resets with only the three contract fields and navigates', async () => {
    const calls = mockApi({ 'POST /auth/password/reset-by-sms': ok(null) })
    const { wrapper, router } = await page()
    await fill(wrapper)
    await wrapper.find('input[name="confirmPassword"]').setValue('Wrong123!')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)
    await wrapper.find('input[name="confirmPassword"]').setValue('Secret123!')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(body(calls.find((c) => c.url === '/auth/password/reset-by-sms')!)).toEqual({
      mobile: '13800138000',
      code: '123456',
      newPassword: 'Secret123!',
    })
    expect(router.currentRoute.value.path).toBe('/login')
    wrapper.unmount()
  })

  it('shows the translated server error inline and stays on the page', async () => {
    const calls = mockApi({
      'POST /auth/password/reset-by-sms': fail(400, 'A0400', 'A stricter password is required'),
    })
    const { wrapper, router } = await page()
    await fill(wrapper)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(1)
    expect(wrapper.text()).toContain('A stricter password is required')
    expect(router.currentRoute.value.path).toBe('/password-reset')
    wrapper.unmount()
  })

  it('accepts an eight-character lowercase password when one class is configured', async () => {
    const calls = mockApi({
      'GET /settings/params/public/iam.password_char_classes': ok({
        key: 'iam.password_char_classes',
        value: '1',
      }),
      'POST /auth/password/reset-by-sms': ok(null),
    })
    const { wrapper } = await page()
    await flushPromises()
    await fill(wrapper)
    await wrapper.find('input[name="newPassword"]').setValue('abcdefgh')
    await wrapper.find('input[name="confirmPassword"]').setValue('abcdefgh')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(body(calls.find((c) => c.url === '/auth/password/reset-by-sms')!)).toMatchObject({
      newPassword: 'abcdefgh',
    })
    wrapper.unmount()
  })

  it('rejects a ten-character password when twelve characters are configured', async () => {
    const calls = mockApi({
      'GET /settings/params/public/iam.password_min_length': ok({
        key: 'iam.password_min_length',
        value: '12',
      }),
    })
    const { wrapper } = await page()
    await flushPromises()
    await fill(wrapper)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)
    wrapper.unmount()
  })
})
