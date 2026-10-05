// App update check: App only; the versions it sends; silent on none or an error; wgt download →
// install (never forced over a newer one) → restart; full package → its link; forced → no "later", asked again.
import type { AppUpdateVo } from '@qiwu/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { t } from '@/core/i18n'
import { checkUpdate } from '@/core/update'

type Modal = Parameters<typeof uni.showModal>[0]
type Done = (d: { filename?: string }, status: number) => void
const modal = vi.fn<(o: Modal) => void>()
const start = vi.fn()
const createDownload = vi.fn((_url: string, _o: object, done: Done) => {
  downloaded = done
  return { start }
})
let downloaded: Done = () => {}
const runtime = {
  appid: '__UNI__QIWU',
  version: '1.0.0',
  getProperty: vi.fn((_id: string, cb: (info: { version?: string }) => void) =>
    cb({ version: '1.0.1' }),
  ),
  install: vi.fn(),
  restart: vi.fn(),
  openURL: vi.fn(),
}
const os = { name: 'Android' }
const WGT: AppUpdateVo = {
  version: '1.2.0',
  packageKind: 'wgt',
  url: 'https://example.com/qiwu-1.2.0.wgt',
  force: false,
  notes: null,
}

const reply = (statusCode: number, data: unknown) =>
  vi.mocked(uni.request).mockImplementation((o) => {
    o.success?.({ statusCode, data } as never)
    return {} as UniApp.RequestTask
  })
const offering = (vo: AppUpdateVo | null) => reply(200, { code: 0, msg: 'ok', data: vo })
/** the latest prompt's answer */
const answer = (confirm: boolean) =>
  modal.mock.lastCall![0]!.success!({ confirm, cancel: !confirm } as never)
const toasts = () => vi.mocked(uni.showToast).mock.calls.map(([o]) => o?.title)

beforeEach(() => {
  process.env.UNI_PLATFORM = 'app'
  os.name = 'Android'
  vi.mocked(uni.request).mockReset()
  vi.mocked(uni.showToast).mockClear()
  for (const f of [modal, start, createDownload, ...Object.values(runtime)])
    if (typeof f === 'function') f.mockClear()
  vi.stubGlobal('plus', { os, runtime, downloader: { createDownload } })
  Object.assign(uni, { showModal: modal, showLoading: vi.fn(), hideLoading: vi.fn() })
  offering(WGT)
})

afterEach(() => {
  delete process.env.UNI_PLATFORM
})

it('H5 and the mini program: no check at all', async () => {
  for (const platform of ['h5', 'mp-weixin'] as const) {
    process.env.UNI_PLATFORM = platform
    await checkUpdate()
  }
  expect(uni.request).not.toHaveBeenCalled()
  expect(runtime.getProperty).not.toHaveBeenCalled()
})

it('App: platform, resource version and native version, silently; other systems none', async () => {
  await checkUpdate()
  expect(vi.mocked(uni.request).mock.calls[0]![0]).toMatchObject({
    url: '/api/settings/app-versions/latest',
    method: 'GET',
    data: { platform: 'android', version: '1.0.1', nativeVersion: '1.0.0' },
  })
  os.name = 'iOS'
  await checkUpdate()
  expect(vi.mocked(uni.request).mock.calls[1]![0].data).toMatchObject({ platform: 'ios' })
  os.name = 'HarmonyOS'
  await checkUpdate()
  expect(uni.request).toHaveBeenCalledTimes(2)
})

it('nothing newer, or an error: no prompt, no toast, no throw', async () => {
  offering(null)
  await checkUpdate()
  reply(500, { code: 'B0001', msg: 'down' })
  await checkUpdate()
  vi.mocked(uni.request).mockImplementation((o) => {
    o.fail?.({ errMsg: 'request:fail' } as never)
    return {} as UniApp.RequestTask
  })
  await checkUpdate()
  expect(modal).not.toHaveBeenCalled()
  expect(uni.showToast).not.toHaveBeenCalled()
})

it('optional wgt: the prompt with "later"; later → nothing downloaded', async () => {
  await checkUpdate()
  expect(modal).toHaveBeenCalledTimes(1)
  expect(modal.mock.lastCall![0]).toMatchObject({
    title: t('update.title', { version: '1.2.0' }),
    content: t('update.content'),
    showCancel: true,
  })
  expect(t('update.title', { version: '1.2.0' })).toContain('1.2.0')
  answer(false)
  expect(createDownload).not.toHaveBeenCalled()
  expect(modal).toHaveBeenCalledTimes(1)
})

it('wgt: download → install (not forced over a newer one) → restart', async () => {
  await checkUpdate()
  answer(true)
  expect(createDownload).toHaveBeenCalledWith(
    WGT.url,
    { filename: '_doc/update/' },
    expect.any(Function),
  )
  expect(start).toHaveBeenCalled()
  downloaded({ filename: '_doc/update/qiwu.wgt' }, 200)
  expect(runtime.install).toHaveBeenCalledWith(
    '_doc/update/qiwu.wgt',
    { force: false },
    expect.any(Function),
    expect.any(Function),
  )
  expect(runtime.restart).not.toHaveBeenCalled()
  runtime.install.mock.lastCall![2]()
  expect(runtime.restart).toHaveBeenCalledTimes(1)
})

it('wgt: a failed download or install → a toast, no restart', async () => {
  await checkUpdate()
  answer(true)
  downloaded({ filename: '_doc/update/x' }, 404)
  expect(runtime.install).not.toHaveBeenCalled()
  answer(false)
  await checkUpdate()
  answer(true)
  downloaded({ filename: '_doc/update/x' }, 200)
  runtime.install.mock.lastCall![3]({ code: -1205 })
  expect(runtime.restart).not.toHaveBeenCalled()
  expect(toasts()).toEqual([t('update.failed'), t('update.failed')])
  expect(t('update.failed')).not.toBe('update.failed')
})

it('forced: no "later", the notes shown, asked again after a failure', async () => {
  offering({ ...WGT, force: true, notes: 'security fix' })
  await checkUpdate()
  expect(modal.mock.lastCall![0]).toMatchObject({ showCancel: false, content: 'security fix' })
  answer(true)
  downloaded({}, 500)
  expect(modal).toHaveBeenCalledTimes(2)
})

it('full package: opens its link; forced → asked again', async () => {
  const full = { ...WGT, packageKind: 'full' as const, url: 'https://apps.apple.com/app/id1' }
  offering(full)
  await checkUpdate()
  answer(true)
  expect(runtime.openURL).toHaveBeenCalledWith(full.url)
  expect(createDownload).not.toHaveBeenCalled()
  expect(modal).toHaveBeenCalledTimes(1)
  modal.mockClear()
  offering({ ...full, force: true })
  await checkUpdate()
  answer(true)
  expect(modal).toHaveBeenCalledTimes(2)
  answer(false)
  expect(modal).toHaveBeenCalledTimes(3)
})
