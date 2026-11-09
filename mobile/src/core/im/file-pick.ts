// 聊天选文件：纯函数（显示名清洗、扩展名与大小检查、副本路径、发件箱副本清理）与按平台的选择入口。
// App 用 Native.js 系统文件选择（file-picker-app.ts），H5 用 uni.chooseFile；小程序不进聊天。
import type { ImOptions } from '@qiwu/shared'
import type { ImOutboxFile, ImOutboxRecord } from '@qiwu/shared/im-client'
// #ifdef APP-PLUS
import { copyIntoOutbox, pickAppFile } from './file-picker-app'
// #endif

/** App 发件箱副本目录（`_doc` 下，应用私有）。 */
export const OUTBOX_DIR = '_doc/im-outbox/'
/** 安全文件名的最大长度（字符）。 */
export const NAME_MAX = 100
/** 发件箱失败项过期时长：之后副本删除，用户重新选择即新消息。 */
export const OUTBOX_EXPIRE_MS = 24 * 60 * 60 * 1000

/** 系统给的文件：显示名、字节数与平台引用（Android 的 content:// URI、iOS 的文件路径、H5 的 blob 地址）。 */
export interface PickedImFile {
  name: string
  size: number
  uri: string
}

/** 检查不过的原因（界面按它提示）。 */
export type PickRejection = 'type' | 'size' | 'empty'

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/**
 * 显示名 → 安全文件名：去掉路径（`/`、`\`）、控制字符和 Windows 不允许的字符，首尾的点与空白；超长时保留
 * 扩展名截断主名；什么都不剩时为 `file`。系统给的显示名不可信（可带 `../`）。
 */
