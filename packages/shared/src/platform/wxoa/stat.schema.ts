import { z } from 'zod'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { wxoaQueryId } from './wxoa.schema.js'

export const WXOA_STAT_MAX_DAYS = 90
const date = z.iso.date()
export const wxoaStatQuery = z
  .object({
    accountId: wxoaQueryId,
    from: date,
    to: date,
  })
  .superRefine((v, ctx) => {
    const from = Date.parse(`${v.from}T00:00:00Z`)
    const to = Date.parse(`${v.to}T00:00:00Z`)
    const days = Math.floor((to - from) / 86_400_000) + 1
    if (to < from) ctx.addIssue({ code: 'custom', path: ['to'], message: 'validation.invalid' })
    else if (days > WXOA_STAT_MAX_DAYS)
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'validation.too_big.date',
        params: { maximum: WXOA_STAT_MAX_DAYS },
      })
  })
  .register(fieldDomains, { domain: 'wxoa.stat' })
export type WxoaStatQuery = z.output<typeof wxoaStatQuery>
/**
 * 各组图表的指标键（`wxoa.stat.metric.<key>` 是其显示名）：用户、消息、接口、图文四组，
 * 都是按天汇总的数值，维度字段（来源渠道、消息类型、阅读场景）已汇总掉。
 */
export const WXOA_STAT_METRICS = {
  users: ['new_user', 'cancel_user', 'cumulate_user'],
  messages: ['msg_user', 'msg_count'],
  interfaces: ['callback_count', 'fail_count', 'total_time_cost', 'max_time_cost'],
  articles: [
    'read_user',
    'share_user',
    'zaikan_user',
    'like_user',
    'comment_count',
    'collection_user',
    'redirect_ori_page_user',
    'send_page_count',
  ],
} as const
export type WxoaStatGroup = keyof typeof WXOA_STAT_METRICS
/** 上游原始统计行（只在服务端缓存中使用） */
export const wxoaStatPoint = z.record(z.string(), z.unknown())
export const wxoaStatSeries = z.object({ key: z.string(), values: z.array(z.number()) })
/** 图表数据：`dates` 是区间内已查询的每一天（今天不查），每条序列的 `values` 与其一一对应。 */
export const wxoaStatVo = z.object({
  from: date,
  to: date,
  dates: z.array(date),
  series: z.array(wxoaStatSeries),
})
export type WxoaStatVo = z.infer<typeof wxoaStatVo>
