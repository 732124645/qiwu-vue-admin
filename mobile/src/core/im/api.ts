// 聊天接口端口（共同引擎的 `ImApi`）：普通读写走 core/request（统一的令牌刷新与错误），带 ETag 的 GET
// 与附件下载在这里直接用 uni.request / uni.downloadFile —— 请求层没有 `If-None-Match` 与 304。令牌取
// `currentAccessToken()`，401 时 `refreshAccessToken()` 一次再重发；换了登录身份的迟到结果丢弃。
import type {
  ImDirectory,
  ImEntries,
  ImEntriesQuery,
  ImEntry,
  ImOptions,
  ImRead,
  ImRoomDetail,
  ImSticker,
  ImSync,
  ImUpload,
} from '@qiwu/shared'
import type { ImApi, ImConditional, ImOutboxFile } from '@qiwu/shared/im-client'
import { locale } from '../i18n'
import {
  ApiError,
  CLIENT_HEADER,
  api,
  currentAccessToken,
  currentSessionVersion,
  refreshAccessToken,
  upload,
} from '../request'

/** 同 core/request：H5 走代理，小程序/App 用完整地址。 */
export const BASE: string = import.meta.env.VITE_API_BASE || '/api'
const TIMEOUT = 30_000
const silent = { silent: true }

/** 当前会话的请求头（与 core/request 相同的客户端标识、语言与令牌）。 */
export function imHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...CLIENT_HEADER, 'Accept-Language': locale(), ...extra }
  const token = currentAccessToken()
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

/** 不区分大小写取响应头。 */
export const headerOf = (header: unknown, name: string): string | null => {
  if (!header || typeof header !== 'object') return null
  const hit = Object.entries(header as Record<string, unknown>).find(
    ([k]) => k.toLowerCase() === name.toLowerCase(),
  )
  return hit && typeof hit[1] === 'string' ? hit[1] : null
}

/** 一次底层调用的结果。 */
export interface RawAnswer {
  statusCode: number
  data: unknown
  header?: unknown
}

/**
 * 发一次带登录令牌的底层请求：401 时刷新一次令牌再重发（重发读新令牌）；刷新被拒（会话过期）原样抛
 * 401，由宿主锁定缓存。期间换了登录身份 → 抛 401，迟到结果不应用。
 */
export async function withAuth(send: () => Promise<RawAnswer>): Promise<RawAnswer> {
  const at = currentSessionVersion()
  const sent = currentAccessToken()
  let res = await send().catch((e: unknown) => {
    throw new ApiError(0, 'network', String((e as { errMsg?: string })?.errMsg ?? e))
  })
  if (res.statusCode === 401 && at === currentSessionVersion()) {
    try {
      // 别的请求已刷新过（令牌变了）就只重发
      if (!currentAccessToken() || currentAccessToken() === sent) await refreshAccessToken()
    } catch (e) {
      // 刷新被拒 = 会话过期（请求层已结束会话）；断网/5xx 按原错误交给引擎退避
      throw e instanceof ApiError && e.status === 401
        ? new ApiError(401, 'session_expired', 'session expired')
        : e
    }
    res = await send().catch((e: unknown) => {
      throw new ApiError(0, 'network', String((e as { errMsg?: string })?.errMsg ?? e))
    })
  }
  if (at !== currentSessionVersion()) throw new ApiError(401, 'session_changed', 'session changed')
  return res
}

/** 把非 2xx 的包络变成 ApiError（状态码 + 业务码）。 */
function fail(res: RawAnswer): ApiError {
  const body = (res.data && typeof res.data === 'object' ? res.data : {}) as {
    code?: string | number
    msg?: string
  }
  return new ApiError(
    res.statusCode,
    body.code ?? res.statusCode,
    body.msg || `HTTP ${res.statusCode}`,
  )
}

/** 带 ETag 的 GET：发 `If-None-Match`，304 没有数据。 */
export async function conditionalGet<T>(
  url: string,
  etag: string | null,
  query?: Record<string, string>,
): Promise<ImConditional<T>> {
  const res = await withAuth(
    () =>
      new Promise<RawAnswer>((resolve, reject) =>
        uni.request({
          url: BASE + url,
          data: query,
          header: imHeaders(etag ? { 'If-None-Match': etag } : {}),
          timeout: TIMEOUT,
          success: resolve,
          fail: reject,
        }),
      ),
  )
  const tag = headerOf(res.header, 'etag')
  if (res.statusCode === 304) return { status: 304, etag: tag ?? etag }
  const body = res.data as { code?: number; data?: T } | null
  if (res.statusCode === 200 && body?.code === 0)
    return { status: 200, etag: tag, data: body.data as T }
  throw fail(res)
}

