import { z } from 'zod'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { wxoaQueryId } from './wxoa.schema.js'

export const WXOA_COMMENT_PAGE_MAX = 49

const parent = z.object({
  accountId: wxoaQueryId,
  // 微信的 msg_data_id、user_comment_id 都是数字；按十进制串传递，避免超出 JS 安全整数
  msgDataId: z
    .string()
    .trim()
    .regex(/^\d{1,20}$/),
  index: z.coerce.number().int().min(0),
})
export const wxoaCommentQuery = pageQuery(['createTime', 'id'])
  .extend({
    // 微信 comment/list 的 count 达到 50 即拒绝，故每页最多 49 条
    pageSize: z.coerce.number().int().min(1).max(WXOA_COMMENT_PAGE_MAX).default(20),
    ...parent.shape,
    type: z.enum(['all', 'elect']).default('all'),
  })
  .register(fieldDomains, { domain: 'wxoa.comment' })
export type WxoaCommentQuery = z.output<typeof wxoaCommentQuery>
export const wxoaCommentOpen = parent
export type WxoaCommentOpen = z.infer<typeof wxoaCommentOpen>
export const wxoaCommentElect = parent.extend({
  commentId: z
    .string()
    .trim()
    .regex(/^\d{1,20}$/),
})
export type WxoaCommentElect = z.infer<typeof wxoaCommentElect>
export const wxoaCommentReply = wxoaCommentElect.extend({
  content: z.string().trim().min(1).max(1000),
})
export type WxoaCommentReply = z.infer<typeof wxoaCommentReply>
export const wxoaCommentVo = z.object({
  userCommentId: z.string(),
  openId: z.string().nullable(),
  createTime: z.string().nullable(),
  content: z.string(),
  isElect: z.boolean().optional(),
  reply: z.object({ content: z.string(), createTime: z.string().nullable() }).nullable().optional(),
})
export type WxoaCommentVo = z.infer<typeof wxoaCommentVo>
