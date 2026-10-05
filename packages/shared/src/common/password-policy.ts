import { z } from 'zod'

/** Password policy (see docs/design-notes.md#auth-sessions), stored in cfg_param and returned by GET /api/auth/me. */
export interface PasswordPolicy {
  /** minimum length in characters, ≥ 8 */
  minLength: number
  /** how many of the classes lower / upper / digit / symbol must appear (0–4) */
  charClasses: number
  /** days until a password expires; 0 = never */
  expireDays: number
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  charClasses: 2,
  expireDays: 0,
}

/** bcrypt only uses the first 72 bytes: longer secrets would silently collide. */
export const PASSWORD_MAX_BYTES = 72

const CLASSES = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/]
export const passwordClassCount = (pw: string) => CLASSES.filter((re) => re.test(pw)).length
export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length

/** The same rule on server and web (see docs/adr/003-validation.md); messages are i18n keys with params. */
export function passwordSchema(policy: PasswordPolicy) {
  return z
    .string()
    .min(policy.minLength)
    .superRefine((pw, ctx) => {
      if (utf8Bytes(pw) > PASSWORD_MAX_BYTES)
        ctx.addIssue({
          code: 'custom',
          message: 'validation.password.too_long_bytes',
          params: { maxBytes: PASSWORD_MAX_BYTES },
        })
      if (passwordClassCount(pw) < policy.charClasses)
        ctx.addIssue({
          code: 'custom',
          message: 'validation.password.char_classes',
          params: { count: policy.charClasses },
        })
    })
}
