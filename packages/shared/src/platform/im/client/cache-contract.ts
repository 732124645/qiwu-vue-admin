import type { ImCache, ImEntryRecord, ImOutboxRecord, ImRoomRecord } from './cache.js'

/** 一条契约用例的结果；`error` 为空表示通过。 */
export interface ImCacheContractResult {
  name: string
  error?: string
}

const room = (roomId: number, patch: Partial<ImRoomRecord> = {}): ImRoomRecord => ({
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
  ...patch,
})

const entry = (roomId: number, seq: number, text = `m${seq}`): ImEntryRecord => ({
  roomId,
  seq,
  kind: 'text',
  authorId: 7,
  authorKind: 'admin',
  authorLabel: 'Ann',
  clientEntryId: null,
  text,
  stickerCode: null,
  attachment: null,
  event: null,
  targetSeq: null,
  rev: 1,
  createdAt: '2026-11-03T00:00:00.000Z',
  editedAt: null,
  recalledAt: null,
  recalledBy: null,
})

const outbox = (clientEntryId: string, roomId: number, createdAt = 1): ImOutboxRecord => ({
  clientEntryId,
  roomId,
  kind: 'text',
  text: 'hi',
  state: 'pending',
  attempts: 0,
  createdAt,
  nextAttemptAt: createdAt,
})

/** 两个汉字（码点构造，源码里不写非语言包的中文字面量） */
const CJK = String.fromCodePoint(0x7814, 0x53d1)

class ContractError extends Error {}
/** 按键名排序后的 JSON：接口不约定对象的键顺序（各实现按自己的列序还原记录），比较只看内容。 */
const canon = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  )
function eq(actual: unknown, expected: unknown, what: string) {
  const a = canon(actual)
  const b = canon(expected)
  if (a !== b) throw new ContractError(`${what}: expected ${b}, got ${a}`)
}

type Case = [name: string, run: (c: ImCache) => Promise<void>]

