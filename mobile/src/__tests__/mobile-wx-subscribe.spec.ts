// WeChat subscribe messages: the template ids only on the mini program, the request straight
// from the tap with at most 3 ids, a toast by WeChat's answer.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { t } from '@/core/i18n'
import { loadSubscribeIds, requestSubscribe } from '@/core/wx-subscribe'

const URL = '/api/iam/profile/socials/wx-mp/subscribe'
type Options = Parameters<typeof uni.requestSubscribeMessage>[0]
const ask = vi.fn<(o: Options) => void>()
const toasts = () => vi.mocked(uni.showToast).mock.calls.map(([o]) => o?.title)

beforeEach(() => {
  vi.mocked(uni.request).mockReset()
  vi.mocked(uni.request).mockImplementation((o) => {
    o.success?.({
      statusCode: 200,
      data: { code: 0, msg: 'ok', data: { templateIds: ['a', 'b'] } },
    } as never)
    return {} as UniApp.RequestTask
  })
  vi.mocked(uni.showToast).mockClear()
  ask.mockReset()
  ;(uni as unknown as { requestSubscribeMessage: typeof ask }).requestSubscribeMessage = ask
})

afterEach(() => {
  delete process.env.UNI_PLATFORM
})

it('H5 and App: no request, no ids', async () => {
  for (const platform of [undefined, 'h5', 'app'] as const) {
    if (platform) process.env.UNI_PLATFORM = platform
    expect(await loadSubscribeIds()).toEqual([])
  }
  expect(uni.request).not.toHaveBeenCalled()
})

it('mini program: the ids from the server, silently none on an error', async () => {
  process.env.UNI_PLATFORM = 'mp-weixin'
  expect(await loadSubscribeIds()).toEqual(['a', 'b'])
  expect(vi.mocked(uni.request).mock.calls[0]![0]).toMatchObject({ url: URL })
  vi.mocked(uni.request).mockImplementation((o) => {
    o.success?.({ statusCode: 500, data: { code: 'B0001', msg: 'down' } } as never)
    return {} as UniApp.RequestTask
  })
  expect(await loadSubscribeIds()).toEqual([])
  expect(uni.showToast).not.toHaveBeenCalled()
})

it('asks for at most 3 ids at once, synchronously; on when one is accepted', () => {
  requestSubscribe(['a', 'b', 'c', 'd'])
  expect(ask).toHaveBeenCalledTimes(1)
  const o = ask.mock.calls[0]![0]
  expect(o.tmplIds).toEqual(['a', 'b', 'c'])
  o.success!({ errMsg: 'requestSubscribeMessage:ok', a: 'reject', c: 'accept' } as never)
  o.success!({ errMsg: 'requestSubscribeMessage:ok', a: 'reject', d: 'accept' } as never)
  o.fail!({ errMsg: 'requestSubscribeMessage:fail', errCode: 20004 })
  expect(toasts()).toEqual([t('mine.wxRemindOn'), t('mine.wxRemindOff'), t('mine.wxRemindOff')])
  expect(t('mine.wxRemindOn')).not.toBe('mine.wxRemindOn')
})
