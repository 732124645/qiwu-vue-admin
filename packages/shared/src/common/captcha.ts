import { z } from 'zod'
import { fieldDomains } from '../validation/zod-i18n.js'

/** `captcha.mode` parameter codes; default `slider`, seeded `off` in test databases. */
export const CAPTCHA_MODES = ['off', 'image', 'slider'] as const
export type CaptchaMode = (typeof CAPTCHA_MODES)[number]
/** Runtime mode parameter; default `slider`, seeded `off` in test databases. */
export const CAPTCHA_MODE_PARAM = 'captcha.mode'
export const DEFAULT_CAPTCHA_MODE: CaptchaMode = 'slider'
/** Image challenge variant parameter. */
export const CAPTCHA_IMAGE_TYPE_PARAM = 'captcha.image_type'
export const CAPTCHA_IMAGE_TYPES = ['math', 'chars'] as const
export type CaptchaImageType = (typeof CAPTCHA_IMAGE_TYPES)[number]
export const DEFAULT_CAPTCHA_IMAGE_TYPE: CaptchaImageType = 'math'
export const CAPTCHA_SCENES = ['signin', 'signup', 'sms_send'] as const
export type CaptchaScene = (typeof CAPTCHA_SCENES)[number]

/**
 * GET /api/auth/captcha?scene= → {@link CaptchaChallengeVo}. Serve a challenge even with mode `off`:
 * cross-IP username failures can force one at sign-in (see docs/design-notes.md#auth-sessions). The server chooses its kind in that case.
 */
export const captchaQuery = z
  .object({
    scene: z.enum(CAPTCHA_SCENES),
    /** image challenges only: `png` for clients unsure of SVG data URIs (mini programs); default `svg` */
    format: z.enum(['svg', 'png']).optional(),
  })
  .register(fieldDomains, { domain: 'auth' })
export type CaptchaQuery = z.infer<typeof captchaQuery>

const challengeId = z.string().regex(/^[\w-]{16,64}$/)
const dataUrl = z.url().startsWith('data:image/')
export const captchaChallengeVo = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('image'),
    id: challengeId,
    image: z.string().regex(/^data:image\/(svg\+xml|png);base64,/),
  }),
  z.object({
    kind: z.literal('slider'),
    id: challengeId,
    image: dataUrl,
    thumb: dataUrl,
    thumbX: z.number().int(),
    thumbY: z.number().int(),
    thumbWidth: z.number().int().positive(),
    thumbHeight: z.number().int().positive(),
  }),
])
export type CaptchaChallengeVo = z.infer<typeof captchaChallengeVo>

/** POST /api/auth/captcha/check: every attempt consumes the challenge via GETDEL, right or wrong. */
export const captchaCheckBody = z
  .object({
    id: challengeId,
    answer: z.union([
      z.string().trim().min(1).max(8),
      z.object({ x: z.number().int().min(0).max(1000), y: z.number().int().min(0).max(1000) }),
    ]),
  })
  .register(fieldDomains, { domain: 'auth' })
export type CaptchaCheckBody = z.infer<typeof captchaCheckBody>

/** Single-use ticket, bound to the challenge scene and client IP; expires after 120 seconds. */
export const captchaTicket = z.string().trim().min(1).max(128)
export const captchaTicketVo = z.object({ captchaTicket })
export type CaptchaTicketVo = z.infer<typeof captchaTicketVo>