const CASES: Case[] = [
  [
    'rooms round-trip and copies',
    async (c) => {
      const r = room(1, { lastSeq: 5, lastAt: '2026-11-03T01:00:00.000Z' })
      await c.putRoom(r)
      r.lastSeq = 99
      eq((await c.getRoom(1))?.lastSeq, 5, 'stored value is a copy')
      await c.putRoom(room(2))
      eq((await c.listRooms()).map((x) => x.roomId).sort(), [1, 2], 'listRooms')
      eq(await c.getRoom(3), undefined, 'missing room')
    },
  ],
  [
    'entries by range, order and limit',
    async (c) => {
      await c.putEntries([5, 1, 3, 2, 4].map((s) => entry(1, s)))
      await c.putEntries([entry(2, 1)])
      eq(
        (await c.getEntries(1)).map((e) => e.seq),
        [1, 2, 3, 4, 5],
        'asc by seq',
      )
      eq(
        (await c.getEntries(1, { order: 'desc', limit: 2 })).map((e) => e.seq),
        [5, 4],
        'newest two',
      )
      eq(
        (await c.getEntries(1, { fromSeq: 2, toSeq: 4 })).map((e) => e.seq),
        [2, 3, 4],
        'closed range',
      )
      eq(
        (await c.getEntries(1, { fromSeq: 2, limit: 2 })).map((e) => e.seq),
        [2, 3],
        'limit from the low end',
      )
      eq(await c.countEntries(1), 5, 'count')
      eq((await c.getEntry(1, 3))?.text, 'm3', 'single entry')
      await c.putEntries([entry(1, 3, 'edited')])
      eq((await c.getEntry(1, 3))?.text, 'edited', 'put replaces by (roomId, seq)')
    },
  ],
  [
    'deleteEntries below a seq and all',
    async (c) => {
      await c.putEntries([1, 2, 3, 4].map((s) => entry(1, s)))
      await c.putEntries([entry(2, 1)])
      await c.deleteEntries(1, 3)
      eq(
        (await c.getEntries(1)).map((e) => e.seq),
        [3, 4],
        'below 3 removed',
      )
      await c.deleteEntries(1)
      eq(await c.countEntries(1), 0, 'all removed')
      eq(await c.countEntries(2), 1, 'other room untouched')
    },
  ],
  [
    'deleteRoom removes its entries, outbox and object blobs only',
    async (c) => {
      await c.putRoom(room(1))
      await c.putRoom(room(2))
      await c.putEntries([entry(1, 1), entry(2, 1)])
      await c.putOutbox(outbox('a', 1))
      await c.putOutbox(outbox('b', 2))
      await c.putBlob({ key: 'o:10', size: 3, usedAt: 1, roomId: 1, body: 'x' })
      await c.putBlob({ key: 's:abc', size: 3, usedAt: 1, roomId: null, body: 'y' })
      await c.deleteRoom(1)
      eq(await c.getRoom(1), undefined, 'room gone')
      eq(await c.countEntries(1), 0, 'entries gone')
      eq(
        (await c.listOutbox()).map((o) => o.clientEntryId),
        ['b'],
        'outbox of the room gone',
      )
      eq(
        (await c.listBlobs()).map((b) => b.key),
        ['s:abc'],
        'object blob gone, sticker kept',
      )
      eq(await c.countEntries(2), 1, 'other room kept')
    },
  ],
  [
    'outbox by room in creation order',
    async (c) => {
      await c.putOutbox(outbox('late', 1, 30))
      await c.putOutbox(outbox('early', 1, 10))
      await c.putOutbox(outbox('other', 2, 20))
      eq(
        (await c.listOutbox()).map((o) => o.clientEntryId),
        ['early', 'other', 'late'],
        'all',
      )
      eq(
        (await c.listOutbox(1)).map((o) => o.clientEntryId),
        ['early', 'late'],
        'by room',
      )
      await c.putOutbox({ ...outbox('early', 1, 10), objectId: 42 })
      eq((await c.listOutbox(1))[0]?.objectId, 42, 'put replaces by clientEntryId')
      await c.deleteOutbox('early')
      eq(
        (await c.listOutbox(1)).map((o) => o.clientEntryId),
        ['late'],
        'deleted',
      )
    },
  ],
  [
    'meta, directory and stickers snapshots',
    async (c) => {
      eq(await c.getMeta('epoch'), undefined, 'empty meta')
      await c.putMeta('epoch', 'e-1')
      await c.putMeta('epoch', 'e-2')
      eq(await c.getMeta('epoch'), 'e-2', 'meta replaced')
      const directory = {
        depts: [{ id: 1, parentId: 0, name: `R&D ${CJK}`, sortNo: 1 }],
        users: [{ id: 7, displayName: "O'Brien 😀", avatarUrl: null, deptId: 1 }],
      }
      await c.putDirectory({ etag: 'W/"1"', data: directory, fetchedAt: 5 })
      eq(await c.getDirectory(), { etag: 'W/"1"', data: directory, fetchedAt: 5 }, 'directory')
      await c.putStickers({ etag: null, data: [], fetchedAt: 6 })
      eq((await c.getStickers())?.fetchedAt, 6, 'stickers')
    },
  ],
  [
    'blobs keep bodies, list metadata, touch and delete',
    async (c) => {
      await c.putBlob({ key: 'o:1', size: 10, usedAt: 1, roomId: 1, body: 'body-1' })
      await c.putBlob({ key: 's:f00', size: 20, usedAt: 2, roomId: null, body: 'body-2' })
      eq((await c.getBlob('o:1'))?.body, 'body-1', 'body')
      await c.touchBlob('o:1', 9)
      await c.touchBlob('o:missing', 9)
      const metas = (await c.listBlobs()).sort((a, b) => a.key.localeCompare(b.key))
      eq(
        metas,
        [
          { key: 'o:1', size: 10, usedAt: 9, roomId: 1 },
          { key: 's:f00', size: 20, usedAt: 2, roomId: null },
        ],
        'metadata without bodies',
      )
      await c.deleteBlob('o:1')
      eq(await c.getBlob('o:1'), undefined, 'deleted')
    },
  ],
  [
    'text with quotes, emoji and control-free unicode round-trips',
    async (c) => {
      const text = `'); DROP TABLE x; -- "quoted" 😀👍🏽 \\ ${CJK}\n\ttab`
      await c.putEntries([entry(1, 1, text)])
      eq((await c.getEntry(1, 1))?.text, text, 'unchanged')
    },
  ],
  [
    'tx commits every write together and reads its own writes',
    async (c) => {
      const out = await c.tx(async (ops) => {
        await ops.putRoom(room(1, { windowHigh: 2 }))
        await ops.putEntries([entry(1, 1), entry(1, 2)])
        await ops.deleteOutbox('none')
        return (await ops.getRoom(1))?.windowHigh
      })
      eq(out, 2, 'read inside the transaction')
      eq(await c.countEntries(1), 2, 'entries committed')
      eq((await c.getRoom(1))?.windowHigh, 2, 'room committed')
    },
  ],
  [
    'tx that throws leaves nothing behind',
    async (c) => {
      await c.putRoom(room(1, { windowHigh: 1 }))
      await c.putOutbox(outbox('keep', 1))
      let thrown = false
      try {
        await c.tx(async (ops) => {
          await ops.putEntries([entry(1, 2)])
          await ops.putRoom(room(1, { windowHigh: 2 }))
          await ops.deleteOutbox('keep')
          throw new Error('boom')
        })
      } catch {
        thrown = true
      }
      eq(thrown, true, 'the error reaches the caller')
      eq(await c.countEntries(1), 0, 'no entry written')
      eq((await c.getRoom(1))?.windowHigh, 1, 'room unchanged')
      eq((await c.listOutbox()).length, 1, 'outbox unchanged')
    },
  ],
  [
    'destroy can run twice',
    async (c) => {
      await c.putRoom(room(1))
      await c.putMeta('epoch', 'e')
      await c.destroy()
      await c.destroy()
    },
  ],
]

/**
 * 不依赖测试框架的缓存契约用例集：同一套用例跑内存、IndexedDB 与 SQLite 实现。`make` 每次给一个空缓存；
 * 每条用例结束后销毁它。
 */
export async function runImCacheContract(
  make: () => Promise<ImCache>,
): Promise<ImCacheContractResult[]> {
  const results: ImCacheContractResult[] = []
  for (const [name, run] of CASES) {
    let cache: ImCache | undefined
    try {
      cache = await make()
      await run(cache)
      results.push({ name })
    } catch (e) {
      results.push({ name, error: e instanceof Error ? e.message : String(e) })
    } finally {
      await cache?.destroy().catch(() => undefined)
    }
  }
  return results
}
