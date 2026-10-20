import { z } from 'zod'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { wxoaAccountRef, wxoaId, wxoaQueryId } from './wxoa.schema.js'

export const wxoaPublishQuery = pageQuery(['createdAt', 'finishedAt', 'id'])
  .extend({
    accountId: wxoaQueryId,
  })
  .register(fieldDomains, { domain: 'wxoa.publish' })
export type WxoaPublishQuery = z.output<typeof wxoaPublishQuery>

export const wxoaPublishCreate = z
  .object({
    accountId: wxoaQueryId,
    draftId: wxoaId,
  })
  .register(fieldDomains, { domain: 'wxoa.publish' })
export type WxoaPublishCreate = z.output<typeof wxoaPublishCreate>

export const wxoaPublishDelete = z.object({ index: z.number().int().min(0).optional() })
export type WxoaPublishDelete = z.infer<typeof wxoaPublishDelete>

export const wxoaPublishVo = z.object({
  id: wxoaId,
  accountId: wxoaId,
  draftId: wxoaId.nullable(),
  publishId: z.string().nullable(),
  articleId: z.string().nullable(),
  title: z.string(),
  publishState: z.enum(['publishing', 'succeeded', 'failed', 'removed']),
  failIdx: z.array(z.number().int()).nullable(),
  articleUrls: z.array(z.string()).nullable(),
  finishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})
export type WxoaPublishVo = z.infer<typeof wxoaPublishVo>

/** 已发表文章的一篇（freepublish/getarticle，正文已清洗）。 */
export const wxoaPublishArticle = z.object({
  title: z.string(),
  author: z.string(),
  digest: z.string(),
  content: z.string(),
  /** 上游链接只保留 http(s) 的，其余为 null */
  contentSourceUrl: z.string().nullable(),
  thumbUrl: z.string().nullable(),
  url: z.string().nullable(),
  isDeleted: z.boolean(),
})
export type WxoaPublishArticle = z.infer<typeof wxoaPublishArticle>
/** 详情：本地记录加上游的各篇文章（未发表成功时为 null）。 */
export const wxoaPublishDetailVo = wxoaPublishVo.extend({
  articles: z.array(wxoaPublishArticle).nullable(),
})
export type WxoaPublishDetailVo = z.infer<typeof wxoaPublishDetailVo>

export const wxoaPublishPullResult = z.object({
  items: z.array(wxoaPublishVo),
})
export type WxoaPublishPullResult = z.infer<typeof wxoaPublishPullResult>
export const wxoaPublishAccountRef = wxoaAccountRef