export function safeFileName(display: string): string {
  const base = display.split(/[/\\]/).pop() ?? ''
  let name = base
    .replace(CONTROL, '')
    .replace(/[<>:\x22|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  if (!name) return 'file'
  const chars = [...name]
  if (chars.length > NAME_MAX) {
    const ext = fileExt(name)
    const keep = ext && ext.length < 16 ? `.${ext}` : ''
    name = chars.slice(0, NAME_MAX - [...keep].length).join('') + keep
  }
  return name
}

/** 小写扩展名（不含点）；没有为 ''。 */
export function fileExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * 发送前（复制进发件箱前）的检查：扩展名在 `/options` 的文件或图片白名单里、非空、不超过 `fileMaxMb`。
 * 服务端照样再查；这里挡住不必要的复制与上传。
 */
export function checkPick(
  file: Pick<PickedImFile, 'name' | 'size'>,
  options: Pick<ImOptions, 'fileExts' | 'imageExts' | 'fileMaxMb'>,
): PickRejection | null {
  const ext = fileExt(safeFileName(file.name))
  if (!ext || ![...options.fileExts, ...options.imageExts].includes(ext)) return 'type'
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return 'empty'
  if (file.size > options.fileMaxMb * 1024 * 1024) return 'size'
  return null
}

/** 是否按图片发送（图片白名单内）。 */
export const isImageName = (name: string, options: Pick<ImOptions, 'imageExts'>) =>
  options.imageExts.includes(fileExt(name))

/** 副本路径：`_doc/im-outbox/<id>-<安全文件名>`（id 只收字母数字与 `-`，防止拼出别的目录）。 */
export function outboxPath(id: string, display: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new TypeError('bad outbox id')
  return `${OUTBOX_DIR}${id}-${safeFileName(display)}`
}

/**
 * URI 或路径 → 显示名（系统没给 DISPLAY_NAME 时的兜底）：`content://…/document/primary%3ADownload%2Fa.pdf`
 * 取解码后的最后一段，`file:///…/a.pdf` 取文件名；解不开的编码按原样。
 */
export function nameFromUri(uri: string): string {
  const path = uri.replace(/[?#].*$/, '')
  let last = path.split('/').pop() ?? ''
  try {
    last = decodeURIComponent(last)
  } catch {
    // 原样
  }
  // content 提供方常把整条路径编码进最后一段（primary:Download/a.pdf）
  return safeFileName(last.split(/[:/\\]/).pop() ?? '')
}

/**
 * 该删的发件箱副本：本机建过的副本里，已不被任何发件箱项引用的（发送成功后发件箱项已删除），以及失败且
 * 超过 24 小时的项的副本（过期后不再重试，用户重新选择即新消息）。
 */
export function staleOutboxCopies(
  copies: readonly string[],
  outbox: readonly ImOutboxRecord[],
  now: number,
): string[] {
  const live = new Set(
    outbox
      .filter((o) => !(o.state === 'failed' && now - o.createdAt >= OUTBOX_EXPIRE_MS))
      .map((o) => o.file?.localRef)
      .filter((p): p is string => !!p),
  )
  return copies.filter((p) => p.startsWith(OUTBOX_DIR) && !live.has(p))
}

/** 本机建过的发件箱副本清单（uni 存储，换账号/退出时一起删）。 */
const COPIES_KEY = 'qw.im.outbox'
export const outboxCopies = (): string[] => {
  const v: unknown = uni.getStorageSync(COPIES_KEY)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
export const rememberOutboxCopy = (path: string) =>
  uni.setStorageSync(COPIES_KEY, [...outboxCopies().filter((p) => p !== path), path])

/** 删掉 `staleOutboxCopies` 选出的副本并从清单移除；`remove` 是平台的删文件。 */
export async function sweepOutboxCopies(
  outbox: readonly ImOutboxRecord[],
  remove: (path: string) => Promise<void>,
  now = Date.now(),
  all = false,
): Promise<void> {
  const copies = outboxCopies()
  const stale = all ? copies : staleOutboxCopies(copies, outbox, now)
  for (const p of stale) await remove(p)
  uni.setStorageSync(
    COPIES_KEY,
    outboxCopies().filter((p) => !stale.includes(p)),
  )
}

/** H5：浏览器文件选择（单个）；取消为 null。 */
export function chooseH5File(): Promise<PickedImFile | null> {
  return new Promise((resolve) =>
    uni.chooseFile({
      count: 1,
      type: 'all',
      success: (r) => {
        const file = ([r.tempFiles].flat() as (File & { path: string })[])[0]
        resolve(file ? { name: file.name, size: file.size, uri: file.path } : null)
      },
      fail: () => resolve(null),
    }),
  )
}

/** 按扩展名给的类型（服务端按魔数再识别，这里只给上传与本地显示用）。 */
export function guessMime(name: string): string {
  const ext = fileExt(name)
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png' || ext === 'gif' || ext === 'webp') return `image/${ext}`
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'txt') return 'text/plain'
  return 'application/octet-stream'
}

/**
 * 按平台选一个要发送的文件：App 走 Native.js（检查通过后复制进发件箱目录），H5 走浏览器选择。返回发件箱
 * 文件、检查不过的原因，或取消时 null。
 */
export async function chooseImFile(
  options: Pick<ImOptions, 'fileExts' | 'imageExts' | 'fileMaxMb'>,
): Promise<ImOutboxFile | PickRejection | null> {
  // #ifdef APP-PLUS
  if (process.env.UNI_PLATFORM === 'app') return pickAppFile(options)
  // #endif
  const file = await chooseH5File()
  if (!file) return null
  const bad = checkPick(file, options)
  if (bad) return bad
  return { name: safeFileName(file.name), size: file.size, mime: guessMime(file.name), localRef: file.uri }
}

/**
 * 选好的图片交给发件箱前：App 把系统临时文件复制进发件箱目录（临时文件随时会被清理，发送失败重试时还要用），
 * H5 的 blob 地址原样使用。
 */
export async function keepPickedImage(path: string, name: string): Promise<string> {
  // #ifdef APP-PLUS
  if (process.env.UNI_PLATFORM === 'app') return copyIntoOutbox(path, name)
  // #endif
  return path
}

/** 失败项里只能丢弃、不能重发的：本地文件已不在，或已过期（App 的副本此时已删除）。 */
export const outboxDiscardOnly = (o: ImOutboxRecord, now = Date.now()) =>
  !!o.file && (o.failure === 'local' || now - o.createdAt >= OUTBOX_EXPIRE_MS)
