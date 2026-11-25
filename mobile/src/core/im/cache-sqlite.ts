// App 的聊天本地缓存（`plus.sqlite`，库文件在 `_doc/`），实现共同的 `ImCache` 接口。
// plus.sqlite 没有参数绑定，所以 SQL 全部由下面的纯函数生成：表名列名都是常量，整数只收安全整数，
// 字符串单引号加倍并拒绝 NUL；记录本身以 JSON 存在 `data` 列（JSON 不含原始 NUL）。所有读写经一个
// 串行队列，`tx` 用 BEGIN/COMMIT/ROLLBACK 包住整个回调。执行端口可替换：规格把同一 SQL 交给 Node 的
// `node:sqlite` 真跑。
import {
  IM_CACHE_SCHEMA,
  type ImBlobMeta,
  type ImBlobRecord,
  type ImCache,
  type ImCacheOps,
  type ImEntryRange,
  type ImEntryRecord,
  type ImMetaKey,
  type ImOutboxRecord,
  type ImRoomRecord,
  type ImSnapshot,
} from '@qiwu/shared/im-client'
import type { ImDirectory, ImSticker } from '@qiwu/shared'

// ---------- 纯函数：字面量与语句 ----------

/** 整数字面量：只收安全整数（NaN、小数、超过 2^53 的数都拒绝，防止精度丢失或拼进非数字）。 */
export function sqlInt(n: number): string {
  if (!Number.isSafeInteger(n)) throw new TypeError(`unsafe integer in SQL: ${String(n)}`)
  return String(n)
}

/** 字符串字面量：单引号加倍；NUL 会截断 SQLite 的 C 字符串，直接拒绝。 */
export function sqlText(s: string): string {
  if (typeof s !== 'string') throw new TypeError('SQL text must be a string')
  if (s.includes('\u0000')) throw new TypeError('NUL in SQL text')
  return `'${s.replaceAll("'", "''")}'`
}

const sqlNullableInt = (n: number | null) => (n === null ? 'NULL' : sqlInt(n))
const json = (v: unknown) => sqlText(JSON.stringify(v))

/** 表名常量（库内只有这些表）。 */
export const T = {
  rooms: 'im_rooms',
  entries: 'im_entries',
  outbox: 'im_outbox',
  meta: 'im_meta',
  snapshots: 'im_snapshots',
  blobs: 'im_blobs',
} as const

