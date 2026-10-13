import {
  DEFAULT_TENANT_CODE,
  passwordPolicyOf,
  passwordPolicyParams,
  signupParams,
  type PasswordPolicy,
  type CaptchaChallengeVo,
  type CaptchaCheckBody,
  type CaptchaScene,
  type CaptchaTicketVo,
  type SignupBody,
  type SmsCodeBody,
  type SmsCodeVo,
  type SmsResetPasswordBody,
  type TenancyVo,
} from '@qiwu/shared'
import { hostBrand } from '@/core/composables/use-brand'
import { api } from '@/core/request/http'
import { publicParamApi } from '@/api/platform/settings/public-param'

/**
 * Whether sign-up is open: only the value `true`; anything else or an unreadable param → closed. Sign-up
 * serves the default tenant alone, so a host bound to another tenant is closed too.
 */
export async function signupEnabled(): Promise<boolean> {
  try {
    if ((await publicParamApi.get(signupParams.enabled)).value !== 'true') return false
  } catch {
    return false
  }
  const { enabled, tenant } = await tenancy()
  return !(enabled && tenant && tenant.code !== DEFAULT_TENANT_CODE)
}

/**
 * Whether multi-tenancy is on and the tenant this host is bound to; rejects with the request's error when
 * unanswered (never taken for "off": the tenant code field would vanish and the sign-in go to the default
 * tenant). The sign-in pages show that tenant's brand (`useBrand`).
 */
export async function readTenancy(): Promise<TenancyVo> {
  const vo = await api.get<TenancyVo>('/auth/tenancy', { silent: true })
  hostBrand.value = vo.tenant ?? null
  return vo
}

/** `readTenancy`, unanswered → off: for what only offers more while on (sign-up). */
export function tenancy(): Promise<TenancyVo> {
  return readTenancy().catch(() => ({ enabled: false }))
}

/** Public password settings; unreadable fields use the shared defaults. */
export async function publicPasswordPolicy(): Promise<PasswordPolicy> {
  const keys: string[] = [passwordPolicyParams.minLength, passwordPolicyParams.charClasses]
  const values = await Promise.all(
    keys.map(async (key) => {
      try {
        return (await publicParamApi.get(key)).value
      } catch {
        return null
      }
    }),
  )
  return passwordPolicyOf((key) => values[keys.indexOf(key)])
}

/** /api/auth sign-up and SMS calls (see docs/design-notes.md#auth-sessions); silent: the forms show errors inline. */
export const authExtraApi = {
  signup: (body: SignupBody) => api.post<void>('/auth/signup', body, { silent: true }),
  smsCode: (body: SmsCodeBody) => api.post<SmsCodeVo>('/auth/sms/code', body, { silent: true }),
  resetBySms: (body: SmsResetPasswordBody) =>
    api.post<void>('/auth/password/reset-by-sms', body, { silent: true }),
}

/** /api/auth captcha calls; silent: CaptchaDialog shows errors itself. */
export const captchaApi = {
  challenge: (scene: CaptchaScene) =>
    api.get<CaptchaChallengeVo>('/auth/captcha', { params: { scene }, silent: true }),
  check: (body: CaptchaCheckBody) =>
    api.post<CaptchaTicketVo>('/auth/captcha/check', body, { silent: true }),
}
