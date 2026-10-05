import { z } from 'zod'
import type { I18nText, Locale } from './locale.js'
import { passwordSchema, type PasswordPolicy } from './password-policy.js'
import { fieldDomains } from '../validation/zod-i18n.js'
import { captchaTicket } from './captcha.js'

/**
 * Auth contract between server and web (see docs/design-notes.md#auth-sessions). Endpoints under /api/auth:
 * POST /login (LoginBody → TokenPayload + refresh cookie; `captchaTicket` uses scene `signin`) · POST /refresh · POST /logout ·
 * GET /me (MePayload) · GET /menus (MenuNode[]) · POST /verify-password (VerifyPasswordBody).
 * Minimal password change: PUT /api/iam/profile/password (ChangePasswordBody).
 */

/**
 * First-party clients (see docs/design-notes.md#auth-sessions): AuthGuard and the realtime gateway accept their sessions on
 * every route. `console` (the admin web) gets its refresh token only as the HttpOnly cookie; `mobile`
 * (the uni-app, no cookies) gets it in the sign-in/refresh response body and sends it back in the
 * `/refresh` body. Any other session client id is a third-party OAuth2 client, which must never
 * be registered under one of these ids.
 */
export const FIRST_PARTY_CLIENTS = ['console', 'mobile'] as const
export type FirstPartyClient = (typeof FIRST_PARTY_CLIENTS)[number]
/** Sign-in body field choosing the session's client; absent = `console`. */
const firstPartyClient = z.enum(FIRST_PARTY_CLIENTS).optional()

export const loginBody = z
  .object({
    username: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(128),
    keepSignedIn: z.boolean().optional(),
    captchaTicket: captchaTicket.optional(),
    clientId: firstPartyClient,
  })
  .register(fieldDomains, { domain: 'auth' })
export type LoginBody = z.infer<typeof loginBody>

/** OTP purposes, independent of CAPTCHA_SCENES: sending a code uses CAPTCHA scene `sms_send`. */
export const SMS_OTP_SCENES = ['signin', 'reset_password', 'bind_mobile'] as const
export type SmsOtpScene = (typeof SMS_OTP_SCENES)[number]

/** Same mobile syntax as `iam.user.mobile`; reused by the SMS template test-send contract. */
export const authMobile = z
  .string()
  .trim()
  .max(32)
  .regex(/^\+?\d[\d-]{4,30}$/)
export const smsOtpCode = z.string().regex(/^\d{6}$/)
/** Same sign-in name syntax as `iam.user.username`. */
export const signupUsername = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\w.@-]+$/)

/**
 * POST /api/auth/sms/code → {@link SmsCodeVo}. `captchaTicket` has scene `sms_send` and is required
 * unless `captcha.mode=off`. For an unregistered mobile in signin/reset_password, return the identical
 * response but send nothing and write no record (no account enumeration). `bind_mobile` is not public
 * (anyone could make it text any unregistered number): use signed-in POST /api/iam/profile/mobile/code.
 */
export const smsCodeBody = z
  .object({
    mobile: authMobile,
    scene: z.enum(SMS_OTP_SCENES).exclude(['bind_mobile']),
    captchaTicket: captchaTicket.optional(),
  })
  .register(fieldDomains, { domain: 'auth' })
export type SmsCodeBody = z.infer<typeof smsCodeBody>
export const smsCodeVo = z.object({ cooldownSec: z.number().int().nonnegative() })
export type SmsCodeVo = z.infer<typeof smsCodeVo>

/** POST /api/auth/sms/login → {@link TokenPayload} and refresh cookie, as with /login. */
export const smsLoginBody = z
  .object({
    mobile: authMobile,
    code: smsOtpCode,
    keepSignedIn: z.boolean().optional(),
    clientId: firstPartyClient,
  })
  .register(fieldDomains, { domain: 'auth' })
export type SmsLoginBody = z.infer<typeof smsLoginBody>

