import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { Slide } from 'go-captcha-vue'
import { type CaptchaChallengeVo } from '@qiwu/shared'
import CaptchaDialog from '@/core/components/CaptchaDialog.vue'
import { captchaMode, withCaptcha } from '@/core/captcha'
import { i18n, setLocale } from '@/core/i18n'
import { ApiError } from '@/core/request/http'
import { fail, mockApi, ok, type Route } from './mock-api'

const openDialog = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | undefined>>())
vi.mock('@/core/dialog', () => ({ openDialog }))

const id = '0123456789abcdef'
const image: CaptchaChallengeVo = { kind: 'image', id, image: 'data:image/svg+xml;base64,PHN2Zy8+' }
const slider: CaptchaChallengeVo = {
  kind: 'slider',
  id,
  image: 'data:image/png;base64,YmFjaw==',
  thumb: 'data:image/png;base64,dGlsZQ==',
  thumbX: 11,
  thumbY: 32,
  thumbWidth: 45,
  thumbHeight: 47,
}
const mountDialog = async () => {
  const wrapper = mount(CaptchaDialog, {
    props: { scene: 'signin' },
    global: { plugins: [ElementPlus, i18n] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}
const body = (call: { data?: unknown }) => JSON.parse(String(call.data)) as Record<string, unknown>

beforeEach(() => {
  setLocale('en-US')
  openDialog.mockReset()
})
afterEach(() => {
  document.body.innerHTML = ''
  setLocale('zh-CN')
  vi.restoreAllMocks()
})

describe('CaptchaDialog', () => {
  it('renders the image and sends only a trimmed answer, then emits only the ticket', async () => {
    const calls = mockApi({
      'GET /auth/captcha': ok(image),
      'POST /auth/captcha/check': ok({ captchaTicket: 'ticket-1' }),
    })
    const wrapper = await mountDialog()
    expect(wrapper.find('img[alt="Verification image"]').attributes('src')).toBe(image.image)
    expect(calls[0]?.params).toEqual({ scene: 'signin' })
    await wrapper.find('input').setValue(' 42 ')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Confirm')!
      .trigger('click')
    await flushPromises()
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(1)
    expect(body(calls[1]!)).toEqual({ id, answer: '42' })
    expect(wrapper.emitted('done')).toEqual([['ticket-1']])
    wrapper.unmount()
  })

  it('consumes a wrong answer, clears input, loads a new challenge, and shows the server message', async () => {
    let gets = 0
    const calls = mockApi({
      'GET /auth/captcha': () => ok({ ...image, id: gets++ ? 'fedcba9876543210' : id }),
      'POST /auth/captcha/check': fail(422, 'A0422', 'Wrong answer'),
    })
    const wrapper = await mountDialog()
    await wrapper.find('input').setValue('wrong')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Confirm')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Wrong answer')
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('')
    expect(calls.filter((c) => c.method === 'get')).toHaveLength(2)
    expect(wrapper.emitted('done')).toBeUndefined()
    wrapper.unmount()
  })

  it('blocks duplicate confirmation while a check is pending', async () => {
    let release!: (reply: ReturnType<typeof ok>) => void
    const pending = new Promise<ReturnType<typeof ok>>((resolve) => {
      release = resolve
    })
    const calls = mockApi({
      'GET /auth/captcha': ok(image),
      'POST /auth/captcha/check': () => pending,
    })
    const wrapper = await mountDialog()
    await wrapper.find('input').setValue('42')
    const confirm = wrapper.findAll('button').find((b) => b.text() === 'Confirm')!
    await confirm.trigger('click')
    expect(confirm.attributes('disabled')).toBeDefined()
    expect(wrapper.findAllComponents({ name: 'ElButton' }).at(-1)?.props('loading')).toBe(true)
    await confirm.trigger('click')
    expect(calls.filter((c) => c.method === 'post')).toHaveLength(1)
    release(ok({ captchaTicket: 'ticket-1' }))
    await flushPromises()
    wrapper.unmount()
  })

  it('passes slider geometry, checks its coordinates, refreshes, closes, and changes title live', async () => {
    const calls = mockApi({
      'GET /auth/captcha': ok(slider),
      'POST /auth/captcha/check': ok({ captchaTicket: 'ticket-s' }),
    })
    const wrapper = await mountDialog()
    const slide = wrapper.findComponent(Slide)
    expect(slide.props('data')).toEqual({
      image: slider.image,
      thumb: slider.thumb,
      thumbX: slider.thumbX,
      thumbY: slider.thumbY,
      thumbWidth: slider.thumbWidth,
      thumbHeight: slider.thumbHeight,
    })
    expect(slide.props('config')).toMatchObject({
      width: 300,
      height: 220,
      title: 'Drag the piece into place',
    })
    setLocale('zh-CN')
    await flushPromises()
    expect(slide.find('.gc-header span').text()).toBe('拖动拼图完成验证')
    slide.props('events').confirm({ x: 106, y: 32 }, () => {})
    await flushPromises()
    expect(body(calls.find((c) => c.method === 'post')!)).toEqual({ id, answer: { x: 106, y: 32 } })
    expect(wrapper.emitted('done')).toEqual([['ticket-s']])
    slide.props('events').refresh()
    await flushPromises()
    expect(calls.filter((c) => c.method === 'get')).toHaveLength(2)
    slide.props('events').close()
    expect(wrapper.emitted('cancel')).toEqual([[]])
    wrapper.unmount()
  })

  it('offers retry after a load failure', async () => {
    let attempts = 0
    const calls = mockApi({
      'GET /auth/captcha': () => (attempts++ ? ok(image) : fail(503, 'A0500')),
    })
    const wrapper = await mountDialog()
    expect(wrapper.text()).toContain('Could not load the verification challenge')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Try again')!
      .trigger('click')
    await flushPromises()
    expect(calls).toHaveLength(2)
    expect(wrapper.find('img[alt="Verification image"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('captcha helpers', () => {
  const params = (route: Route) => mockApi({ 'GET /settings/params/public/captcha.mode': route })
  it('reads off, image, unknown and 404 without caching', async () => {
    let value = 'off'
    const calls = params(() => ok({ key: 'captcha.mode', value }))
    expect(await captchaMode()).toBe('off')
    value = 'image'
    expect(await captchaMode()).toBe('image')
    value = 'unknown'
    expect(await captchaMode()).toBe('slider')
    expect(calls).toHaveLength(3)
    params(fail(404, 'A0440'))
    expect(await captchaMode()).toBe('off')
  })

  it('sends without a ticket when off and retries a matching server escalation once', async () => {
    params(ok({ key: 'captcha.mode', value: 'off' }))
    const send = vi
      .fn<(ticket?: string) => Promise<string>>()
      .mockRejectedValueOnce(new ApiError(422, 'CAPTCHA_REQUIRED', 'Required'))
      .mockResolvedValueOnce('ok')
    openDialog.mockResolvedValue('ticket-2')
    expect(
      await withCaptcha(
        'signin',
        send,
        (e) => e instanceof ApiError && e.code === 'CAPTCHA_REQUIRED',
      ),
    ).toBe('ok')
    expect(send.mock.calls).toEqual([[undefined], ['ticket-2']])
    expect(openDialog).toHaveBeenCalledOnce()
  })

  it('passes the ticket in slider mode and sends nothing when closed', async () => {
    params(ok({ key: 'captcha.mode', value: 'slider' }))
    const send = vi.fn<(ticket?: string) => Promise<string>>().mockResolvedValue('ok')
    openDialog.mockResolvedValueOnce('ticket-3').mockResolvedValueOnce(undefined)
    expect(await withCaptcha('signup', send)).toBe('ok')
    expect(send).toHaveBeenCalledWith('ticket-3')
    expect(openDialog).toHaveBeenCalledWith(CaptchaDialog, { scene: 'signup' }, expect.anything())
    expect(await withCaptcha('signup', send)).toBeUndefined()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sends once without a ticket when off and rethrows unmatched errors', async () => {
    params(ok({ key: 'captcha.mode', value: 'off' }))
    const send = vi
      .fn<(ticket?: string) => Promise<string>>()
      .mockResolvedValueOnce('ok')
      .mockRejectedValueOnce(new Error('unmatched'))
    expect(await withCaptcha('signin', send)).toBe('ok')
    await expect(withCaptcha('signin', send, () => false)).rejects.toThrow('unmatched')
    expect(send.mock.calls).toEqual([[undefined], [undefined]])
    expect(openDialog).not.toHaveBeenCalled()
  })
})
