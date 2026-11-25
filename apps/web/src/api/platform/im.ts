import type { AxiosProgressEvent } from 'axios'
import type {
  ImDirectory,
  ImEntries,
  ImEntriesQuery,
  ImEntry,
  ImEntryEdit,
  ImEntrySend,
  ImMember,
  ImOptions,
  ImRead,
  ImRoomDetail,
  ImSticker,
  ImSync,
  ImUpload,
  ImCall,
  ImCallCreate,
  ImCallGrant,
} from '@qiwu/shared'
import type { ImConditional } from '@qiwu/shared/im-client'
import { ApiError, api, fetchBlob, http } from '@/core/request/http'

/**
 * 员工聊天接口（`/api/im`）。同步类请求一律 `silent`：失败由本地优先引擎按状态处理（离线、锁定、
 * 停用），不弹提示；群管理等用户动作走默认提示。
 */
const SILENT = { silent: true } as const

/** 带 `If-None-Match` 的 GET：304 时没有数据（不进浏览器 HTTP 缓存之外的任何逻辑）。 */
async function conditional<T>(
  url: string,
  etag: string | null,
  params?: Record<string, unknown>,
): Promise<ImConditional<T>> {
  const res = await http.get<{ code: number; data: T; msg?: string }>(url, {
    ...SILENT,
    params,
    headers: etag ? { 'If-None-Match': etag } : {},
    validateStatus: (s) => s === 200 || s === 304,
  })
  const tag = (res.headers['etag'] as string | undefined) ?? null
  if (res.status === 304) return { status: 304, etag: tag ?? etag }
  if (res.data.code !== 0) throw new ApiError(res.status, res.data.code, res.data.msg ?? '')
  return { status: 200, etag: tag, data: res.data.data }
}

/** 查询串：`seqs` 逗号分隔。 */
const entriesParams = (q: Partial<ImEntriesQuery>) => ({
  ...q,
  ...(q.seqs ? { seqs: q.seqs.join(',') } : {}),
})

export const imApi = {
  options: () => api.get<ImOptions>('/im/options', SILENT),
  sync: (etag: string | null) => conditional<ImSync>('/im/sync', etag),
  syncDetails: (ids: readonly number[]) =>
    api.get<ImRoomDetail[]>('/im/sync', { ...SILENT, params: { ids: ids.join(',') } }),
  directory: (etag: string | null) => conditional<ImDirectory>('/im/directory', etag),
  stickers: (etag: string | null) => conditional<ImSticker[]>('/im/stickers', etag),
  entries: (roomId: number, q: Partial<ImEntriesQuery>) =>
    api.get<ImEntries>(`/im/rooms/${roomId}/entries`, { ...SILENT, params: entriesParams(q) }),
  /** 上传附件（未绑定，发送时才绑定）；`onProgress` 报 0–1 的进度。 */
  upload: (
    roomId: number,
    file: Blob,
    name: string,
    onProgress?: (ratio: number) => void,
    kind?: import('@qiwu/shared').ImSendKind,
  ) => {
    const form = new FormData()
    form.append('file', file, name)
    return api.post<ImUpload>(
      `/im/rooms/${roomId}/${kind === 'voice' ? 'voice-uploads' : 'uploads'}`,
      form,
      {
        ...SILENT,
        timeout: 0,
        onUploadProgress: (e: AxiosProgressEvent) => e.total && onProgress?.(e.loaded / e.total),
      },
    )
  },
  send: (roomId: number, body: ImEntrySend) =>
    api.post<ImEntry>(`/im/rooms/${roomId}/entries`, body, SILENT),
  edit: (roomId: number, seq: number, body: ImEntryEdit) =>
    api.put<ImEntry>(`/im/rooms/${roomId}/entries/${seq}`, body, SILENT),
  recall: (roomId: number, seq: number) =>
    api.post<ImEntry>(`/im/rooms/${roomId}/entries/${seq}/recall`, null, SILENT),
  read: (roomId: number, seq: number) =>
    api.put<ImRead>(`/im/rooms/${roomId}/read`, { seq }, SILENT),
  /** 消息附件（缩略图 `thumb`）：授权后以 Blob 取回，页面用对象 URL 显示，不暴露令牌。 */
  entryFile: (roomId: number, seq: number, thumb = false) =>
    fetchBlob(`/im/rooms/${roomId}/entries/${seq}/file`, thumb ? { thumb: 1 } : {}, {
      ...SILENT,
      timeout: 0,
    }),
  stickerFile: (id: number) => fetchBlob(`/im/stickers/${id}/file`, {}, SILENT),

  // 会话与群管理（用户动作，失败照常提示）
  openDirect: (peerId: number) => api.post<ImRoomDetail>('/im/rooms/directs', { peerId }),
  createGroup: (label: string, userIds: number[]) =>
    api.post<ImRoomDetail>('/im/rooms/groups', { label, userIds }),
  members: (roomId: number) => api.get<ImMember[]>(`/im/rooms/${roomId}/members`),
  addMembers: (roomId: number, userIds: number[]) =>
    api.post<ImRoomDetail>(`/im/rooms/${roomId}/members`, { userIds }),
  removeMember: (roomId: number, userId: number) =>
    api.delete<ImRoomDetail>(`/im/rooms/${roomId}/members/${userId}`),
  leave: (roomId: number) => api.post<null>(`/im/rooms/${roomId}/leave`),
  transfer: (roomId: number, userId: number) =>
    api.put<ImRoomDetail>(`/im/rooms/${roomId}/owner`, { userId }),
  setRole: (roomId: number, userId: number, role: 'moderator' | 'participant') =>
    api.put<ImRoomDetail>(`/im/rooms/${roomId}/members/${userId}/role`, { role }),
  rename: (roomId: number, label: string) =>
    api.put<ImRoomDetail>(`/im/rooms/${roomId}/label`, { label }),
  close: (roomId: number) => api.post<ImRoomDetail>(`/im/rooms/${roomId}/close`),

  // 我的表情
  uploadSticker: (file: Blob, name: string) => {
    const form = new FormData()
    form.append('file', file, name)
    return api.post<ImSticker>('/im/stickers', form)
  },
  stickerFromEntry: (roomId: number, seq: number) =>
    api.post<ImSticker>('/im/stickers/from-entry', { roomId, seq }),
  removeSticker: (id: number) => api.delete<null>(`/im/stickers/${id}`),
  /** 按给出的顺序重排我的表情（列表里的在前） */
  reorderStickers: (ids: number[]) => api.put<null>('/im/stickers/order', { ids }),
}

/** 通话业务接口不缓存票据；join 响应仅交给媒体连接函数。 */
export const imCallApi = {
  active: () => api.get<ImCall[]>('/im/calls/active', SILENT),
  get: (id: number) => api.get<ImCall>(`/im/calls/${id}`, SILENT),
  create: (roomId: number, body: ImCallCreate) =>
    api.post<ImCall>(`/im/rooms/${roomId}/calls`, body, SILENT),
  accept: (id: number) => api.post<ImCall>(`/im/calls/${id}/accept`, {}, SILENT),
  decline: (id: number) => api.post<ImCall>(`/im/calls/${id}/decline`, {}, SILENT),
  join: (id: number) => api.post<ImCallGrant>(`/im/calls/${id}/join`, {}, SILENT),
  leave: (id: number) => api.post<ImCall>(`/im/calls/${id}/leave`, {}, SILENT),
  end: (id: number) => api.post<ImCall>(`/im/calls/${id}/end`, {}, SILENT),
  heartbeat: (id: number) => api.post<ImCall>(`/im/calls/${id}/heartbeat`, {}, SILENT),
}
