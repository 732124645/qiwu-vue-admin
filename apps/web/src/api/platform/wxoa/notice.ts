import type {
  WxoaMessageVo,
  WxoaNoticeAdd,
  WxoaNoticeLibraryVo,
  WxoaNoticeSend,
  WxoaNoticeTemplateVo,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/wxoa/notice-templates'

type Library = WxoaNoticeLibraryVo
/** 模板库三种应答之一（按带的参数） */
type LibraryOf<K extends string> = Extract<Library, Record<K, unknown>>
export type WxoaNoticeCategory = LibraryOf<'categories'>['categories'][number]
export type WxoaNoticeTitle = LibraryOf<'titles'>['titles'][number]
export type WxoaNoticeKeyword = LibraryOf<'keywords'>['keywords'][number]
const library = <T>(params: Record<string, unknown>) =>
  api.get<Library>(`${BASE}/library`, { params }) as Promise<T>

/** /api/wxoa/notice-templates：订阅通知模板库、我的模板与发送。 */
export const wxoaNoticeApi = {
  list: (accountId: number, refresh = false) =>
    api.get<WxoaNoticeTemplateVo[]>(BASE, {
      params: { accountId, ...(refresh ? { refresh: true } : {}) },
    }),
  /** 模板库的类目 */
  categories: async (accountId: number) =>
    (await library<LibraryOf<'categories'>>({ accountId })).categories,
  /** 某个类目下的公共模板标题，每页 30 条，`start` 翻页 */
  titles: (accountId: number, categoryId: number, start = 0) =>
    library<LibraryOf<'titles'>>({ accountId, categoryId: Number(categoryId), start }),
  /** 某个模板标题的关键词，选用模板时从中挑 2–5 个 */
  keywords: async (accountId: number, tid: string) =>
    (await library<LibraryOf<'keywords'>>({ accountId, tid })).keywords,
  /** 选用公共模板，返回本账号的模板 ID */
  add: (body: WxoaNoticeAdd) => api.post<{ priTmplId: string }>(BASE, body),
  remove: (priTmplId: string, accountId: number) =>
    api.delete(`${BASE}/${encodeURIComponent(priTmplId)}`, { params: { accountId } }),
  /** 每个粉丝一条待发记录，服务端应答后逐个发送 */
  send: (priTmplId: string, body: WxoaNoticeSend) =>
    api.post<WxoaMessageVo[]>(`${BASE}/${encodeURIComponent(priTmplId)}/send`, body),
}