/** POST /api/auth/password/reset-by-sms → no data; success calls SessionRevoker.revokeUser (old tokens → 401). */
export function smsResetPasswordBody(policy: PasswordPolicy) {
  return z
    .object({ mobile: authMobile, code: smsOtpCode, newPassword: passwordSchema(policy) })
    .register(fieldDomains, { domain: 'auth' })
}
export type SmsResetPasswordBody = z.infer<ReturnType<typeof smsResetPasswordBody>>

/**
 * POST /api/auth/signup → no data (sign in afterwards). `captchaTicket` uses scene `signup`;
 * displayName defaults to username on the server. Switch, default role and dept are `auth.signup.*`
 * params, never request fields.
 */
export function signupBody(policy: PasswordPolicy) {
  return z
    .object({
      username: signupUsername,
      password: passwordSchema(policy),
      displayName: z.string().trim().min(1).max(64).optional(),
      captchaTicket: captchaTicket.optional(),
    })
    .register(fieldDomains, { domain: 'auth' })
}
export type SignupBody = z.infer<ReturnType<typeof signupBody>>

/**
 * WeChat mini program sign-in, off unless param `auth.wx_mp.enabled` (every route 404 then).
 * POST /api/auth/wx-mp/login `{code}` (from `uni.login`, single use) → {@link WxMpLoginVo}: a bound user's
 * `mobile` session, or a one-time bind ticket (5 minutes, this client IP only). POST /api/auth/wx-mp/bind
 * → the new binding's `mobile` session. WeChat's session_key never leaves the server.
 */
export const WX_MP_ENABLED_PARAM = 'auth.wx_mp.enabled'
export const wxMpLoginBody = z
  .object({ code: z.string().trim().min(1).max(128) })
  .register(fieldDomains, { domain: 'auth.wxMp' })
export type WxMpLoginBody = z.infer<typeof wxMpLoginBody>
/** Signed in (refresh token in the body, as every `mobile` session), or unbound: bind with the ticket. */
export type WxMpLoginVo = { tokens: TokenPayload } | { bindTicket: string }

const wxMpTicket = z.string().regex(/^[\w-]{20,64}$/)
/** Bind with the account's password: the same captcha (scene `signin`) and lockout rules as /login. */
export const wxMpBindPasswordBody = loginBody
  .pick({ username: true, password: true, captchaTicket: true })
  .extend({ ticket: wxMpTicket })
  .register(fieldDomains, { domain: 'auth' })
/** Bind with an SMS code of scene `signin` (POST /api/auth/sms/code) sent to the account's mobile. */
export const wxMpBindSmsBody = z
  .object({ ticket: wxMpTicket, mobile: authMobile, code: smsOtpCode })
  .register(fieldDomains, { domain: 'auth' })
/** POST /api/auth/wx-mp/bind: the ticket plus the password or the SMS proof. */
export const wxMpBindBody = z.union([wxMpBindPasswordBody, wxMpBindSmsBody])
export type WxMpBindBody = z.infer<typeof wxMpBindBody>

/**
 * WeChat one-time subscribe messages: once the inbox delivered a row whose notify code has a
 * template in `notify.wx_subscribe.templates`, a recipient bound to the configured mini program gets one
 * `subscribeMessage.send` (best effort; WeChat keeps each user's one-time quota). Off unless
 * `notify.wx_subscribe.enabled`. GET /api/iam/profile/socials/wx-mp/subscribe → the ids to ask for.
 */
export const WX_SUBSCRIBE_ENABLED_PARAM = 'notify.wx_subscribe.enabled'
export const WX_SUBSCRIBE_TEMPLATES_PARAM = 'notify.wx_subscribe.templates'
/**
 * notify code → WeChat template: `id` ('' = off), the mini program `page` and the `data` fields (keys as
 * the template shows them, e.g. `thing1`), with `{name}` placeholders: `{title}` (the inbox title), `{time}`
 * (the row's time in the recipient's zone) and the notification's plain params.
 */
export const wxSubscribeTemplates = z.record(
  z.string().min(1).max(100),
  z.object({
    id: z.string().regex(/^[\w-]{0,64}$/),
    page: z.string().max(256).optional(),
    /** `miniprogram_state`, default formal */
    state: z.enum(['developer', 'trial', 'formal']).optional(),
    data: z.record(z.string().regex(/^[a-z_]+\d+$/), z.string().max(200)),
  }),
)
export type WxSubscribeTemplates = z.infer<typeof wxSubscribeTemplates>