/** 建表语句（幂等）。 */
export const SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${T.rooms} (room_id INTEGER PRIMARY KEY, data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${T.entries} (room_id INTEGER NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (room_id, seq))`,
  `CREATE TABLE IF NOT EXISTS ${T.outbox} (client_entry_id TEXT PRIMARY KEY, room_id INTEGER NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${T.meta} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${T.snapshots} (k TEXT PRIMARY KEY, data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${T.blobs} (k TEXT PRIMARY KEY, room_id INTEGER, size INTEGER NOT NULL, used_at INTEGER NOT NULL, body TEXT NOT NULL)`,
]

/** 只给 tx 外的维护用：清空全部表（destroy 在删库文件失败时的兜底）。 */
export const WIPE_SQL: readonly string[] = Object.values(T).map((t) => `DELETE FROM ${t}`)

type Snapshot = 'directory' | 'stickers'

/** 每个读写对应的 SQL（纯函数，规格直接执行它们）。 */
export const SQL = {
  getRoom: (roomId: number) => `SELECT data FROM ${T.rooms} WHERE room_id = ${sqlInt(roomId)}`,
  listRooms: () => `SELECT data FROM ${T.rooms} ORDER BY room_id`,
  putRoom: (r: ImRoomRecord) =>
    `INSERT OR REPLACE INTO ${T.rooms} (room_id, data) VALUES (${sqlInt(r.roomId)}, ${json(r)})`,
  /** 删会话：会话、本地行、发件箱与它的 `o:` 附件缓存项 */
  deleteRoom: (roomId: number) => [
    `DELETE FROM ${T.rooms} WHERE room_id = ${sqlInt(roomId)}`,
    `DELETE FROM ${T.entries} WHERE room_id = ${sqlInt(roomId)}`,
    `DELETE FROM ${T.outbox} WHERE room_id = ${sqlInt(roomId)}`,
    `DELETE FROM ${T.blobs} WHERE room_id = ${sqlInt(roomId)}`,
  ],
  roomBlobBodies: (roomId: number) =>
    `SELECT body FROM ${T.blobs} WHERE room_id = ${sqlInt(roomId)}`,

  getEntry: (roomId: number, seq: number) =>
    `SELECT data FROM ${T.entries} WHERE room_id = ${sqlInt(roomId)} AND seq = ${sqlInt(seq)}`,
  getEntries(roomId: number, range: ImEntryRange = {}) {
    const where = [`room_id = ${sqlInt(roomId)}`]
    if (range.fromSeq !== undefined) where.push(`seq >= ${sqlInt(range.fromSeq)}`)
    if (range.toSeq !== undefined) where.push(`seq <= ${sqlInt(range.toSeq)}`)
    const order = range.order === 'desc' ? 'DESC' : 'ASC'
    const limit = range.limit !== undefined ? ` LIMIT ${sqlInt(Math.max(0, range.limit))}` : ''
    return `SELECT data FROM ${T.entries} WHERE ${where.join(' AND ')} ORDER BY seq ${order}${limit}`
  },
  putEntry: (e: ImEntryRecord) =>
    `INSERT OR REPLACE INTO ${T.entries} (room_id, seq, data) VALUES (${sqlInt(e.roomId)}, ${sqlInt(e.seq)}, ${json(e)})`,
  deleteEntries: (roomId: number, belowSeq?: number) =>
    `DELETE FROM ${T.entries} WHERE room_id = ${sqlInt(roomId)}` +
    (belowSeq === undefined ? '' : ` AND seq < ${sqlInt(belowSeq)}`),
  countEntries: (roomId: number) =>
    `SELECT COUNT(*) AS n FROM ${T.entries} WHERE room_id = ${sqlInt(roomId)}`,

  listOutbox: (roomId?: number) =>
    `SELECT data FROM ${T.outbox}` +
    (roomId === undefined ? '' : ` WHERE room_id = ${sqlInt(roomId)}`) +
    ' ORDER BY created_at, client_entry_id',
  putOutbox: (o: ImOutboxRecord) =>
    `INSERT OR REPLACE INTO ${T.outbox} (client_entry_id, room_id, created_at, data) VALUES (${sqlText(o.clientEntryId)}, ${sqlInt(o.roomId)}, ${sqlInt(o.createdAt)}, ${json(o)})`,
  deleteOutbox: (clientEntryId: string) =>
    `DELETE FROM ${T.outbox} WHERE client_entry_id = ${sqlText(clientEntryId)}`,

  getMeta: (key: ImMetaKey) => `SELECT v FROM ${T.meta} WHERE k = ${sqlText(key)}`,
  putMeta: (key: ImMetaKey, value: string) =>
    `INSERT OR REPLACE INTO ${T.meta} (k, v) VALUES (${sqlText(key)}, ${sqlText(value)})`,

  getSnapshot: (key: Snapshot) => `SELECT data FROM ${T.snapshots} WHERE k = ${sqlText(key)}`,
  putSnapshot: (key: Snapshot, snapshot: ImSnapshot<unknown>) =>
    `INSERT OR REPLACE INTO ${T.snapshots} (k, data) VALUES (${sqlText(key)}, ${json(snapshot)})`,

  getBlob: (key: string) =>
    `SELECT k, room_id, size, used_at, body FROM ${T.blobs} WHERE k = ${sqlText(key)}`,
  putBlob: (b: ImBlobRecord) => {
    if (typeof b.body !== 'string') throw new TypeError('App blob body must be a saved file path')
    return `INSERT OR REPLACE INTO ${T.blobs} (k, room_id, size, used_at, body) VALUES (${sqlText(b.key)}, ${sqlNullableInt(b.roomId)}, ${sqlInt(b.size)}, ${sqlInt(b.usedAt)}, ${sqlText(b.body)})`
  },
  touchBlob: (key: string, usedAt: number) =>
    `UPDATE ${T.blobs} SET used_at = ${sqlInt(usedAt)} WHERE k = ${sqlText(key)}`,
  deleteBlob: (key: string) => `DELETE FROM ${T.blobs} WHERE k = ${sqlText(key)}`,
  listBlobs: () => `SELECT k, room_id, size, used_at FROM ${T.blobs} ORDER BY used_at, k`,
} as const

// ---------- 执行端口与缓存 ----------

/** 一行查询结果（列名 → 值）。 */
export type SqlRow = Record<string, unknown>

/** SQL 执行端口：App 用 plus.sqlite，规格用 node:sqlite。 */
export interface SqlPort {
  exec(sql: string): Promise<void>
  select(sql: string): Promise<SqlRow[]>
  close(): Promise<void>
  /** 删除整个库文件 */
  drop(): Promise<void>
  /** 删除一个附件缓存文件（`uni.saveFile` 的路径）；失败不抛 */
  removeFile(path: string): Promise<void>
}

const parse = <T>(rows: SqlRow[]): T[] => rows.map((r) => JSON.parse(String(r.data)) as T)
const blobMeta = (r: SqlRow): ImBlobMeta => ({
  key: String(r.k),
  roomId: r.room_id === null || r.room_id === undefined ? null : Number(r.room_id),
  size: Number(r.size),
  usedAt: Number(r.used_at),
})

/**
 * 事务里的读写：直接在端口上执行（外层已持有队列）。删会话/删附件项时，对应的文件只在提交后才删
 * （回滚时文件仍被引用），收集在 `afterCommit` 里。
 */
function opsOn(port: SqlPort, afterCommit: string[]): ImCacheOps {
  const one = async <T>(sql: string) => parse<T>(await port.select(sql))[0]
  return {
    getRoom: (roomId) => one<ImRoomRecord>(SQL.getRoom(roomId)),
    listRooms: async () => parse<ImRoomRecord>(await port.select(SQL.listRooms())),
    putRoom: (room) => port.exec(SQL.putRoom(room)),
    async deleteRoom(roomId) {
      const files = await port.select(SQL.roomBlobBodies(roomId))
      for (const sql of SQL.deleteRoom(roomId)) await port.exec(sql)
      afterCommit.push(...files.map((r) => String(r.body)))
    },
    getEntry: (roomId, seq) => one<ImEntryRecord>(SQL.getEntry(roomId, seq)),
    getEntries: async (roomId, range) =>
      parse<ImEntryRecord>(await port.select(SQL.getEntries(roomId, range))),
    async putEntries(entries) {
      for (const e of entries) await port.exec(SQL.putEntry(e))
    },
    deleteEntries: (roomId, belowSeq) => port.exec(SQL.deleteEntries(roomId, belowSeq)),
    countEntries: async (roomId) => Number((await port.select(SQL.countEntries(roomId)))[0]?.n ?? 0),
    listOutbox: async (roomId) => parse<ImOutboxRecord>(await port.select(SQL.listOutbox(roomId))),
    putOutbox: (item) => port.exec(SQL.putOutbox(item)),
    deleteOutbox: (id) => port.exec(SQL.deleteOutbox(id)),
    getMeta: async (key) => {
      const row = (await port.select(SQL.getMeta(key)))[0]
      return row ? String(row.v) : undefined
    },
    putMeta: (key, value) => port.exec(SQL.putMeta(key, value)),
    getDirectory: () => one<ImSnapshot<ImDirectory>>(SQL.getSnapshot('directory')),
    putDirectory: (s) => port.exec(SQL.putSnapshot('directory', s)),
    getStickers: () => one<ImSnapshot<ImSticker[]>>(SQL.getSnapshot('stickers')),
    putStickers: (s) => port.exec(SQL.putSnapshot('stickers', s)),
    async getBlob(key) {
      const row = (await port.select(SQL.getBlob(key)))[0]
      return row ? { ...blobMeta(row), body: String(row.body) } : undefined
    },
    async putBlob(blob) {
      const old = (await port.select(SQL.getBlob(blob.key)))[0]
      await port.exec(SQL.putBlob(blob))
      if (old && String(old.body) !== blob.body) afterCommit.push(String(old.body))
    },
    touchBlob: (key, usedAt) => port.exec(SQL.touchBlob(key, usedAt)),
    async deleteBlob(key) {
      const old = (await port.select(SQL.getBlob(key)))[0]
      await port.exec(SQL.deleteBlob(key))
      if (old) afterCommit.push(String(old.body))
    },
    listBlobs: async () => (await port.select(SQL.listBlobs())).map(blobMeta),
  }
}

/**
 * 在一个执行端口上建 `ImCache`：先建表，再按串行队列执行。每个不在 `tx` 里的单独读写也包成一个事务，
 * 所以任意两次调用之间不会交错。回调抛错 → ROLLBACK 后原样抛出。
 */
export async function createSqliteCache(name: string, port: SqlPort): Promise<ImCache> {
  for (const sql of SCHEMA_SQL) await port.exec(sql)
  let queue: Promise<unknown> = Promise.resolve()
  let closed = false
  let destroyed = false

  function tx<R>(fn: (ops: ImCacheOps) => Promise<R>): Promise<R> {
    const run = async () => {
      if (closed) throw new Error('im cache closed')
      const files: string[] = []
      await port.exec('BEGIN')
      let out: R
      try {
        out = await fn(opsOn(port, files))
      } catch (e) {
        await port.exec('ROLLBACK').catch(() => {})
        throw e
      }
      await port.exec('COMMIT')
      for (const f of files) await port.removeFile(f)
      return out
    }
    const next = queue.then(run, run)
    queue = next.catch(() => {})
    return next
  }

  const single =
    <A extends unknown[], R>(pick: (ops: ImCacheOps) => (...a: A) => Promise<R>) =>
    (...a: A) =>
      tx((ops) => pick(ops)(...a))

  return {
    name,
    tx,
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
    async close() {
      await queue
      if (closed) return
      closed = true
      await port.close()
    },
    /** 删库：先删全部附件文件，再关连接删库文件；删文件失败时清空各表兜底。可重复调用，第二次什么都不做 */
    async destroy() {
      await queue
      if (destroyed) return
      destroyed = true
      const files = closed ? [] : await port.select(`SELECT body FROM ${T.blobs}`)
      for (const r of files) await port.removeFile(String(r.body))
      if (!closed) {
        closed = true
        await port.close()
      }
      await port.drop()
    },
  }
}

// ---------- plus.sqlite 端口（只在 App 上调用） ----------

/** 结构版本进库文件名：结构变了直接换新库，旧库在清除时一并删除。 */
export const sqliteFile = (name: string) => `_doc/${name}-v${IM_CACHE_SCHEMA}.db`

/** 记录本机建过的库，清除（退出/被踢/换账号）时逐个删除。 */
const KNOWN_KEY = 'qw.im.sqlite'
const known = (): string[] => {
  const v: unknown = uni.getStorageSync(KNOWN_KEY)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** plus.io 删除一个本地文件（不存在也算成功）。 */
export function removeLocalFile(path: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof plus === 'undefined') return resolve()
    plus.io.resolveLocalFileSystemURL(
      path,
      (entry) => entry.remove(() => resolve(), () => resolve()),
      () => resolve(),
    )
  })
}

/**
 * 一个命名空间在 `_doc/` 下的全部库文件：各结构版本的 `<name>-v<n>.db` 及其日志文件。结构版本升级后旧版本的库
 * 文件不会再被打开，清除时要一起删掉。
 */
export function ownSqliteFiles(name: string, files: readonly string[]): string[] {
  const escaped = name.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')
  const own = new RegExp(`^${escaped}-v\\d+\\.db(-journal|-wal|-shm)?$`)
  return files.filter((f) => own.test(f))
}

/** `_doc/` 下的文件名（读不出来时为空）。 */
function docFiles(): Promise<string[]> {
  return new Promise((resolve) =>
    plus.io.resolveLocalFileSystemURL(
      '_doc/',
      (dir) =>
        dir.createReader().readEntries(
          // 类型声明写成单个条目，运行时是数组
          (entries) =>
            resolve(
              (entries as unknown as PlusIoDirectoryEntry[])
                .filter((e) => e.isFile)
                .map((e) => String(e.name)),
            ),
          () => resolve([]),
        ),
      () => resolve([]),
    ),
  )
}

/** 删除一个命名空间的全部库文件（含旧结构版本的），并从本机清单里去掉它。 */
async function removeSqliteFiles(name: string): Promise<void> {
  for (const f of ownSqliteFiles(name, await docFiles())) await removeLocalFile(`_doc/${f}`)
  // 列目录失败时至少删掉当前版本的
  await removeLocalFile(sqliteFile(name))
  uni.setStorageSync(
    KNOWN_KEY,
    known().filter((n) => n !== name),
  )
}

/** App：打开（或新建）一个账号命名空间的 SQLite 缓存。 */
export async function openSqliteCache(name: string): Promise<ImCache> {
  const path = sqliteFile(name)
  const call = <R>(fn: (cb: { success: (r: R) => void; fail: (e: unknown) => void }) => void) =>
    new Promise<R>((resolve, reject) =>
      fn({ success: resolve, fail: (e) => reject(new Error(JSON.stringify(e))) }),
    )
  if (!plus.sqlite.isOpenDatabase({ name, path }))
    await call<void>((cb) => plus.sqlite.openDatabase({ name, path, ...cb }))
  const list = known()
  if (!list.includes(name)) uni.setStorageSync(KNOWN_KEY, [...list, name])
  const port: SqlPort = {
    exec: (sql) => call<void>((cb) => plus.sqlite.executeSql({ name, sql: [sql], ...cb })),
    select: (sql) => call<SqlRow[]>((cb) => plus.sqlite.selectSql({ name, sql, ...cb })),
    close: () =>
      plus.sqlite.isOpenDatabase({ name, path })
        ? call<void>((cb) => plus.sqlite.closeDatabase({ name, ...cb })).catch(() => {})
        : Promise.resolve(),
    drop: () => removeSqliteFiles(name),
    removeFile: (file) =>
      new Promise((resolve) =>
        uni.removeSavedFile({ filePath: file, complete: () => resolve() }),
      ),
  }
  return createSqliteCache(name, port)
}

/**
 * App：删除除 `keep` 以外本机建过的全部聊天库（换账号）；`keep` 为 null 时全部删除（退出、被踢）。
 * 附件文件在各自库的 destroy 里删；这里打不开的库只删文件。
 */
export async function deleteOtherSqliteCaches(keep: string | null): Promise<void> {
  for (const name of known()) {
    if (name === keep) continue
    try {
      await (await openSqliteCache(name)).destroy()
    } catch {
      await removeSqliteFiles(name)
    }
  }
}
