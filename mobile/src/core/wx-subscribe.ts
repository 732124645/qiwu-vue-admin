// WeChat one-time subscribe messages (mini program only): Me → "New to-do WeChat alerts" asks
// WeChat for one reminder per tap (WeChat keeps the quota; "always keep this choice" makes later taps
// silent). The server sends it when a new to-do reaches the inbox, while its switch is on.
import type { WxSubscribeVo } from '@qiwu/shared'
import { t } from './i18n'
import { api } from './request'

/** WeChat asks for at most 3 templates at a time */
const MAX_IDS = 3

/** The template ids to ask for: none unless on the mini program, the switch on and the account bound. */
export async function loadSubscribeIds(): Promise<string[]> {
  if (process.env.UNI_PLATFORM !== 'mp-weixin') return []
  try {
    const vo = await api.get<WxSubscribeVo>('/iam/profile/socials/wx-mp/subscribe', undefined, {
      silent: true,
    })
    return vo.templateIds
  } catch {
    return []
  }
}

/** Call it straight from the tap (WeChat refuses a request a tap did not start: no await before it). */
export function requestSubscribe(ids: string[]): void {
  const tmplIds = ids.slice(0, MAX_IDS)
  const toast = (on: boolean) =>
    uni.showToast({ title: t(on ? 'mine.wxRemindOn' : 'mine.wxRemindOff'), icon: 'none' })
  uni.requestSubscribeMessage({
    tmplIds,
    success: (r) => {
      // the answer per id: accept / reject / ban / filter
      const answers = r as unknown as Record<string, string>
      toast(tmplIds.some((id) => answers[id] === 'accept'))
    },
    fail: () => toast(false),
  })
}
