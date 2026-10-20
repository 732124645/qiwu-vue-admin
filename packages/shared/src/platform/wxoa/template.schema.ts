import { z } from 'zod'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { WXOA_APP_ID, wxoaBytes, wxoaHttpUrl, wxoaId, wxoaQueryId } from './wxoa.schema.js'

/**
 * Template messages, `/api/wxoa/templates`: the account's templates are read from WeChat (cached
 * briefly, never stored); a send goes to at most 100 fans of the account, one message row each (sent
 * after the response; the records are `GET /messages?channel=template`).
 */

/**
 * Most characters of a data value by its key's prefix (`thing3` → `thing`), as WeChat documents them
 * for template messages and subscribe notifications; `name` holds 10 characters once it has a Chinese
 * one. Other keys (time, date, amount, older `keywordN`) {@link WXOA_TEMPLATE_VALUE_MAX_DEFAULT}.
 */
const VALUE_MAX = new Map<string, number>([
  ['thing', 20],
  ['number', 32],
  ['letter', 32],
  ['symbol', 5],
  ['character_string', 32],
  ['phone_number', 17],
  ['car_number', 8],
  ['name', 20],
  ['phrase', 5],
  ['const', 20],
])
export const WXOA_TEMPLATE_VALUE_MAX_DEFAULT = 200

/** Most characters (code points) WeChat takes for `value` under `key`. */
export function wxoaTemplateValueMax(key: string, value = ''): number {
  const prefix = key.replace(/\d+$/, '')
  if (prefix === 'name' && /\p{Script=Han}/u.test(value)) return 10
  return VALUE_MAX.get(prefix) ?? WXOA_TEMPLATE_VALUE_MAX_DEFAULT
}

/** GET /templates?accountId=&refresh= (`refresh=true` skips the cache). */
export const wxoaTemplateListQuery = z
  .object({ accountId: wxoaQueryId, refresh: z.stringbool().optional() })
  .register(fieldDomains, { domain: 'wxoa.template' })
export type WxoaTemplateListQuery = z.output<typeof wxoaTemplateListQuery>

export const wxoaTemplateVo = z.object({
  templateId: z.string(),
  title: z.string(),
  primaryIndustry: z.string(),
  deputyIndustry: z.string(),
  /** WeChat's template text with `{{key.DATA}}` placeholders */
  content: z.string(),
  example: z.string(),
})
export type WxoaTemplateVo = z.infer<typeof wxoaTemplateVo>

const industry = z.object({ first: z.string(), second: z.string() }).nullable()
/** GET /templates/industry */
export const wxoaIndustryVo = z.object({ primary: industry, secondary: industry })
export type WxoaIndustryVo = z.infer<typeof wxoaIndustryVo>

export const WXOA_TEMPLATE_FANS_MAX = 100
const DATA_KEY = /^[a-z][a-z_]{0,31}\d{0,3}$/

/**
 * POST /templates/:templateId/send. `data` maps the template's keys to values within
 * {@link wxoaTemplateValueMax} (the server also checks the keys against the template); `url` or
 * `miniprogram` is where a tap leads.
 */
export const wxoaTemplateSendBody = z
  .object({
    accountId: wxoaId,
    fanIds: z.array(wxoaId).min(1).max(WXOA_TEMPLATE_FANS_MAX),
    data: z
      .record(z.string().regex(DATA_KEY), z.string())
      .refine((d) => Object.keys(d).length <= 30, { error: 'validation.invalid' })
      .superRefine((data, ctx) => {
        for (const [key, value] of Object.entries(data)) {
          const maximum = wxoaTemplateValueMax(key, value)
          if ([...value].length > maximum)
            ctx.addIssue({
              code: 'custom',
              path: [key],
              message: 'validation.too_big.string',
              params: { maximum },
            })
        }
      }),
    url: wxoaHttpUrl().nullish(),
    miniprogram: z
      .strictObject({ appId: z.string().regex(WXOA_APP_ID), pagePath: wxoaBytes(1024) })
      .nullish(),
  })
  .register(fieldDomains, { domain: 'wxoa.template' })
export type WxoaTemplateSendBody = z.infer<typeof wxoaTemplateSendBody>
