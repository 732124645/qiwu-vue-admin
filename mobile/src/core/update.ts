// App version check (App only): on launch the App asks the server for a newer release of its
// platform. A wgt (resource package) downloads, installs in place and restarts the App; a full package opens
// its link (Android: the browser downloads the installer; iOS: the App Store page). Forced: no "later", and
// the prompt comes back until updated. The mini program needs none (WeChat updates it on a cold start), H5
// neither. Any failure on the way (offline, check off, older server) is silent: the App just runs.
// No checksum of the package beyond HTTPS; add a sha256 column + check if packages leave our host
import type { AppUpdateVo } from '@qiwu/shared'
import { t } from './i18n'
import { api } from './request'

/** Called once from App.vue onLaunch; resolves when the prompt (if any) is shown. */
export async function checkUpdate(): Promise<void> {
  if (process.env.UNI_PLATFORM !== 'app') return
  const platform = plus.os.name?.toLowerCase()
  if (platform !== 'android' && platform !== 'ios') return
  try {
    // the resource version (a wgt raises it), the native one only by a new installer
    const version = await new Promise<string | undefined>((resolve) =>
      plus.runtime.getProperty(plus.runtime.appid ?? '', (info) => resolve(info.version)),
    )
    const vo = await api.get<AppUpdateVo | null>(
      '/settings/app-versions/latest',
      { platform, version, nativeVersion: plus.runtime.version },
      { silent: true },
    )
    if (vo) offer(vo)
  } catch {
    // no prompt
  }
}

function offer(vo: AppUpdateVo): void {
  uni.showModal({
    title: t('update.title', { version: vo.version }),
    content: vo.notes || t('update.content'),
    showCancel: !vo.force,
    confirmText: t('update.now'),
    cancelText: t('update.later'),
    success: ({ confirm }) => {
      if (confirm && vo.packageKind === 'wgt') return install(vo)
      if (confirm) plus.runtime.openURL(vo.url)
      // forced: back to the prompt (after the store / browser, or a dismissed dialog)
      if (vo.force) offer(vo)
    },
  })
}

function install(vo: AppUpdateVo): void {
  uni.showLoading({ title: t('update.downloading'), mask: true })
  const failed = () => {
    uni.hideLoading()
    uni.showToast({ title: t('update.failed'), icon: 'none' })
    if (vo.force) offer(vo)
  }
  plus.downloader
    .createDownload(vo.url, { filename: '_doc/update/' }, (d, status) => {
      if (status !== 200 || !d.filename) return failed()
      // force false: the runtime refuses a wgt that is not newer or is for another appid
      plus.runtime.install(
        d.filename,
        { force: false },
        () => {
          uni.hideLoading()
          plus.runtime.restart()
        },
        failed,
      )
    })
    .start()
}
