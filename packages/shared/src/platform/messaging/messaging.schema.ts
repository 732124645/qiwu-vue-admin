import { z } from 'zod'
import { authMobile } from '../../common/auth.js'
import { fieldDomains } from '../../validation/zod-i18n.js'

/** Codes shared by the generated messaging forms and their dictionaries. */
export const INBOX_CATEGORIES = ['system', 'business'] as const
export type InboxCategory = (typeof INBOX_CATEGORIES)[number]
export const MAIL_SECURITIES = ['ssl', 'starttls', 'none'] as const
export type MailSecurity = (typeof MAIL_SECURITIES)[number]
export const SMS_DRIVERS = ['aliyun', 'tencent', 'debug'] as const
export type SmsDriver = (typeof SMS_DRIVERS)[number]
export const SMS_PURPOSES = ['otp', 'notice', 'promo'] as const
export type SmsPurpose = (typeof SMS_PURPOSES)[number]

/** Plain string replacements: at most 20 names, each `\w` and 1–64 chars, values ≤500 chars. */
export const templateTestParams = z
  .record(z.string().regex(/^\w{1,64}$/), z.string().max(500))
  .refine((params) => Object.keys(params).length <= 20, { error: 'validation.template_params_max' })

/**
 * Test-send endpoints use the stored template row and its locale, render the supplied plain-string
 * params, write a record and send now. `ok:false` never reveals a remote error or response.
 * - POST /api/messaging/inbox-templates/:id/test {@link InboxTemplateTestBody} → {@link TemplateTestVo}:
 *   recipient is always the caller; no recipient field can message arbitrary users.
 * - POST /api/messaging/mail-templates/:id/test {@link MailTemplateTestBody} → {@link TemplateTestVo}.
 * - POST /api/messaging/sms-templates/:id/test {@link SmsTemplateTestBody} → {@link TemplateTestVo}.
 */
export const inboxTemplateTestBody = z
  .object({ params: templateTestParams.default({}) })
  .register(fieldDomains, { domain: 'messaging.templateTest' })
export type InboxTemplateTestBody = z.infer<typeof inboxTemplateTestBody>
export const mailTemplateTestBody = inboxTemplateTestBody
  .extend({ to: z.string().trim().max(128).pipe(z.email()) })
  .register(fieldDomains, { domain: 'messaging.templateTest' })
export type MailTemplateTestBody = z.infer<typeof mailTemplateTestBody>
export const smsTemplateTestBody = inboxTemplateTestBody
  .extend({ mobile: authMobile })
  .register(fieldDomains, { domain: 'messaging.templateTest' })
export type SmsTemplateTestBody = z.infer<typeof smsTemplateTestBody>
export const templateTestVo = z.object({ ok: z.boolean(), recordId: z.number().int().positive() })
export type TemplateTestVo = z.infer<typeof templateTestVo>

/**
 * POST /api/messaging/mail-accounts/:id/test and POST /api/messaging/sms-channels/:id/test have no body
 * and return only `{ok}`. Never echo the remote error or response. SMTP hosts use core/net's SSRF guard.
 */
export const connectionTestVo = z.object({ ok: z.boolean() })
export type ConnectionTestVo = z.infer<typeof connectionTestVo>
