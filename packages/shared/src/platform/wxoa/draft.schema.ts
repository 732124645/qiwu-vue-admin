import { z } from 'zod'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { wxoaAccountRef, wxoaHttpUrl, wxoaId, wxoaQueryId } from './wxoa.schema.js'

export const WXOA_ARTICLE_MAX = 8
export const WXOA_CONTENT_MAX = 20_000

export const wxoaDraftArticle = z.object({
  title: z.string().trim().min(1).max(64),
  author: z.string().trim().max(64).default(''),
  digest: z.string().trim().max(120).default(''),
  content: z.string().max(WXOA_CONTENT_MAX),
  // 原文链接只接受 http(s)，挡住 javascript:/data: 之类可执行地址
  contentSourceUrl: wxoaHttpUrl().optional().or(z.literal('')),
  thumbMediaId: z.string().trim().max(128).min(1),
  needOpenComment: z.boolean().default(true),
  onlyFansCanComment: z.boolean().default(false),
})
export type WxoaDraftArticle = z.infer<typeof wxoaDraftArticle>

export const wxoaDraftCreate = z
  .object({
    accountId: wxoaQueryId,
    articles: z.array(wxoaDraftArticle).min(1).max(WXOA_ARTICLE_MAX),
  })
  .register(fieldDomains, { domain: 'wxoa.draft' })
export type WxoaDraftCreate = z.output<typeof wxoaDraftCreate>

// 严格对象：修改草稿时不能顺带改归属账号，多余字段（如 accountId）一律 400
export const wxoaDraftUpdate = z
  .strictObject({
    articles: z.array(wxoaDraftArticle).min(1).max(WXOA_ARTICLE_MAX),
  })
  .register(fieldDomains, { domain: 'wxoa.draft' })
export type WxoaDraftUpdate = z.output<typeof wxoaDraftUpdate>

export const wxoaDraftQuery = pageQuery(['updatedAt', 'createdAt', 'id'])
  .extend({
    accountId: wxoaQueryId,
    /** 首篇标题模糊搜索 */
    title: z.string().trim().max(64).optional(),
  })
  .register(fieldDomains, { domain: 'wxoa.draft' })
export type WxoaDraftQuery = z.output<typeof wxoaDraftQuery>

export const wxoaDraftVo = z.object({
  id: wxoaId,
  accountId: wxoaId,
  title: z.string(),
  articles: z.array(wxoaDraftArticle),
  mediaId: z.string().nullable(),
  origin: z.enum(['local', 'pulled']),
  syncedAt: z.iso.datetime().nullable(),
  syncedDigest: z.string().nullable(),
  /** 有未同步到草稿箱的本地修改（或从未同步过） */
  dirty: z.boolean(),
  updatedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
})
export type WxoaDraftVo = z.infer<typeof wxoaDraftVo>

export const wxoaDraftSyncResult = z.object({
  draft: wxoaDraftVo,
  unsyncedImages: z.array(z.object({ src: z.string(), reason: z.string() })),
})
export type WxoaDraftSyncResult = z.infer<typeof wxoaDraftSyncResult>

export const wxoaDraftPullResult = z.object({
  items: z.array(wxoaDraftVo),
  failed: z.array(
    z.object({ mediaId: z.string(), title: z.string().nullable(), reason: z.string() }),
  ),
})
export type WxoaDraftPullResult = z.infer<typeof wxoaDraftPullResult>

export const wxoaDraftId = z.object({ id: wxoaId })
export const wxoaDraftAccountRef = wxoaAccountRef
