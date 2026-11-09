import type { ImCall, ImCallGrant } from '@qiwu/shared'
import type { ImCallApi } from '@qiwu/shared/im-client'
import { api } from '../request'
import { imCurrent } from './client'

const silent = { silent: true }
/** H5 同账号只允许既有 Web Lock 主标签页写通话状态，旧标签页不能结束新标签页的媒体租约。 */
export function canWriteImCall(): boolean {
  return (
    process.env.UNI_PLATFORM !== 'h5' ||
    (typeof navigator !== 'undefined' && !!navigator.locks && imCurrent()?.leader === true)
  )
}
const write = <T>(url: string, body: object): Promise<T> =>
  canWriteImCall()
    ? api.post<T>(url, body, silent)
    : Promise.reject({ code: 'NOT_LEADER', operation: 'call' })
/** 通话元数据只走鉴权接口，票据仅由 join 的调用栈短暂持有。 */
export const imCallApi: ImCallApi = {
  active: () => api.get<ImCall[]>('/im/calls/active', undefined, silent),
  get: (id) => api.get<ImCall>(`/im/calls/${id}`, undefined, silent),
  create: (roomId, body) => write<ImCall>(`/im/rooms/${roomId}/calls`, body),
  accept: (id) => write<ImCall>(`/im/calls/${id}/accept`, {}),
  decline: (id) => write<ImCall>(`/im/calls/${id}/decline`, {}),
  join: (id) => write<ImCallGrant>(`/im/calls/${id}/join`, {}),
  leave: (id) => write<ImCall>(`/im/calls/${id}/leave`, {}),
  end: (id) => write<ImCall>(`/im/calls/${id}/end`, {}),
  heartbeat: (id) => write<ImCall>(`/im/calls/${id}/heartbeat`, {}),
}