/**
 * POST /api/auth/refresh body: only `mobile` sessions send their refresh token here (the console's
 * travels only as the HttpOnly cookie, and a console token in the body is refused).
 */
export const refreshBody = z
  .object({ refreshToken: z.string().min(1).max(128).optional() })
  .optional()
  .register(fieldDomains, { domain: 'auth' })
export type RefreshBody = z.infer<typeof refreshBody>

/**
 * Access token (memory only on the web). The console's refresh token travels only as an HttpOnly
 * cookie; a `mobile` session gets it here instead (kept in uni storage).
 */
export interface TokenPayload {
  accessToken: string
  /** seconds */
  expiresIn: number
  /** `mobile` sessions only */
  refreshToken?: string
  /** `mobile` sessions only: refresh token lifetime, seconds */
  refreshExpiresIn?: number
}

export interface MeUser {
  id: number
  username: string
  displayName: string
  avatarUrl: string | null
  deptId: number | null
  /** i18n key (seeded depts, e.g. 'seed.dept.hq') or plain text; render with `tx()` */
  deptName: string | null
  /** names of the enabled roles, same kind of text as `deptName` */
  roleNames: string[]
  locale: Locale | null
  timezone: string | null
}

export interface MeFlags {
  mustChangePassword: boolean
  passwordExpired: boolean
}

export interface MePayload {
  user: MeUser
  /** role codes, e.g. 'root' */
  roles: string[]
  /** permission points `<domain>.<resource>.<verb>`; root has ['*'] */
  perms: string[]
  flags: MeFlags
  policy: PasswordPolicy
  /**
   * ISO time of the user's previous successful sign-in: the latest `password`/`sms`/`wx-mp`
   * sign-in log row before this session's own; null when there is none.
   */
  lastSignInAt: string | null
}

export type MenuLinkType = 'route' | 'iframe' | 'external'

/**
 * A grantable permission code (see docs/design-notes.md#permissions): `<domain>.<resource>.<verb>`, each part a letter then letters,
 * digits or `-` (`iam.user.reset-password`). Menu rows holding anything else (`*`, `a:b:c`, lists, blanks)
 * grant nothing: `*` belongs to the builtin root role alone.
 */
export const PERM_CODE = /^[a-z][a-zA-Z0-9-]*\.[a-z][a-zA-Z0-9-]*\.[a-z][a-zA-Z0-9-]*$/

/** GET /api/auth/menus: granted group/page rows with all ancestors, as a tree (actions become perms). */
export interface MenuNode {
  id: number
  parentId: number
  kind: 'group' | 'page'
  /** i18n key (seeded menus, e.g. 'menu.settings.dict') or plain text (admin-created) */
  name: string
  nameI18n: I18nText | null
  /** absolute path, e.g. '/settings/dicts' (seeds use absolute paths) */
  routePath: string
  routeName: string | null
  /** view path under src/views without extension, e.g. 'platform/settings/dict/index' */
  component: string | null
  /** keep-alive cache name */
  componentName: string | null
  routeQuery: string | null
  linkType: MenuLinkType
  linkUrl: string | null
  icon: string | null
  visible: boolean
  keepAlive: boolean
  alwaysShow: boolean
  sortNo: number
  children: MenuNode[]
}

export const verifyPasswordBody = z
  .object({ password: z.string().min(1).max(128) })
  .register(fieldDomains, { domain: 'auth' })
export type VerifyPasswordBody = z.infer<typeof verifyPasswordBody>

export function changePasswordBody(policy: PasswordPolicy) {
  return z
    .object({ oldPassword: z.string().min(1).max(128), newPassword: passwordSchema(policy) })
    .refine((b) => b.oldPassword !== b.newPassword, {
      path: ['newPassword'],
      message: 'validation.password.same_as_old',
    })
    .register(fieldDomains, { domain: 'auth' })
}
export type ChangePasswordBody = z.infer<ReturnType<typeof changePasswordBody>>
