import { fsObjectVo, type FsObjectVo } from '@qiwu/shared'
import { t } from './i18n'
import {
  api,
  ApiError,
  currentSessionVersion,
  downloadStorageContent,
  errorText,
  releaseStorageContent,
  retainStoragePreview,
} from './request'

/** 与第一方内容端点保持一致，手机不尝试完整读取超限文件。 */
export const ATTACHMENT_PREVIEW_MAX = 20 * 1024 * 1024
export const DOCUMENT_ATTACHMENTS_MAX = 100
const DOCUMENT_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}
const IMAGE = /^image\/(?:png|jpeg|gif|webp)$/

/** 只依据服务端嗅探类型决定预览方式，原始文件名和 URL 仅作文本，不能控制下载路径。 */
export const attachmentPreviewable = (file: FsObjectVo) =>
  file.size > 0 &&
  file.size <= ATTACHMENT_PREVIEW_MAX &&
  (IMAGE.test(file.mime) || Object.hasOwn(DOCUMENT_TYPES, file.mime))

/** 元信息和下载一样走业务访问检查，不要求全局文件管理权限。 */
export async function attachmentMetadata(id: number): Promise<FsObjectVo> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid attachment')
  const file = fsObjectVo.parse(
    await api.get(`/storage/objects/${id}/metadata`, undefined, { silent: true }),
  )
  if (file.id !== id) throw new Error('Wrong attachment')
  return file
}

/** 小批读取去重后的附件元信息，阻止超大单据造成无界并发。 */
export async function loadAttachments(ids: readonly number[], tag?: string): Promise<FsObjectVo[]> {
  const unique = [...new Set(ids)]
  if (unique.length > DOCUMENT_ATTACHMENTS_MAX) throw new Error('Too many attachments')
  const version = currentSessionVersion()
  const files: FsObjectVo[] = []
  for (let from = 0; from < unique.length; from += 4)
    files.push(...(await Promise.all(unique.slice(from, from + 4).map(attachmentMetadata))))
  if (version !== currentSessionVersion()) throw new Error('Session changed')
  if (tag && files.some((file) => file.bizTag !== tag || file.isPublic || file.url !== null))
    throw new Error('Wrong attachment binding')
  return files
}

/** 运行时返回的本地临时路径不能变成外部链接，也不接受路径穿越片段。 */
export const localAttachmentPath = (path: unknown): path is string =>
  typeof path === 'string' &&
  !/[\u0000-\u001f]/.test(path) &&
  !/(?:^|\/)\.\.(?:\/|$)/.test(path) &&
  (/^(?:blob:|wxfile:\/\/|file:\/\/\/|https?:\/\/tmp\/|_(?:doc|downloads)\/)/.test(path) ||
    /^\/(?!\/)/.test(path))

/** 点击时重新鉴权后仅访问第一方流接口；不使用元信息中的外链或文件名拼地址。 */
export async function openAttachment(id: number): Promise<void> {
  const version = currentSessionVersion()
  const file = await attachmentMetadata(id)
  if (version !== currentSessionVersion()) throw new Error('Session changed')
  if (!attachmentPreviewable(file)) throw new Error(t('approval.attachmentDesktop'))
  const path = await downloadStorageContent(id, file.mime)
  try {
    if (version !== currentSessionVersion() || !localAttachmentPath(path))
      throw new Error('Unsafe temporary file')
    if (IMAGE.test(file.mime)) {
      await new Promise<void>((resolve, reject) =>
        uni.previewImage({ urls: [path], current: path, success: () => resolve(), fail: reject }),
      )
      retainStoragePreview(path)
    } else if (process.env.UNI_PLATFORM === 'h5') {
      // uni-h5 的 openDocument 异步后直接 window.open，弹窗被拦仍会报告成功；改为本地 Blob 下载。
      if (!path.startsWith('blob:') || typeof document === 'undefined')
        throw new Error('No safe browser file')
      const link = document.createElement('a')
      if (!('download' in link)) throw new Error('Browser download unavailable')
      link.href = path
      link.download = `attachment-${id}.${DOCUMENT_TYPES[file.mime]}`
      link.rel = 'noopener noreferrer'
      document.body.appendChild(link)
      link.click()
      link.remove()
      releaseStorageContent(path, 60_000)
    } else
      await new Promise<void>((resolve, reject) =>
        uni.openDocument({
          filePath: path,
          fileType: DOCUMENT_TYPES[file.mime],
          showMenu: true,
          success: () => resolve(),
          fail: reject,
        }),
      )
  } catch (cause) {
    releaseStorageContent(path)
    throw cause
  }
}

/** 附件打开失败必须回传详情，避免内容不可读时仍保留审批入口。 */
export async function openAttachmentWithFeedback(
  id: number,
  feedback: { error: (message: string) => void; unavailable: () => void },
) {
  try {
    await openAttachment(id)
  } catch (cause) {
    feedback.error(
      cause instanceof ApiError ? errorText(cause) : t('approval.attachmentUnavailable'),
    )
    feedback.unavailable()
  }
}
