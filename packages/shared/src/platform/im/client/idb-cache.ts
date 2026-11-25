import type {
  ImBlobMeta,
  ImBlobRecord,
  ImCache,
  ImCacheOps,
  ImEntryRecord,
  ImMetaKey,
  ImOutboxRecord,
  ImRoomRecord,
  ImSnapshot,
} from './cache.js'
import type { ImDirectory, ImSticker } from '../im.schema.js'
import { createMemoryCache, imCacheSeed } from './memory-cache.js'

/** 本地库名前缀：登录换账号时按它找出其它账号的库删除。 */
export const IM_IDB_PREFIX = 'qw-im-'
const VERSION = 1
const STORES = ['rooms', 'entries', 'outbox', 'meta', 'snap', 'blobs'] as const
const MAX = Number.MAX_SAFE_INTEGER

/** IndexedDB 请求转 Promise（在事务的回调里 await 它不会让事务提前提交）。 */
const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, VERSION)
    r.onupgradeneeded = () => {
      const db = r.result
      db.createObjectStore('rooms', { keyPath: 'roomId' })
      db.createObjectStore('entries', { keyPath: ['roomId', 'seq'] })
      db.createObjectStore('outbox', { keyPath: 'clientEntryId' }).createIndex('roomId', 'roomId')
      db.createObjectStore('meta')
      db.createObjectStore('snap')
      db.createObjectStore('blobs', { keyPath: 'key' }).createIndex('roomId', 'roomId')
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    r.onblocked = () => reject(new Error('blocked'))
  })
}

const isQuota = (e: unknown) =>
  e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)

/** 一个 IndexedDB 事务上的全部读写。 */
function opsOn(t: IDBTransaction): ImCacheOps {
  const s = (name: (typeof STORES)[number]) => t.objectStore(name)
  const roomRange = (roomId: number, from = 0, to = MAX) =>
    IDBKeyRange.bound([roomId, from], [roomId, to])
  const deleteByIndex = async (store: 'outbox' | 'blobs', roomId: number) => {
    const keys = await req(s(store).index('roomId').getAllKeys(roomId))
    for (const k of keys) await req(s(store).delete(k))
  }
  return {
    getRoom: (roomId) => req(s('rooms').get(roomId)) as Promise<ImRoomRecord | undefined>,
    listRooms: () => req(s('rooms').getAll()) as Promise<ImRoomRecord[]>,
    putRoom: async (room) => void (await req(s('rooms').put(room))),
    deleteRoom: async (roomId) => {
      await req(s('rooms').delete(roomId))
      await req(s('entries').delete(roomRange(roomId)))
      await deleteByIndex('outbox', roomId)
      await deleteByIndex('blobs', roomId)
    },
    getEntry: (roomId, seq) =>
      req(s('entries').get([roomId, seq])) as Promise<ImEntryRecord | undefined>,
    getEntries: async (roomId, range = {}) => {
      const keys = roomRange(roomId, range.fromSeq ?? 0, range.toSeq ?? MAX)
      if (range.order !== 'desc')
        return req(s('entries').getAll(keys, range.limit)) as Promise<ImEntryRecord[]>
      // 倒序取最新的若干条：游标从高往低走
      const rows: ImEntryRecord[] = []
      const cursor = s('entries').openCursor(keys, 'prev')
      await new Promise<void>((resolve, reject) => {
        cursor.onerror = () => reject(cursor.error)
        cursor.onsuccess = () => {
          const c = cursor.result
          if (!c || (range.limit !== undefined && rows.length >= range.limit)) return resolve()
          rows.push(c.value as ImEntryRecord)
          c.continue()
        }
      })
      return rows
    },
    putEntries: async (entries) => {
      for (const e of entries) await req(s('entries').put(e))
    },
    deleteEntries: async (roomId, belowSeq) => {
      if (belowSeq === undefined) await req(s('entries').delete(roomRange(roomId)))
      else if (belowSeq > 0)
        await req(
          s('entries').delete(IDBKeyRange.bound([roomId, 0], [roomId, belowSeq], false, true)),
        )
    },
    countEntries: (roomId) => req(s('entries').count(roomRange(roomId))),
    listOutbox: async (roomId) => {
      const rows = (await req(
        roomId === undefined ? s('outbox').getAll() : s('outbox').index('roomId').getAll(roomId),
      )) as ImOutboxRecord[]
      return rows.sort((a, b) => a.createdAt - b.createdAt)
    },
    putOutbox: async (item) => void (await req(s('outbox').put(item))),
    deleteOutbox: async (id) => void (await req(s('outbox').delete(id))),
    getMeta: (key) => req(s('meta').get(key)) as Promise<string | undefined>,
    putMeta: async (key, value) => void (await req(s('meta').put(value, key))),
    getDirectory: () =>
      req(s('snap').get('directory')) as Promise<ImSnapshot<ImDirectory> | undefined>,
    putDirectory: async (snap) => void (await req(s('snap').put(snap, 'directory'))),
    getStickers: () =>
      req(s('snap').get('stickers')) as Promise<ImSnapshot<ImSticker[]> | undefined>,
    putStickers: async (snap) => void (await req(s('snap').put(snap, 'stickers'))),
    getBlob: (key) => req(s('blobs').get(key)) as Promise<ImBlobRecord | undefined>,
    putBlob: async (blob) => void (await req(s('blobs').put(blob))),
    touchBlob: async (key, usedAt) => {
      const b = (await req(s('blobs').get(key))) as ImBlobRecord | undefined
      if (b) await req(s('blobs').put({ ...b, usedAt }))
    },
    deleteBlob: async (key) => void (await req(s('blobs').delete(key))),
    listBlobs: async () => {
      // 只取元数据：游标逐条读，不把正文留在结果里
      const out: ImBlobMeta[] = []
      const cursor = s('blobs').openCursor()
      await new Promise<void>((resolve, reject) => {
        cursor.onerror = () => reject(cursor.error)
        cursor.onsuccess = () => {
          const c = cursor.result
          if (!c) return resolve()
          const { body: _body, ...meta } = c.value as ImBlobRecord
          out.push(meta)
          c.continue()
        }
      })
      return out
    },
  }
}

