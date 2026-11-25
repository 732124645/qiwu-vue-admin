// App 聊天缓存的 SQL：生成的语句交给 Node 自带的 node:sqlite 真跑。引号、emoji、注入串原样回读且表完整；
// 非安全整数与 NUL 拒绝；事务里抛错整体回滚；删会话/附件项的文件只在提交后删除；并发调用串行不交错；
// 共同缓存契约用例跑 SQLite 实现。
import { describe, expect, it } from 'vitest'
import { runImCacheContract, type ImEntryRecord, type ImRoomRecord } from '@qiwu/shared/im-client'
import {
  SQL,
  T,
  createSqliteCache,
  ownSqliteFiles,
  sqlInt,
  sqlText,
  type SqlPort,
  type SqlRow,
} from '@/core/im/cache-sqlite'

type NodeSqlite = typeof import('node:sqlite')
const { DatabaseSync } = (
  globalThis as unknown as { process: { getBuiltinModule(id: 'node:sqlite'): NodeSqlite } }
).process.getBuiltinModule('node:sqlite')

/** 一个内存库的执行端口；`removed` 记录被删的附件文件。 */
function nodePort() {
  const db = new DatabaseSync(':memory:')
  const removed: string[] = []
  const port: SqlPort & { db: typeof db; removed: string[] } = {
    db,
    removed,
    exec: async (sql) => void db.exec(sql),
    select: async (sql) => db.prepare(sql).all() as SqlRow[],
    close: async () => {},
    drop: async () => void db.close(),
    removeFile: async (path) => void removed.push(path),
  }
  return port
}

const tables = (port: ReturnType<typeof nodePort>) =>
  (port.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
    name: string
  }[]).map((r) => r.name)

const room = (roomId: number, over: Partial<ImRoomRecord> = {}): ImRoomRecord => ({
  roomId,
  periodId: 1,
  lastSeq: 0,
  readSeq: 0,
  floorSeq: 1,
  metaRev: 1,
  detail: null,
  unread: 0,
  unreadEstimated: false,
  windowLow: 0,
  windowHigh: 0,
  lastAt: null,
  localRev: 1,
  ...over,
})

const entry = (roomId: number, seq: number, text: string): ImEntryRecord => ({
  roomId,
  seq,
  kind: 'text',
  authorId: 7,
  authorKind: 'admin',
  authorLabel: "O'Brien",
  clientEntryId: null,
  text,
  stickerCode: null,
  attachment: null,
  event: null,
  targetSeq: null,
  rev: 1,
  createdAt: '2026-11-03T08:00:00.000Z',
  editedAt: null,
  recalledAt: null,
  recalledBy: null,
})

const NASTY = [
  "it's",
  "''",
  "x'); DROP TABLE im_entries; --",
  "'; DELETE FROM im_rooms WHERE '1'='1",
  '"double" and `back` \\ slash',
  '😀👍🏽 中文 مرحبا',
  'line one\nline two\ttab',
  "   and a lone ' quote",
]

