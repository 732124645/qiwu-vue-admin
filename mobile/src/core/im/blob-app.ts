// 聊天附件的本地缓存（缩略图、看过的原图、表情）。键 `o:<objectId>`（随会话删除）或 `s:<sha256>`（表情类，
// 跨会话去重），总量 `IM_LIMITS.blobCacheBytes` 按最近使用淘汰。App：`uni.downloadFile`（带 Authorization，
// 同源 `proxy=1`）+ `uni.saveFile`，缓存项存保存后的路径，删除项时 SQLite 缓存在提交后删文件。H5：Blob 存
// IndexedDB，显示用对象地址。同一个键同时只下载一次。
import { IM_LIMITS, type ImAttachment } from '@qiwu/shared'
import type { ImBlobMeta, ImCache } from '@qiwu/shared/im-client'
import { ApiError, currentSessionVersion } from '../request'
import { BASE, downloadBlob, entryFileUrl, imHeaders, withAuth } from './api'

/** 附件的缓存键：表情类（自定义表情复制成的图片也带 sha256）按内容，其它按对象。 */
export const blobKey = (att: ImAttachment, kind: string, thumb: boolean) =>
  kind === 'sticker' ? `s:${att.sha256}` : `o:${thumb && att.thumbObjectId ? att.thumbObjectId : att.objectId}`

/** 超出预算时要删的键：按最近使用从旧到新，删到总量不超过预算（纯函数）。 */
export function lruVictims(blobs: readonly ImBlobMeta[], budget: number): string[] {
  let total = blobs.reduce((n, b) => n + b.size, 0)
  const out: string[] = []
  for (const b of [...blobs].sort((a, b) => a.usedAt - b.usedAt || a.key.localeCompare(b.key))) {
    if (total <= budget) break
    total -= b.size
    out.push(b.key)
  }
  return out
}

async function evict(cache: ImCache) {
  for (const key of lruVictims(await cache.listBlobs(), IM_LIMITS.blobCacheBytes))
    await cache.deleteBlob(key)
}

/** App：带令牌下载并保存到应用目录，返回保存后的路径与大小。 */
async function saveApp(url: string): Promise<{ path: string; size: number }> {
  const res = await withAuth(
    () =>
      new Promise((resolve, reject) =>
        uni.downloadFile({
          url: BASE + url,
          header: imHeaders(),
          timeout: 60_000,
          success: (r) => resolve({ statusCode: r.statusCode, data: r.tempFilePath }),
          fail: reject,
        }),
      ),
  )
  if (res.statusCode !== 200) throw new ApiError(res.statusCode, res.statusCode, `HTTP ${res.statusCode}`)
  const path = await new Promise<string>((resolve, reject) =>
    uni.saveFile({
      tempFilePath: String(res.data),
      success: (r) => resolve(r.savedFilePath),
      fail: reject,
    }),
  )
  const size = await new Promise<number>((resolve) =>
    uni.getSavedFileInfo({ filePath: path, success: (r) => resolve(r.size), fail: () => resolve(0) }),
  )
  return { path, size }
}

const flights = new Map<string, Promise<string>>()
/** H5 对象地址：同一个键只建一次，清除时全部释放。 */
const objectUrls = new Map<string, string>()

/**
 * 取一个附件的本地地址（App：保存后的文件路径；H5：对象地址）。先查缓存（命中只更新使用时间，0 请求），
 * 未命中才下载并写入缓存，再按预算淘汰。下载期间换了登录身份 → 丢弃结果。
 */
export function blobUrl(
  cache: ImCache,
  key: string,
  roomId: number | null,
  url: string,
): Promise<string> {
  const flightKey = `${cache.name}|${key}`
  let p = flights.get(flightKey)
  if (p) return p
  p = (async () => {
    const at = currentSessionVersion()
    const hit = await cache.getBlob(key)
    if (hit) {
      await cache.touchBlob(key, Date.now())
      return localUrl(key, hit.body)
    }
    if (process.env.UNI_PLATFORM === 'app') {
      const { path, size } = await saveApp(url)
      if (at !== currentSessionVersion()) {
        uni.removeSavedFile({ filePath: path })
        throw new ApiError(401, 'session_changed', 'session changed')
      }
      await cache.putBlob({ key, roomId, size, usedAt: Date.now(), body: path })
      await evict(cache)
      return path
    }
    const blob = await downloadBlob(url)
    if (at !== currentSessionVersion()) throw new ApiError(401, 'session_changed', 'session changed')
    await cache.putBlob({ key, roomId, size: blob.size, usedAt: Date.now(), body: blob })
    await evict(cache)
    return localUrl(key, blob)
  })().finally(() => flights.delete(flightKey))
  flights.set(flightKey, p)
  return p
}

function localUrl(key: string, body: unknown): string {
  if (typeof body === 'string') return body
  let u = objectUrls.get(key)
  if (!u) {
    u = URL.createObjectURL(body as Blob)
    objectUrls.set(key, u)
  }
  return u
}

/** 一条消息附件的本地地址（缩略图或原图）。 */
export const entryBlobUrl = (
  cache: ImCache,
  roomId: number,
  seq: number,
  kind: string,
  att: ImAttachment,
  thumb: boolean,
) =>
  blobUrl(
    cache,
    blobKey(att, kind, thumb),
    kind === 'sticker' ? null : roomId,
    entryFileUrl(roomId, seq, thumb && !!att.thumbObjectId),
  )

/** 清除缓存时释放 H5 的对象地址。 */
export function releaseBlobUrls() {
  for (const u of objectUrls.values()) URL.revokeObjectURL(u)
  objectUrls.clear()
  flights.clear()
}