/** 在一个读写事务里跑回调：回调抛错就中止事务（全部回滚），否则等事务真正提交。 */
async function runTx<T>(db: IDBDatabase, fn: (ops: ImCacheOps) => Promise<T>): Promise<T> {
  const t = db.transaction(STORES, 'readwrite')
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onabort = () => reject(t.error ?? new DOMException('aborted', 'AbortError'))
    t.onerror = () => reject(t.error)
  })
  let result: T
  try {
    result = await fn(opsOn(t))
  } catch (e) {
    try {
      t.abort()
    } catch {
      // 事务已因请求失败自行中止
    }
    await done.catch(() => undefined)
    throw e
  }
  await done
  return result
}

/** 打开选项：配额不足改用内存缓存时回调一次（界面提示）。 */
export interface IdbCacheOptions {
  onQuota?: () => void
  /** 连接被外部关闭（别的标签页删库）时调用一次；本实例自己的 close/destroy 不触发 */
  onClosed?: () => void
}

/**
 * 原生 IndexedDB 缓存（web 与移动 H5 共用）。别的标签页删库（退出、换账号）时 `onversionchange`
 * 立即关闭连接，之后本实例的任何操作都失败，不会把已删的库重新建出来。写入遇到配额不足
 * （`QuotaExceededError`）时，把现有数据（附件缓存除外）搬进内存缓存，本次会话改用它，发件箱不丢。
 */
