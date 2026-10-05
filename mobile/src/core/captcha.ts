// Captcha before sign-in and SMS sending, as on the web: the page asks `<QwCaptcha>` for a single-use
// ticket of the scene and sends only that ticket. The server is the gate either way.
import {
  CAPTCHA_MODE_PARAM,
  CAPTCHA_MODES,
  DEFAULT_CAPTCHA_MODE,
  type CaptchaChallengeVo,
  type CaptchaCheckBody,
  type CaptchaMode,
  type CaptchaScene,
  type CaptchaTicketVo,
  type PublicParam,
} from '@qiwu/shared'
import { api } from './request'

/** Opens the captcha for `scene`: the ticket, or `undefined` when the user closed it. */
export type AskCaptcha = (scene: CaptchaScene) => Promise<string | undefined>

/** Read at each use (an admin may switch it): unknown value → `slider` (default), unreadable → `off`. */
export async function captchaMode(): Promise<CaptchaMode> {
  try {
    const { value } = await api.get<PublicParam>(
      `/settings/params/public/${CAPTCHA_MODE_PARAM}`,
      undefined,
      { silent: true },
    )
    return CAPTCHA_MODES.includes(value as CaptchaMode)
      ? (value as CaptchaMode)
      : DEFAULT_CAPTCHA_MODE
  } catch {
    return 'off'
  }
}

/**
 * Runs `send` with a ticket when `captcha.mode` is not off (asked first; closed → nothing is sent,
 * `undefined`). When `send` fails and `retryIf(error)` holds (sign-in: the server demands a ticket after
 * cross-IP failures even with mode off; see docs/design-notes.md#auth-sessions), asks once and sends again; other errors are rethrown.
 */
export async function withCaptcha<T>(
  ask: AskCaptcha,
  scene: CaptchaScene,
  send: (captchaTicket?: string) => Promise<T>,
  retryIf?: (error: unknown) => boolean,
): Promise<T | undefined> {
  const enabled = (await captchaMode()) !== 'off'
  const ticket = enabled ? await ask(scene) : undefined
  if (enabled && ticket === undefined) return undefined
  try {
    return await send(ticket)
  } catch (error) {
    if (!retryIf?.(error)) throw error
    const retryTicket = await ask(scene)
    return retryTicket === undefined ? undefined : send(retryTicket)
  }
}

/** Challenges as PNG: mini programs may not show SVG data URIs. Silent: the popup shows errors. */
export const captchaApi = {
  challenge: (scene: CaptchaScene) =>
    api.get<CaptchaChallengeVo>('/auth/captcha', { scene, format: 'png' }, { silent: true }),
  check: (body: CaptchaCheckBody) =>
    api.post<CaptchaTicketVo>('/auth/captcha/check', body, { silent: true }),
}
