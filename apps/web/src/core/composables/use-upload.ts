import { computed, ref, watch, type Ref } from 'vue'
import { ElMessage, type UploadRawFile, type UploadRequestOptions } from 'element-plus'
import {
  STORAGE_IMAGE_MIMES,
  STORAGE_MAX_SIZE_DEFAULT,
  storageMaxBytes,
  storageParams,
  type FsObjectVo,
  type StorageBizTag,
  type UploadKind,
  uploadsOf,
  uploadText,
} from '@qiwu/shared'
import { publicParamApi } from '@/api/platform/settings/public-param'
import { storageApi } from '@/api/platform/storage/object'
import { currentLocale, i18n } from '@/core/i18n'
import { ApiError } from '@/core/request/http'

const t = (key: string, params: Record<string, unknown> = {}) => i18n.global.t(key, params)

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const

/** Bytes for people, in the current locale: 1536 → "1.5 kB". */
export function formatSize(bytes: number): string {
  let n = bytes
  let i = 0
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024
    i++
  }
  return new Intl.NumberFormat(currentLocale(), {
    style: 'unit',
    unit: UNITS[i],
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(n)
}

/** The image types every browser shows and the public tags accept (the server sniffs the bytes). */
export const IMAGE_ACCEPT = STORAGE_IMAGE_MIMES.join(',')
export const isImage = (type: string) => (STORAGE_IMAGE_MIMES as readonly string[]).includes(type)

/**
 * The request layer toasts 403/409/422/429/5xx and network errors; an upload also shows these, and a
 * direct upload's failed PUT to the storage (status 0, `storageApi.uploadDirect`).
 */
export function toastUploadError(e: unknown) {
  if (e instanceof ApiError && [0, 400, 404, 413, 415].includes(e.status))
    ElMessage.error(e.message)
}

let serverLimit: Promise<number> | undefined
/**
 * The server's upload limit in bytes (public param `storage.max_size_mb`), read once per page
 * load; the default when unreadable. An admin's change reaches an open page on reload only
 * (the server checks every upload anyway); re-read per upload if that ever matters.
 */
export const uploadMaxSize = () =>
  (serverLimit ??= publicParamApi.get(storageParams.maxSizeMb).then(
    (p) => storageMaxBytes(p.value),
    () => STORAGE_MAX_SIZE_DEFAULT,
  ))

export interface PendingUpload {
  uid: number
  name: string
  percent: number
}

/**
 * The upload part of ImageUpload / FileUpload, for an el-upload with `:show-file-list="false"`:
 * `check` (its `before-upload`: count, type and size, then the file is `pending`) and `send` (its
 * `http-request`: POST /api/storage/objects, or with `direct` the presign → PUT to the storage → confirm
 * of `storageApi.uploadDirect`; the stored object appended to `model`) and `remove`. The client checks are
 * for quick feedback only; the server sniffs, whitelists and limits again.
 */
export function useUpload(o: {
  model: Ref<FsObjectVo[]>
  bizTag: () => StorageBizTag
  limit: () => number
  /** bytes; unset: the server's limit ({@link uploadMaxSize}) */
  maxSize: () => number | undefined
  images?: boolean
  /** upload straight to the primary S3 storage (off: through the server) */
  direct?: () => boolean
}) {
  const pending = ref<PendingUpload[]>([])
  const serverMax = ref(STORAGE_MAX_SIZE_DEFAULT)
  void uploadMaxSize().then((v) => (serverMax.value = v))
  const maxSize = () => o.maxSize() ?? serverMax.value
  // a v-model update reaches the prop only once the parent re-renders: uploads that finish in the same
  // tick build on the list emitted last, not on the stale prop (which would drop all but one of them)
  let emitted: FsObjectVo[] | null = null
  watch(o.model, () => (emitted = null), { flush: 'sync' })
  const current = () => emitted ?? o.model.value
  function update(list: FsObjectVo[]) {
    emitted = list
    o.model.value = list
  }
  const remaining = () => o.limit() - current().length - pending.value.length

  // called for each picked file in turn, before any of them uploads: `pending` counts toward the limit
  function check(file: UploadRawFile): boolean {
    const fail = (key: string, type: 'warning' | 'error' = 'error') => {
      // grouping: one toast for several files picked over the limit
      ElMessage[type]({
        grouping: true,
        message: t(key, { name: file.name, limit: o.limit(), size: formatSize(maxSize()) }),
      })
      return false
    }
    if (remaining() <= 0) return fail('upload.error.limit', 'warning')
    if (o.images && !isImage(file.type)) return fail('upload.error.imageOnly')
    if (file.size > maxSize()) return fail('upload.error.tooLarge')
    pending.value.push({ uid: file.uid, name: file.name, percent: 0 })
    return true
  }

  async function send({ file }: UploadRequestOptions) {
    const item = pending.value.find((p) => p.uid === file.uid)
    try {
      const upload = o.direct?.() ? storageApi.uploadDirect : storageApi.upload
      const stored = await upload(file, o.bizTag(), (p) => {
        if (item) item.percent = p
      })
      update([...current(), stored])
    } catch (e) {
      toastUploadError(e)
    } finally {
      pending.value = pending.value.filter((p) => p.uid !== file.uid)
    }
  }

  /** drops the object from the list (the stored object stays) */
  const remove = (x: FsObjectVo) => update(current().filter((y) => y !== x))

  return { pending, remaining, maxSize, check, send, remove }
}

// the text forms of an upload (`uploadName`, `fileRef`, `fromFileRef`, `uploadsOf` / `uploadText`) live in
// @qiwu/shared: mobile's generated pages use them too
export { fileRef, fromFileRef, uploadName } from '@qiwu/shared'

/**
 * One upload kept in a text column (generated forms, `image-upload` / `file-upload`; see docs/design-notes.md#codegen) as the
 * upload fields' `v-model`: an image column holds the image's public URL (upload it under a public tag,
 * `cover`), a file column a {@link fileRef}. Removing the upload leaves ''.
 */
export function uploadField(model: Record<string, unknown>, field: string, kind: UploadKind) {
  return computed<FsObjectVo[]>({
    get: () => uploadsOf(model[field], kind),
    set: (list) => (model[field] = uploadText(list, kind)),
  })
}