export async function openIdbCache(name: string, options: IdbCacheOptions = {}): Promise<ImCache> {
  const db = await openDb(name)
  let closed = false
  db.onversionchange = () => {
    closed = true
    db.close()
    // 别的标签页删了这个库（epoch 变了重建、退出、换账号）：本实例已不能用，交宿主决定是否重开
    options.onClosed?.()
  }
  let fallback: ImCache | null = null

  const live = () => {
    if (closed) throw new DOMException('closed', 'InvalidStateError')
    return db
  }

  /** 配额不足：读出现有数据建内存缓存（读不受配额限制）。 */
  async function degrade(): Promise<ImCache> {
    if (fallback) return fallback
    const t = live().transaction(STORES, 'readonly')
    const all = <T>(store: (typeof STORES)[number]) =>
      req(t.objectStore(store).getAll()) as Promise<T[]>
    const [rooms, entries, outbox, metaKeys, metaValues, directory, stickers] = await Promise.all([
      all<ImRoomRecord>('rooms'),
      all<ImEntryRecord>('entries'),
      all<ImOutboxRecord>('outbox'),
      req(t.objectStore('meta').getAllKeys()) as Promise<ImMetaKey[]>,
      all<string>('meta'),
      req(t.objectStore('snap').get('directory')) as Promise<ImSnapshot<ImDirectory> | undefined>,
      req(t.objectStore('snap').get('stickers')) as Promise<ImSnapshot<ImSticker[]> | undefined>,
    ])
    fallback ??= createMemoryCache(
      name,
      imCacheSeed({
        rooms,
        entries,
        outbox,
        meta: metaKeys.map((k, i) => [k, metaValues[i]!] as [ImMetaKey, string]),
        directory,
        stickers,
      }),
    )
    options.onQuota?.()
    return fallback
  }

  const tx = async <T>(fn: (ops: ImCacheOps) => Promise<T>): Promise<T> => {
    if (fallback) return fallback.tx(fn)
    try {
      return await runTx(live(), fn)
    } catch (e) {
      if (!isQuota(e)) throw e
      return (await degrade()).tx(fn)
    }
  }
  const single =
    <A extends unknown[], R>(pick: (ops: ImCacheOps) => (...args: A) => Promise<R>) =>
    (...args: A) =>
      tx((ops) => pick(ops)(...args))

  return {
    name,
    tx,
    close: async () => {
      closed = true
      db.close()
    },
    destroy: async () => {
      closed = true
      db.close()
      await fallback?.destroy()
      await deleteDb(name)
    },
    getRoom: single((o) => o.getRoom),
    listRooms: single((o) => o.listRooms),
    putRoom: single((o) => o.putRoom),
    deleteRoom: single((o) => o.deleteRoom),
    getEntry: single((o) => o.getEntry),
    getEntries: single((o) => o.getEntries),
    putEntries: single((o) => o.putEntries),
    deleteEntries: single((o) => o.deleteEntries),
    countEntries: single((o) => o.countEntries),
    listOutbox: single((o) => o.listOutbox),
    putOutbox: single((o) => o.putOutbox),
    deleteOutbox: single((o) => o.deleteOutbox),
    getMeta: single((o) => o.getMeta),
    putMeta: single((o) => o.putMeta),
    getDirectory: single((o) => o.getDirectory),
    putDirectory: single((o) => o.putDirectory),
    getStickers: single((o) => o.getStickers),
    putStickers: single((o) => o.putStickers),
    getBlob: single((o) => o.getBlob),
    putBlob: single((o) => o.putBlob),
    touchBlob: single((o) => o.touchBlob),
    deleteBlob: single((o) => o.deleteBlob),
    listBlobs: single((o) => o.listBlobs),
  }
}

/** 删除一个库；别的标签页的连接会在 `onversionchange` 里关闭，所以 blocked 只是等待。 */
export function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(name)
    r.onsuccess = () => resolve()
    r.onerror = () => reject(r.error)
  })
}

/** 删除除 `keep` 以外的全部 `qw-im-*` 库（登录成功换账号时）。浏览器不支持列库时什么也不做。 */
export async function deleteOtherIdbCaches(keep: string | null): Promise<void> {
  if (typeof indexedDB === 'undefined' || !indexedDB.databases) return
  const dbs = await indexedDB.databases()
  for (const { name } of dbs)
    if (name && name.startsWith(IM_IDB_PREFIX) && name !== keep) await deleteDb(name)
}