/** 查询串：数组编为逗号分隔，undefined 不发（uni 会把它发成空值）。 */
const query = (q: Partial<ImEntriesQuery>) => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(q))
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(',') : String(v)
  return out
}

/** 消息附件的地址（`proxy=1`：同源输出，令牌不出站）。 */
export const entryFileUrl = (roomId: number, seq: number, thumb: boolean) =>
  `/im/rooms/${roomId}/entries/${seq}/file?${thumb ? 'thumb=1&' : ''}proxy=1`
/** 本人自定义表情的地址。 */
export const stickerFileUrl = (id: number) => `/im/stickers/${id}/file?proxy=1`

/** 发件箱的本地文件是否还在：App 按路径解析文件，H5 读一下 blob 地址（读到就取消，不留正文）。 */
export function localFileExists(ref: string): Promise<boolean> {
  if (process.env.UNI_PLATFORM === 'app')
    return new Promise((resolve) =>
      plus.io.resolveLocalFileSystemURL(
        ref,
        () => resolve(true),
        () => resolve(false),
      ),
    )
  return fetch(ref).then(
    (res) => {
      void res.body?.cancel().catch(() => {})
      return res.ok
    },
    () => false,
  )
}

/** 共同引擎用的接口实现。 */
export const imApi: ImApi = {
  options: () => api.get<ImOptions>('/im/options', undefined, silent),
  sync: (etag) => conditionalGet<ImSync>('/im/sync', etag),
  syncDetails: (ids) => api.get<ImRoomDetail[]>('/im/sync', { ids: ids.join(',') }, silent),
  entries: (roomId, q) => api.get<ImEntries>(`/im/rooms/${roomId}/entries`, query(q), silent),
  upload: async (roomId, file: ImOutboxFile, kind) => {
    const path = `/im/rooms/${roomId}/${kind === 'voice' ? 'voice-uploads' : 'uploads'}`
    // H5 的语音正文随发件箱持久保存；上传不依赖刷新后失效的对象地址。
    if (process.env.UNI_PLATFORM === 'h5' && file.body instanceof Blob) {
      const form = new FormData()
      form.append('file', file.body, file.name)
      const response = await withAuth(async () => {
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), TIMEOUT)
        try {
          const result = await fetch(BASE + path, {
            method: 'POST',
            headers: imHeaders(),
            body: form,
            signal: abort.signal,
          })
          return { statusCode: result.status, data: await result.json().catch(() => null) }
        } finally {
          clearTimeout(timer)
        }
      })
      const body = response.data as { code?: number; data?: ImUpload } | null
      if (response.statusCode >= 200 && response.statusCode < 300 && body?.code === 0 && body.data)
        return body.data
      throw fail(response)
    }
    // 本地文件已不在（H5 重新加载后 blob 地址失效、App 临时文件被系统清理）：按 400 处理，引擎标失败交用户
    // 处理；不能当成断网，否则同一会话后面的消息要陪它退避 24 小时
    if (!(await localFileExists(file.localRef)))
      throw new ApiError(400, 'local', 'local file missing')
    return upload<ImUpload>(path, file.localRef, undefined, silent)
  },
  send: (roomId, body) => api.post<ImEntry>(`/im/rooms/${roomId}/entries`, body, silent),
  edit: (roomId, seq, body) => api.put<ImEntry>(`/im/rooms/${roomId}/entries/${seq}`, body, silent),
  recall: (roomId, seq) =>
    api.post<ImEntry>(`/im/rooms/${roomId}/entries/${seq}/recall`, undefined, silent),
  read: (roomId, seq) => api.put<ImRead>(`/im/rooms/${roomId}/read`, { seq }, silent),
  directory: (etag) => conditionalGet<ImDirectory>('/im/directory', etag),
  stickers: (etag) => conditionalGet<ImSticker[]>('/im/stickers', etag),
}

/** H5：带令牌下载附件为 Blob（同源代理输出）。 */
export async function downloadBlob(url: string): Promise<Blob> {
  const res = await withAuth(
    () =>
      new Promise<RawAnswer>((resolve, reject) =>
        uni.request({
          url: BASE + url,
          header: imHeaders(),
          responseType: 'arraybuffer',
          timeout: TIMEOUT,
          success: resolve,
          fail: reject,
        }),
      ),
  )
  if (res.statusCode !== 200 || !(res.data instanceof ArrayBuffer))
    throw new ApiError(res.statusCode, res.statusCode, `HTTP ${res.statusCode}`)
  const type = headerOf(res.header, 'content-type') ?? 'application/octet-stream'
  return new Blob([res.data], { type })
}
