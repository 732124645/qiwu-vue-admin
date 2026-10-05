import axios from 'axios'
import type {
  FsObjectRowVo,
  FsObjectVo,
  FsPresignBody,
  FsPresignVo,
  Page,
  StorageBizTag,
} from '@qiwu/shared'
import { i18n } from '@/core/i18n'
import { api, ApiError, download, fetchBlob } from '@/core/request/http'

const BASE = '/storage/objects'
// a large file on a slow line outlives the default 30 s; the progress shows it is alive
const UPLOAD_TIMEOUT = 10 * 60_000

/**
 * /api/storage/objects (see docs/design-notes.md#storage): upload, private objects read with the access token, and the file
 * list (list, export, delete one object).
 */
export const storageApi = {
  page: (params: Record<string, unknown>) => api.get<Page<FsObjectRowVo>>(BASE, { params }),
  /**
   * deletes the object: it stops being served at once (its public link too), the stored file is purged
   * after the retention period (`audit.purge`)
   */
  remove: (id: number) => api.delete(`${BASE}/${id}`),
  exportFile: (params: Record<string, unknown>, filename: string) =>
    download(`${BASE}/export`, params, filename),
  /** multipart `bizTag` + `file` (the tag first: the server decides public/private before the bytes) */
  upload(file: File, bizTag: StorageBizTag, onProgress?: (percent: number) => void) {
    const form = new FormData()
    form.append('bizTag', bizTag)
    form.append('file', file)
    return api.post<FsObjectVo>(BASE, form, {
      timeout: UPLOAD_TIMEOUT,
      onUploadProgress: (e) => e.total && onProgress?.(Math.round((e.loaded / e.total) * 100)),
    })
  },
  /**
   * Direct upload to the primary S3 storage (see docs/design-notes.md#storage): `POST /presign` (the server checks name,
   * size and tag as for an upload; a local primary storage refuses: 422), then the file is PUT straight to
   * the signed URL with exactly the signed headers — a bare request, never this app's token, cookies or
   * headers — and `POST /confirm` registers it (the server re-reads the stored bytes). Resolves to the
   * stored object like `upload`. The storage's own error answer is never shown: a failed PUT rejects with
   * one generic message (an `ApiError` of status 0, the upload fields show it).
   */
  async uploadDirect(file: File, bizTag: StorageBizTag, onProgress?: (percent: number) => void) {
    const body: FsPresignBody = {
      filename: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      bizTag,
    }
    const signed = await api.post<FsPresignVo>(`${BASE}/presign`, body)
    try {
      await axios.put(signed.url, file, {
        headers: signed.headers,
        // the bytes as they are (never serialized, whatever the signed Content-Type says)
        transformRequest: (data: File) => data,
        timeout: UPLOAD_TIMEOUT,
        onUploadProgress: (e) => e.total && onProgress?.(Math.round((e.loaded / e.total) * 100)),
      })
    } catch {
      throw new ApiError(0, 'upload.direct', i18n.global.t('upload.error.direct'))
    }
    return api.post<FsObjectVo>(`${BASE}/confirm`, { key: signed.key })
  },
  /** a private object's bytes (`<img>` cannot send the Bearer token: preview via an object URL) */
  blob: (id: number) => fetchBlob(`${BASE}/${id}/download`),
  /** saves a private object under its original name */
  download: (o: Pick<FsObjectVo, 'id' | 'originalName'>) =>
    download(`${BASE}/${o.id}/download`, {}, o.originalName),
}
