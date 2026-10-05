// Captcha flow of the sign-in page: the mode decides whether to ask, a closed popup sends nothing, the
// server's "captcha required" asks once more.
import { beforeEach, expect, it, vi } from 'vitest'
import { Err } from '@qiwu/shared'
import { captchaMode, withCaptcha } from '@/core/captcha'
import { ApiError } from '@/core/request'

/** The public `captcha.mode` parameter answers `mode` (null: the request fails). */
function modeIs(mode: string | null) {
  vi.mocked(uni.request).mockImplementation((o) => {
    if (mode === null) o.fail?.({ errMsg: 'request:fail' })
    else
      o.success?.({
        statusCode: 200,
        data: { code: 0, msg: 'ok', data: { key: 'captcha.mode', value: mode } },
      } as never)
    return {} as UniApp.RequestTask
  })
}
const required = new ApiError(403, Err.AUTH_CAPTCHA_REQUIRED.code, 'captcha required')
const isRequired = (e: unknown) => e === required

beforeEach(() => vi.clearAllMocks())

it('reads the mode: unknown → slider, unreadable → off', async () => {
  modeIs('image')
  expect(await captchaMode()).toBe('image')
  modeIs('bogus')
  expect(await captchaMode()).toBe('slider')
  modeIs(null)
  expect(await captchaMode()).toBe('off')
})

it('off: sends without asking; on: sends the ticket, or nothing when closed', async () => {
  const ask = vi.fn().mockResolvedValue('ticket-1')
  const send = vi.fn().mockResolvedValue('ok')
  modeIs('off')
  expect(await withCaptcha(ask, 'signin', send)).toBe('ok')
  expect(ask).not.toHaveBeenCalled()
  expect(send).toHaveBeenLastCalledWith(undefined)

  modeIs('slider')
  expect(await withCaptcha(ask, 'sms_send', send)).toBe('ok')
  expect(ask).toHaveBeenLastCalledWith('sms_send')
  expect(send).toHaveBeenLastCalledWith('ticket-1')

  ask.mockResolvedValueOnce(undefined)
  send.mockClear()
  expect(await withCaptcha(ask, 'signin', send)).toBeUndefined()
  expect(send).not.toHaveBeenCalled()
})

it('asks once more when the server demands a captcha; other errors are rethrown', async () => {
  modeIs('off')
  const ask = vi.fn().mockResolvedValue('ticket-2')
  const send = vi.fn().mockRejectedValueOnce(required).mockResolvedValueOnce('ok')
  expect(await withCaptcha(ask, 'signin', send, isRequired)).toBe('ok')
  expect(send.mock.calls).toEqual([[undefined], ['ticket-2']])

  const other = new ApiError(400, 'A1002', 'wrong password')
  await expect(
    withCaptcha(ask, 'signin', vi.fn().mockRejectedValue(other), isRequired),
  ).rejects.toBe(other)
  // closed on the retry: nothing more is sent
  ask.mockResolvedValueOnce(undefined)
  const again = vi.fn().mockRejectedValueOnce(required)
  expect(await withCaptcha(ask, 'signin', again, isRequired)).toBeUndefined()
  expect(again).toHaveBeenCalledTimes(1)
})
