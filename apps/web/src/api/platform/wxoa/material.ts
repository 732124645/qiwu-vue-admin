import type { Page, WxoaMaterialVo, WxoaMediaKind, WxoaSyncVo } from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/wxoa/materials'
// a 10 MiB video on a slow line outlives the default 30 s: it is stored here, then sent on to WeChat
const UPLOAD_TIMEOUT = 10 * 60_000

export interface WxoaMaterialUploadFields {
  accountId: number
  mediaKind: WxoaMediaKind
  /** video only (then required, with `intro`) */
  title?: string
  intro?: string
}

/** /api/wxoa/materials: an account's permanent materials; the list names the account (`accountId`). */
export const wxoaMaterialApi = {
  page: (params: Record<string, unknown>) => api.get<Page<WxoaMaterialVo>>(BASE, { params }),
  /** multipart: the fields first, then the file */
  upload(fields: WxoaMaterialUploadFields, file: File, onProgress?: (percent: number) => void) {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields))
      if (v != null && v !== '') form.append(k, String(v))
    form.append('file', file)
    return api.post<WxoaMaterialVo>(BASE, form, {
      timeout: UPLOAD_TIMEOUT,
      onUploadProgress: (e) => e.total && onProgress?.(Math.round((e.loaded / e.total) * 100)),
    })
  },
  /** deletes it on WeChat too; one an auto-reply rule uses → 409 */
  remove: (id: number) => api.delete(`${BASE}/${id}`),
  /** starts the material sync in the background (`B6010` while one runs) */
  sync: (accountId: number) => api.post(`${BASE}/sync`, { accountId }),
  syncState: (accountId: number) => api.get<WxoaSyncVo>(`${BASE}/sync`, { params: { accountId } }),
}
