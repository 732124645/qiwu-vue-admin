import { z } from 'zod'
import { blankAsNull } from '../../common/crud.js'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import {
  WXOA_ACCOUNT_KINDS,
  WXOA_AES_KEY,
  WXOA_APP_ID,
  WXOA_APP_SECRET,
  WXOA_CRYPTO_MODES,
  WXOA_TOKEN,
  type WxoaAccountKind,
  type WxoaCryptoMode,
} from './wxoa.schema.js'

/**
 * Accounts (`wxoa_account`), `/api/wxoa/accounts`. The three secrets (AppSecret, Token,
 * EncodingAESKey) are write-only: stored encrypted, answered only as `has*` flags; on update an empty or
 * absent secret keeps the stored one. The AppID is fixed once added (a PUT carrying it → 400): openids,
 * media ids, menus and QR tickets only hold for it. Compat and secure modes need an EncodingAESKey
 * (`B6008`, checked against the stored one on update).
 */

/** A sandbox account pushes in plain mode only. */
export const wxoaCryptoModeAllowed = (kind: WxoaAccountKind, mode: WxoaCryptoMode) =>
  kind !== 'sandbox' || mode === 'plain'

/** A write-only secret: '' keeps the stored value. */
const keptSecret = (format: RegExp) =>
  z
    .string()
    .trim()
    .refine((s) => s === '' || format.test(s), { error: 'validation.invalid_format.other' })
    .optional()

const accountFields = {
  label: z.string().trim().min(1).max(64),
  accountKind: z.enum(WXOA_ACCOUNT_KINDS),
  verified: z.boolean().optional(),
  /** default `plain` */
  cryptoMode: z.enum(WXOA_CRYPTO_MODES).optional(),
  aesKey: keptSecret(WXOA_AES_KEY),
  enabled: z.boolean().optional(),
  note: blankAsNull(z.string().trim().max(500)),
}

const sandboxPlain = (
  b: { accountKind?: WxoaAccountKind; cryptoMode?: WxoaCryptoMode },
  ctx: z.RefinementCtx,
) => {
  if (b.accountKind && b.cryptoMode && !wxoaCryptoModeAllowed(b.accountKind, b.cryptoMode))
    ctx.addIssue({ code: 'custom', path: ['cryptoMode'], message: 'validation.invalid' })
}

/** POST body. */
export const wxoaAccountCreate = z
  .object({
    ...accountFields,
    appId: z.string().trim().regex(WXOA_APP_ID).meta({ example: 'wx0123456789abcdef' }),
    appSecret: z.string().trim().regex(WXOA_APP_SECRET),
    token: z.string().trim().regex(WXOA_TOKEN),
  })
  .superRefine(sandboxPlain)
  .register(fieldDomains, { domain: 'wxoa.account' })
export type WxoaAccountCreate = z.infer<typeof wxoaAccountCreate>

/** PUT body: the fields sent are changed, the others kept; no `appId`. */
export const wxoaAccountUpdate = z
  .strictObject({
    ...accountFields,
    label: accountFields.label.optional(),
    accountKind: accountFields.accountKind.optional(),
    appSecret: keptSecret(WXOA_APP_SECRET),
    token: keptSecret(WXOA_TOKEN),
  })
  .superRefine(sandboxPlain)
  .register(fieldDomains, { domain: 'wxoa.account' })
export type WxoaAccountUpdate = z.infer<typeof wxoaAccountUpdate>

export const wxoaAccountQuery = pageQuery(['label', 'appId', 'createdAt', 'id'])
  .extend({
    label: z.string().trim().max(64).optional(),
    appId: z.string().trim().max(32).optional(),
    accountKind: z.enum(WXOA_ACCOUNT_KINDS).optional(),
    enabled: z.stringbool().optional(),
  })
  .register(fieldDomains, { domain: 'wxoa.account' })
export type WxoaAccountQuery = z.output<typeof wxoaAccountQuery>

export const wxoaAccountVo = z.object({
  id: z.number().int(),
  label: z.string(),
  appId: z.string(),
  accountKind: z.enum(WXOA_ACCOUNT_KINDS),
  verified: z.boolean(),
  cryptoMode: z.enum(WXOA_CRYPTO_MODES),
  enabled: z.boolean(),
  /** the last push that passed the signature check (updated at most once a minute) */
  lastPushAt: z.iso.datetime().nullable(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type WxoaAccountVo = z.infer<typeof wxoaAccountVo>

/** GET /:id */
export const wxoaAccountDetailVo = wxoaAccountVo.extend({
  /** `/api/wxoa/callback/<key>`; the page puts its own origin in front */
  callbackPath: z.string(),
  hasAppSecret: z.boolean(),
  hasToken: z.boolean(),
  hasAesKey: z.boolean(),
})
export type WxoaAccountDetailVo = z.infer<typeof wxoaAccountDetailVo>

/** GET /options: live accounts for the account switch (disabled ones included, marked). */
export const wxoaAccountOptionVo = wxoaAccountVo.pick({
  id: true,
  label: true,
  accountKind: true,
  verified: true,
  enabled: true,
})
export type WxoaAccountOption = z.infer<typeof wxoaAccountOptionVo>

/** POST /:id/test: a fresh token (cache bypassed), then `get_api_domain_ip`. */
export const wxoaAccountTestVo = z.object({
  tokenOk: z.boolean(),
  apiOk: z.boolean(),
  /** the error code of the first failure, null when both passed */
  code: z.string().nullable(),
  /** the refused source IP WeChat named (`B6004`) */
  ip: z.string().nullable(),
  lastPushAt: z.iso.datetime().nullable(),
})
export type WxoaAccountTestVo = z.infer<typeof wxoaAccountTestVo>

/** GET /:id/quota: the daily quota of each API on the fixed list. */
export const wxoaQuotaVo = z.array(
  z.object({
    api: z.string(),
    dailyLimit: z.number().int(),
    used: z.number().int(),
    remain: z.number().int(),
  }),
)
export type WxoaQuotaVo = z.infer<typeof wxoaQuotaVo>

/** Quota resets a month, `clear_quota/v2` and the console's reset together. */
export const WXOA_CLEAR_QUOTA_MONTHLY = 10