describe('literals', () => {
  it('integers: safe integers only', () => {
    expect(sqlInt(0)).toBe('0')
    expect(sqlInt(-5)).toBe('-5')
    expect(sqlInt(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991')
    for (const bad of [2 ** 53, -(2 ** 53), 1.5, Number.NaN, Infinity, '1' as unknown as number])
      expect(() => sqlInt(bad), String(bad)).toThrow(TypeError)
  })

  it('strings: single quotes doubled, NUL refused', () => {
    expect(sqlText("it's")).toBe("'it''s'")
    expect(sqlText('')).toBe("''")
    expect(() => sqlText('a\u0000b')).toThrow(TypeError)
    expect(() => sqlText(1 as unknown as string)).toThrow(TypeError)
  })

  it('statements refuse unsafe ids and NUL in keys', () => {
    expect(() => SQL.getRoom(2 ** 53)).toThrow(TypeError)
    expect(() => SQL.putEntry(entry(1, 1.5, 'x'))).toThrow(TypeError)
    expect(() => SQL.getEntries(1, { fromSeq: Number.NaN })).toThrow(TypeError)
    expect(() => SQL.deleteOutbox('a\u0000')).toThrow(TypeError)
    expect(() => SQL.putMeta('epoch', 'e\u0000')).toThrow(TypeError)
  })
})

describe('executed in node:sqlite', () => {
  it('quotes, emoji and injection strings read back unchanged; every table survives', async () => {
    const port = nodePort()
    const cache = await createSqliteCache('qw-im-test', port)
    const before = tables(port)
    expect(before).toEqual(Object.values(T).sort())
    await cache.putRoom(room(1, { lastAt: "2026'11" }))
    await cache.putEntries(NASTY.map((text, i) => entry(1, i + 1, text)))
    for (const text of NASTY) await cache.putMeta('epoch', text)
    expect((await cache.getEntries(1)).map((e) => e.text)).toEqual(NASTY)
    expect((await cache.getEntry(1, 3))?.authorLabel).toBe("O'Brien")
    expect(await cache.getMeta('epoch')).toBe(NASTY.at(-1))
    expect((await cache.getRoom(1))?.lastAt).toBe("2026'11")
    await cache.putOutbox({
      clientEntryId: 'c-1',
      roomId: 1,
      kind: 'text',
      text: NASTY[2],
      state: 'pending',
      attempts: 0,
      createdAt: 1,
      nextAttemptAt: 1,
    })
    expect((await cache.listOutbox(1))[0]?.text).toBe(NASTY[2])
    expect(tables(port)).toEqual(before)
    expect(await cache.countEntries(1)).toBe(NASTY.length)
    expect((await cache.listRooms()).map((r) => r.roomId)).toEqual([1])
  })

  it('ranges: from/to, order and a limit taken from the order start', async () => {
    const cache = await createSqliteCache('qw-im-test', nodePort())
    await cache.putEntries([1, 2, 3, 4, 5].map((s) => entry(9, s, `m${s}`)))
    const seqs = async (r: Parameters<typeof cache.getEntries>[1]) =>
      (await cache.getEntries(9, r)).map((e) => e.seq)
    expect(await seqs({ fromSeq: 2, toSeq: 4 })).toEqual([2, 3, 4])
    expect(await seqs({ order: 'desc', limit: 2 })).toEqual([5, 4])
    expect(await seqs({ limit: 2 })).toEqual([1, 2])
    await cache.deleteEntries(9, 3)
    expect(await seqs({})).toEqual([3, 4, 5])
  })

  it('a failing transaction rolls back every write of it', async () => {
    const cache = await createSqliteCache('qw-im-test', nodePort())
    await cache.putRoom(room(1))
    await expect(
      cache.tx(async (ops) => {
        await ops.putRoom(room(2))
        await ops.putEntries([entry(1, 1, 'kept?')])
        await ops.deleteRoom(1)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect((await cache.listRooms()).map((r) => r.roomId)).toEqual([1])
    expect(await cache.countEntries(1)).toBe(0)
    // a statement the generator refuses mid-way rolls back the earlier ones too
    await expect(
      cache.putEntries([entry(1, 1, 'first'), entry(1, 2 ** 53, 'unsafe')]),
    ).rejects.toThrow(TypeError)
    expect(await cache.countEntries(1)).toBe(0)
    // and the queue goes on
    await cache.putEntries([entry(1, 1, 'after')])
    expect((await cache.getEntry(1, 1))?.text).toBe('after')
  })

  it('cached files go only after the commit; a rollback keeps them', async () => {
    const port = nodePort()
    const cache = await createSqliteCache('qw-im-test', port)
    await cache.putBlob({ key: 'o:5', roomId: 3, size: 10, usedAt: 1, body: '_doc/a.png' })
    await cache.putBlob({ key: 's:abc', roomId: null, size: 10, usedAt: 2, body: '_doc/s.png' })
    await expect(
      cache.tx(async (ops) => {
        await ops.deleteRoom(3)
        throw new Error('no')
      }),
    ).rejects.toThrow('no')
    expect(port.removed).toEqual([])
    expect(await cache.getBlob('o:5')).toBeDefined()
    await cache.deleteRoom(3)
    expect(port.removed).toEqual(['_doc/a.png'])
    expect(await cache.getBlob('o:5')).toBeUndefined()
    // sticker-type entries belong to no room
    expect((await cache.listBlobs()).map((b) => b.key)).toEqual(['s:abc'])
    await cache.deleteBlob('s:abc')
    expect(port.removed).toEqual(['_doc/a.png', '_doc/s.png'])
  })

  it('concurrent calls run one after another (no interleaved read-modify-write)', async () => {
    const cache = await createSqliteCache('qw-im-test', nodePort())
    await cache.putMeta('schema', '0')
    await Promise.all(
      Array.from({ length: 20 }, () =>
        cache.tx(async (ops) => {
          const n = Number(await ops.getMeta('schema'))
          await new Promise((r) => setTimeout(r, 1))
          await ops.putMeta('schema', String(n + 1))
        }),
      ),
    )
    expect(await cache.getMeta('schema')).toBe('20')
  })

  it('destroy removes every cached file and drops the database', async () => {
    const port = nodePort()
    const cache = await createSqliteCache('qw-im-test', port)
    await cache.putBlob({ key: 'o:1', roomId: 1, size: 1, usedAt: 1, body: '_doc/1.png' })
    await cache.destroy()
    expect(port.removed).toEqual(['_doc/1.png'])
    expect(port.db.isOpen).toBe(false)
  })

  it('a namespace’s files: every schema version and its journals, nothing of another namespace', () => {
    const files = [
      'qw-im-ab12-v1.db',
      'qw-im-ab12-v2.db',
      'qw-im-ab12-v2.db-journal',
      'qw-im-ab12-v2.db-wal',
      'qw-im-ab12x-v2.db',
      'qw-im-ab12-v2.db.bak',
      'qw-im-cd34-v2.db',
      'notes.txt',
    ]
    expect(ownSqliteFiles('qw-im-ab12', files)).toEqual([
      'qw-im-ab12-v1.db',
      'qw-im-ab12-v2.db',
      'qw-im-ab12-v2.db-journal',
      'qw-im-ab12-v2.db-wal',
    ])
  })

  it('passes the shared cache contract', async () => {
    const results = await runImCacheContract(() => createSqliteCache('qw-im-contract', nodePort()))
    expect(results.length).toBeGreaterThan(0)
    expect(results.filter((r) => r.error)).toEqual([])
  })
})
