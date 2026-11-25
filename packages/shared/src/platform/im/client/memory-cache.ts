import type {
  ImBlobMeta,
  ImBlobRecord,
  ImCache,
  ImCacheOps,
  ImEntryRecord,
  ImEntryRange,
  ImMetaKey,
  ImOutboxRecord,
  ImRoomRecord,
  ImSnapshot,
} from './cache.js'
import type { ImDirectory, ImSticker } from '../im.schema.js'

/** 内存缓存的全部数据；事务在它的副本上执行，成功才整体替换。 */
interface MemoryState {
  rooms: Map<number, ImRoomRecord>
  entries: Map<string, ImEntryRecord>
  outbox: Map<string, ImOutboxRecord>
  meta: Map<ImMetaKey, string>
  directory?: ImSnapshot<ImDirectory>
  stickers?: ImSnapshot<ImSticker[]>
  blobs: Map<string, ImBlobRecord>
}

const entryKey = (roomId: number, seq: number) => `${roomId}:${seq}`
/** 结构化深拷贝：调用方拿到的对象改了也不影响缓存（与 IndexedDB 的行为一致）。附件正文不拷贝。 */
const copy = <T>(value: T): T => structuredClone(value)
const copyBlob = (b: ImBlobRecord): ImBlobRecord => ({ ...b })

function emptyState(): MemoryState {
  return {
    rooms: new Map(),
    entries: new Map(),
    outbox: new Map(),
    meta: new Map(),
    blobs: new Map(),
  }
}

function cloneState(s: MemoryState): MemoryState {
  return {
    rooms: new Map(s.rooms),
    entries: new Map(s.entries),
    outbox: new Map(s.outbox),
    meta: new Map(s.meta),
    directory: s.directory,
    stickers: s.stickers,
    blobs: new Map(s.blobs),
  }
}

/** 在给定状态上实现全部读写（值进出都拷贝，所以副本只需浅拷贝各个 Map）。 */
function opsOn(s: MemoryState): ImCacheOps {
  const roomEntries = (roomId: number) =>
    [...s.entries.values()].filter((e) => e.roomId === roomId).sort((a, b) => a.seq - b.seq)
  return {
    getRoom: async (roomId) => {
      const r = s.rooms.get(roomId)
      return r && copy(r)
    },
    listRooms: async () => [...s.rooms.values()].map(copy),
    putRoom: async (room) => void s.rooms.set(room.roomId, copy(room)),
    deleteRoom: async (roomId) => {
      s.rooms.delete(roomId)
      for (const [k, e] of s.entries) if (e.roomId === roomId) s.entries.delete(k)
      for (const [k, o] of s.outbox) if (o.roomId === roomId) s.outbox.delete(k)
      for (const [k, b] of s.blobs) if (b.roomId === roomId) s.blobs.delete(k)
    },
    getEntry: async (roomId, seq) => {
      const e = s.entries.get(entryKey(roomId, seq))
      return e && copy(e)
    },
    getEntries: async (roomId, range: ImEntryRange = {}) => {
      const from = range.fromSeq ?? 0
      const to = range.toSeq ?? Number.MAX_SAFE_INTEGER
      let rows = roomEntries(roomId).filter((e) => e.seq >= from && e.seq <= to)
      if (range.order === 'desc') rows.reverse()
      if (range.limit !== undefined) rows = rows.slice(0, range.limit)
      return rows.map(copy)
    },
    putEntries: async (entries) => {
      for (const e of entries) s.entries.set(entryKey(e.roomId, e.seq), copy(e))
    },
    deleteEntries: async (roomId, belowSeq) => {
      for (const [k, e] of s.entries)
        if (e.roomId === roomId && (belowSeq === undefined || e.seq < belowSeq)) s.entries.delete(k)
    },
    countEntries: async (roomId) => roomEntries(roomId).length,
    listOutbox: async (roomId) =>
      [...s.outbox.values()]
        .filter((o) => roomId === undefined || o.roomId === roomId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(copy),
    putOutbox: async (item) => void s.outbox.set(item.clientEntryId, copy(item)),
    deleteOutbox: async (id) => void s.outbox.delete(id),
    getMeta: async (key) => s.meta.get(key),
    putMeta: async (key, value) => void s.meta.set(key, value),
    getDirectory: async () => s.directory && copy(s.directory),
    putDirectory: async (snapshot) => void (s.directory = copy(snapshot)),
    getStickers: async () => s.stickers && copy(s.stickers),
    putStickers: async (snapshot) => void (s.stickers = copy(snapshot)),
    getBlob: async (key) => {
      const b = s.blobs.get(key)
      return b && copyBlob(b)
    },
    putBlob: async (blob) => void s.blobs.set(blob.key, copyBlob(blob)),
    touchBlob: async (key, usedAt) => {
      const b = s.blobs.get(key)
      if (b) s.blobs.set(key, { ...b, usedAt })
    },
    deleteBlob: async (key) => void s.blobs.delete(key),
    listBlobs: async (): Promise<ImBlobMeta[]> =>
      [...s.blobs.values()].map(({ body: _body, ...meta }) => meta),
  }
}

/**
 * 内存缓存：测试用，也是配额不足时的降级。事务串行执行：回调在状态副本上读写，成功后一次替换，
 * 抛错则丢弃副本——不会留下部分写入。
 */
export function createMemoryCache(name: string, seed?: ImCacheSeed): ImCache {
  let state = emptyState()
  if (seed) Object.assign(state, cloneState({ ...emptyState(), ...seed }))
  let queue: Promise<unknown> = Promise.resolve()

  const tx = <T>(fn: (ops: ImCacheOps) => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      const draft = cloneState(state)
      const result = await fn(opsOn(draft))
      state = draft
      return result
    })
    queue = run.catch(() => undefined)
    return run
  }
  // 事务外的单个操作也走同一队列，与事务互不穿插
  const single =
    <A extends unknown[], R>(pick: (ops: ImCacheOps) => (...args: A) => Promise<R>) =>
    (...args: A) =>
      tx((ops) => pick(ops)(...args))

  return {
    name,
    tx,
    close: async () => undefined,
    destroy: async () => {
      await tx(async () => undefined)
      state = emptyState()
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

/** 降级时从 IndexedDB 搬过来的初始数据（附件缓存不搬）。 */
export interface ImCacheSeed {
  rooms?: Map<number, ImRoomRecord>
  entries?: Map<string, ImEntryRecord>
  outbox?: Map<string, ImOutboxRecord>
  meta?: Map<ImMetaKey, string>
  directory?: ImSnapshot<ImDirectory>
  stickers?: ImSnapshot<ImSticker[]>
}

/** 把一批记录整理成内存缓存的初始数据。 */
export function imCacheSeed(data: {
  rooms: ImRoomRecord[]
  entries: ImEntryRecord[]
  outbox: ImOutboxRecord[]
  meta: [ImMetaKey, string][]
  directory?: ImSnapshot<ImDirectory>
  stickers?: ImSnapshot<ImSticker[]>
}): ImCacheSeed {
  return {
    rooms: new Map(data.rooms.map((r) => [r.roomId, r])),
    entries: new Map(data.entries.map((e) => [entryKey(e.roomId, e.seq), e])),
    outbox: new Map(data.outbox.map((o) => [o.clientEntryId, o])),
    meta: new Map(data.meta),
    directory: data.directory,
    stickers: data.stickers,
  }
}
