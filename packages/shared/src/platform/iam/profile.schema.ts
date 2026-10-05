import { z } from 'zod'
import { LOCALES } from '../../common/locale.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { authMobile, smsOtpCode } from '../../common/auth.js'
import { USER_GENDERS, userUpdate } from './user.schema.js'

/**
 * Personal center (`/profile`; see docs/design-notes.md#layering), `/api/iam/profile`: always the signed-in user's own row, no
 * permission. Labels reuse `field.iam.user.<prop>`. Password: `changePasswordBody` (common/auth.ts);
 * UI preferences: prefs.schema.ts.
 */

/** GET: own data, unmasked; dept/role/position names are read-only (i18n key or text: render with `tx()`). */
export const profileVo = z.object({
  id: z.number().int(),
  username: z.string(),
  displayName: z.string(),
  gender: z.enum(USER_GENDERS),
  mobile: z.string().nullable(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  locale: z.enum(LOCALES).nullable(),
  deptName: z.string().nullable(),
  roleNames: z.array(z.string()),
  positionNames: z.array(z.string()),
})
export type ProfileVo = z.infer<typeof profileVo>

/** PUT: a new mobile requires configured SMS, the current password and a bound code; clearing needs the password. */
export const profileUpdate = userUpdate
  .pick({ displayName: true, mobile: true, email: true, gender: true })
  .extend({
    currentPassword: z.string().min(1).max(128).optional(),
    mobileCode: smsOtpCode.optional(),
  })
  .register(fieldDomains, { domain: 'iam.user' })
export type ProfileUpdate = z.infer<typeof profileUpdate>

/** POST /mobile/code: signed-in request for a code bound to this user and the new mobile. */
export const profileMobileCodeBody = z
  .object({ mobile: authMobile })
  .register(fieldDomains, { domain: 'iam.user' })
export type ProfileMobileCodeBody = z.infer<typeof profileMobileCodeBody>

/** PUT /locale: the language the server uses for this user (messages, notifications, Excel). */
export const localeBody = z
  .object({ locale: z.enum(LOCALES) })
  .register(fieldDomains, { domain: 'iam.user' })
export type LocaleBody = z.infer<typeof localeBody>

/** POST /avatar (multipart `file`, cropped image → 256×256 webp, public `avatar` object): the new URL. */
export const avatarVo = z.object({ avatarUrl: z.string() })
export type AvatarVo = z.infer<typeof avatarVo>

/**
 * GET /socials: the caller's live sign-in bindings (`wx-mp` so far). DELETE /socials/wx-mp
 * unbinds the caller's WeChat whatever `auth.wx_mp.enabled` says (404 when none) and ends the caller's
 * other mobile sessions.
 */
export const socialBindingVo = z.object({
  provider: z.string(),
  appid: z.string(),
  boundAt: z.iso.datetime(),
})
export type SocialBindingVo = z.infer<typeof socialBindingVo>

/**
 * GET /socials/wx-mp/subscribe: the WeChat subscribe template ids the mini program may ask the caller for;
 * empty unless `notify.wx_subscribe.enabled`, the app is configured and the caller is bound.
 */
export const wxSubscribeVo = z.object({ templateIds: z.array(z.string()) })
export type WxSubscribeVo = z.infer<typeof wxSubscribeVo>
