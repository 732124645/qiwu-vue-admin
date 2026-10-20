import { WXOA_STAT_METRICS, type WxoaStatGroup, type WxoaStatVo } from '@qiwu/shared'
import { api } from '@/core/request/http'

export type { WxoaStatGroup, WxoaStatVo }
/** 四组统计，顺序即页面上图表的顺序。 */
export const WXOA_STAT_GROUPS = Object.keys(WXOA_STAT_METRICS) as WxoaStatGroup[]
export interface WxoaStatParams {
  accountId: number
  from: string
  to: string
}

/** /api/wxoa/stats/<组>：微信数据统计（服务端按接口窗口切分，并缓存过去日期的结果）。 */
export const wxoaStatApi = {
  group: (group: WxoaStatGroup, params: WxoaStatParams) =>
    api.get<WxoaStatVo>(`/wxoa/stats/${group}`, { params }),
}
