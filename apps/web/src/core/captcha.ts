import {
  CAPTCHA_MODE_PARAM,
  CAPTCHA_MODES,
  DEFAULT_CAPTCHA_MODE,
  type CaptchaMode,
  type CaptchaScene,
} from '@qiwu/shared'
import { publicParamApi } from '@/api/platform/settings/public-param'
import CaptchaDialog from '@/core/components/CaptchaDialog.vue'
import { openDialog } from '@/core/dialog'
import { i18n } from '@/core/i18n'

/**
 * Captcha on the pages outside the layout: sign-in, sign-up and SMS sending ask for a single-use
 * `captchaTicket` of their scene and send only that ticket. The server is the gate either way.
 */

/** Read at each use (an admin may switch it): unknown value → `slider` (default), unreadable → `off`. */
export async function captchaMode(): Promise<CaptchaMode> {
  try {
    const { value } = await publicParamApi.get(CAPTCHA_MODE_PARAM)
    return CAPTCHA_MODES.includes(value as CaptchaMode)
      ? (value as CaptchaMode)
      : DEFAULT_CAPTCHA_MODE
  } catch {
    return 'off'
  }
}

/** Opens `CaptchaDialog`: the ticket, or `undefined` when the user closed it. */
export const askCaptcha = (scene: CaptchaScene) =>
  openDialog<string>(
    CaptchaDialog,
    { scene },
    { title: () => i18n.global.t('captcha.title'), width: '368px' },
  )

/**
 * Runs `send` with a ticket when `captcha.mode` is not off (the dialog first; closed → nothing is sent,
 * `undefined`). When `send` fails and `retryIf(error)` holds (sign-in: the server demands a ticket after
 * cross-IP failures even with mode off; see docs/design-notes.md#auth-sessions), asks once and sends again; other errors are rethrown.
 */
export async function withCaptcha<T>(
  scene: CaptchaScene,
  send: (captchaTicket?: string) => Promise<T>,
  retryIf?: (error: unknown) => boolean,
): Promise<T | undefined> {
  const enabled = (await captchaMode()) !== 'off'
  const ticket = enabled ? await askCaptcha(scene) : undefined
  if (enabled && ticket === undefined) return undefined
  try {
    return await send(ticket)
  } catch (error) {
    if (!retryIf?.(error)) throw error
    const retryTicket = await askCaptcha(scene)
    return retryTicket === undefined ? undefined : send(retryTicket)
  }
}
