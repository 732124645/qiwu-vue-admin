import { z } from 'zod'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { wxoaHttpUrl, wxoaId, wxoaQueryId } from './wxoa.schema.js'

export const wxoaNoticeQuery = z
  .object({ accountId: wxoaQueryId, refresh: z.stringbool().optional() })
  .register(fieldDomains, { domain: 'wxoa.notice' })
export type WxoaNoticeQuery = z.output<typeof wxoaNoticeQuery>
/** 模板库：不带参数取类目；带 categoryId 取该类目的模板标题（分页）；带 tid 取该标题的关键词。 */
export const wxoaNoticeLibraryQuery = z
  .object({
    accountId: wxoaQueryId,
    categoryId: z.coerce.number().int().positive().optional(),
    tid: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/)
      .optional(),
    start: z.coerce.number().int().min(0).default(0),
    title: z.string().trim().max(64).optional(),
  })
  .register(fieldDomains, { domain: 'wxoa.notice' })
export type WxoaNoticeLibraryQuery = z.output<typeof wxoaNoticeLibraryQuery>
/** 从公共模板库选用模板：模板标题 tid、2–5 个关键词 id、15 字以内的服务场景描述。 */
export const wxoaNoticeAdd = z
  .object({
    accountId: wxoaQueryId,
    tid: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/),
    kidList: z.array(z.number().int().positive()).min(2).max(5),
    sceneDesc: z.string().trim().min(1).max(15),
  })
  .register(fieldDomains, { domain: 'wxoa.notice' })
export type WxoaNoticeAdd = z.output<typeof wxoaNoticeAdd>
export const wxoaNoticeSend = z
  .object({
    accountId: wxoaId,
    fanIds: z.array(wxoaId).min(1).max(20),
    data: z.record(z.string().trim().min(1).max(64), z.string().max(200)),
    url: wxoaHttpUrl().nullish(),
  })
  .register(fieldDomains, { domain: 'wxoa.notice' })
export type WxoaNoticeSend = z.output<typeof wxoaNoticeSend>
export const wxoaNoticeTemplateVo = z.object({
  priTmplId: z.string(),
  title: z.string(),
  content: z.string(),
  example: z.string().nullable().optional(),
  /** 2 一次性订阅，3 长期订阅 */
  type: z.number().int().nullable().optional(),
  keywordEnumValue: z.string().nullable().optional(),
})
export type WxoaNoticeTemplateVo = z.infer<typeof wxoaNoticeTemplateVo>
/**
 * 模板库应答，三种之一：不带参数 `{ categories }`；带 categoryId `{ titles, total }`（每页 30 条，
 * 用 start 翻页）；带 tid `{ keywords }`（kid 用于选用模板的 kidList）。
 */
export const wxoaNoticeLibraryVo = z.union([
  z.object({ categories: z.array(z.object({ id: z.string(), name: z.string() })) }),
  z.object({
    titles: z.array(
      z.object({
        tid: z.string(),
        title: z.string(),
        type: z.number().int().nullable(),
        categoryId: z.string(),
      }),
    ),
    total: z.number().int(),
  }),
  z.object({
    keywords: z.array(
      z.object({ kid: z.number().int(), name: z.string(), example: z.string(), rule: z.string() }),
    ),
  }),
])
export type WxoaNoticeLibraryVo = z.infer<typeof wxoaNoticeLibraryVo>
