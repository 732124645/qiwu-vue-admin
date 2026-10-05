import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import SmsLoginForm from '@/views/login/SmsLoginForm.vue'
import { fail, mockApi, ok } from './mock-api'

const openDialog = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | undefined>>())
vi.mock('@/core/dialog', () => ({ openDialog }))

const mode = (value: string) => ok({ key: 'captcha.mode', value })
const body = (call: { data?: unknown }) => JSON.parse(String(call.data))
const form = () => mount(SmsLoginForm, { global: { plugins: [createPinia(), i18n, ElementPlus] } })
const getCode = (wrapper: ReturnType<typeof form>) =>
  wrapper.findAll('button').find((b) => /Get code|Resend in/.test(b.text()))!

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = ''
  openDialog.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('SMS sign-in form', () => {
  it('validates the mobile alone, omits ticket in off mode, and counts down to resend', async () => {
    const calls = mockApi({
      'GET /settings/params/public/captcha.mode': mode('off'),
      'POST /auth/sms/code': ok({ cooldownSec: 2 }),
    })
    const wrapper = form()
    await getCode(wrapper).trigger('click')
    await flushPromises()
    expect(calls).toHaveLength(0)
    await wrapper.find('input[name="mobile"]').setValue('13800138000')
    vi.useFakeTimers()
    await getCode(wrapper).trigger('click')
    await flushPromises()
    expect(body(calls.find((c) => c.url === '/auth/sms/code')!)).toEqual({
      mobile: '13800138000',
      scene: 'signin',
    })
    expect(getCode(wrapper).attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('If this number has an account')
    await vi.advanceTimersByTimeAsync(2000)
    expect(getCode(wrapper).attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('includes only the ticket and does not send when the challenge closes', async () => {
    const calls = mockApi({
      'GET /settings/params/public/captcha.mode': mode('slider'),
      'POST /auth/sms/code': ok({ cooldownSec: 60 }),
    })
    const wrapper = form()
    await wrapper.find('input[name="mobile"]').setValue('13800138000')
    openDialog.mockResolvedValueOnce(undefined).mockResolvedValueOnce('ticket-s')
    await getCode(wrapper).trigger('click')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(0)
    await getCode(wrapper).trigger('click')
    await flushPromises()
    expect(openDialog.mock.calls[0]?.[1]).toEqual({ scene: 'sms_send' })
    expect(body(calls.find((c) => c.url === '/auth/sms/code')!)).toEqual({
      mobile: '13800138000',
      scene: 'signin',
      captchaTicket: 'ticket-s',
    })
    wrapper.unmount()
  })

  it('shows a 429 inline without starting a countdown', async () => {
    const calls = mockApi({
      'GET /settings/params/public/captcha.mode': mode('off'),
      'POST /auth/sms/code': fail(429, 'A0429', 'Please wait before requesting another code'),
    })
    const wrapper = form()
    await wrapper.find('input[name="mobile"]').setValue('13800138000')
    await getCode(wrapper).trigger('click')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(1)
    expect(wrapper.text()).toContain('Please wait before requesting another code')
    expect(getCode(wrapper).attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('signs in with the exact body, stores the token and emits done; failure does neither', async () => {
    let success = false
    const calls = mockApi({
      'POST /auth/sms/login': () =>
        success
          ? ok({ accessToken: 'sms-token', expiresIn: 900 })
          : fail(400, 'A0400', 'Code expired'),
    })
    const wrapper = form()
    await wrapper.find('input[name="mobile"]').setValue('13800138000')
    await wrapper.find('input[name="code"]').setValue('123456')
    await wrapper.find('input[type="checkbox"]').setValue(true)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(body(calls[0]!)).toEqual({ mobile: '13800138000', code: '123456', keepSignedIn: true })
    expect(wrapper.text()).toContain('Code expired')
    expect(accessToken.value).toBe('')
    expect(wrapper.emitted('done')).toBeUndefined()
    success = true
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(calls).toHaveLength(2)
    expect(accessToken.value).toBe('sms-token')
    expect(wrapper.emitted('done')).toEqual([[]])
    wrapper.unmount()
  })

  it('disables submit while sign-in is pending and sends once', async () => {
    let release!: (reply: ReturnType<typeof ok>) => void
    const pending = new Promise<ReturnType<typeof ok>>((resolve) => {
      release = resolve
    })
    const calls = mockApi({ 'POST /auth/sms/login': () => pending })
    const wrapper = form()
    await wrapper.find('input[name="mobile"]').setValue('13800138000')
    await wrapper.find('input[name="code"]').setValue('123456')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    const submit = wrapper.find('button[type="submit"]')
    expect(submit.attributes('disabled')).toBeDefined()
    await wrapper.find('form').trigger('submit')
    expect(calls).toHaveLength(1)
    release(ok({ accessToken: 'sms-token', expiresIn: 900 }))
    await flushPromises()
    wrapper.unmount()
  })
})
