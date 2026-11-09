// 本地优先聊天引擎：缓存契约（内存实现）、冷启动按元组增删、同步竞态（单飞、请求序号、本地修订号）、
// 大缺口改拉尾页、撤回/编辑只改目标行、代际作废迟到响应、读提示零请求、锁定与清除、发件箱状态机。
// 接口是内存里的假服务端，定时器与时钟由用例推进。
import { describe, expect, it, vi } from 'vitest'
import {
  IM_LIMITS,
  type ImEntriesQuery,
  type ImEntry,
  type ImEntrySend,
  type ImRoomDetail,
  type ImSyncTuple,
} from '../im.schema.js'
import type { ImApi, ImApiError, ImEngine } from './cache.js'
import { runImCacheContract } from './cache-contract.js'
import { createImEngine, imCacheName, imHomeTenantId, putCachedBlob } from './engine.js'
import { createMemoryCache } from './memory-cache.js'

const ME = 1
const PEER = 2

it('retains exact account cache namespaces without browser crypto or TextEncoder', async () => {
  vi.stubGlobal('crypto', undefined)
  vi.stubGlobal('TextEncoder', undefined)
  try {
    expect(await imCacheName('https://example.test', 1, 7)).toBe('qw-im-f1a93e22f4442a56')
    const origin = `https://${String.fromCodePoint(0x4f8b, 0x5b50)}.test/${String.fromCodePoint(0x1f600)}`
    expect(await imCacheName(origin, 19, 42)).toBe('qw-im-c2c39f77921a5447')
    expect(await imCacheName('https://example.test', 17, 1)).toBe('qw-im-ed3cc95b963b0fb7')
  } finally {
    vi.unstubAllGlobals()
  }
})

const err = (status: number, code?: string): ImApiError => ({ status, code })

const mk = (seq: number, p: Partial<ImEntry> = {}): ImEntry => ({
  seq,
  kind: 'text',
  authorId: PEER,
  authorKind: 'admin',
  authorLabel: 'Peer',
  clientEntryId: null,
  text: `m${seq}`,
  stickerCode: null,
  attachment: null,
  event: null,
  targetSeq: null,
  rev: 1,
  createdAt: new Date(Date.UTC(2026, 10, 3, 0, 0, 0, seq)).toISOString(),
  editedAt: null,
  recalledAt: null,
  recalledBy: null,
  ...p,
})

interface ServerRoom {
  periodId: number
  entries: ImEntry[]
  readSeq: number
  floorSeq: number
  metaRev: number
  label: string | null
}

/** 内存里的假服务端：结果在调用时算好，`hold` 可以把响应压住，`fail` 让下一次调用失败。 */
class FakeServer {
  epoch = 'e1'
  rooms = new Map<number, ServerRoom>()
  calls: { m: string; a: unknown[] }[] = []
  objects = 100
  private gates = new Map<string, (() => Promise<void>)[]>()
  private failures = new Map<string, unknown[]>()

  room(id: number, patch: Partial<ServerRoom> = {}) {
    const r: ServerRoom = {
      periodId: id * 10,
      entries: [],
      readSeq: 0,
      floorSeq: 1,
      metaRev: 1,
      label: null,
      ...patch,
    }
    this.rooms.set(id, r)
    return r
  }
  last(r: ServerRoom) {
    return r.entries.at(-1)?.seq ?? 0
  }
  post(roomId: number, p: Partial<ImEntry> = {}) {
    const r = this.rooms.get(roomId)!
    const e = mk(this.last(r) + 1, p)
    r.entries.push(e)
    return e
  }
  /** 连发 n 条对方的消息 */
  many(roomId: number, n: number) {
    for (let i = 0; i < n; i++) this.post(roomId)
  }
  tuple(id: number): ImSyncTuple {
    const r = this.rooms.get(id)!
    return [id, r.periodId, this.last(r), r.readSeq, r.floorSeq, r.metaRev]
  }
  detail(id: number): ImRoomDetail {
    const r = this.rooms.get(id)!
    const unread = r.entries.filter(
      (e) => e.seq > r.readSeq && e.kind !== 'event' && e.authorId !== ME && !e.recalledAt,
    ).length
    const last = r.entries.at(-1)
    return {
      roomId: id,
      periodId: r.periodId,
      kind: 'group',
      label: r.label,
      memberCount: 3,
      closedAt: null,
      role: 'participant',
      visibleFromSeq: 1,
      lastSeq: this.last(r),
      readSeq: r.readSeq,
      floorSeq: r.floorSeq,
      metaRev: r.metaRev,
      lastAt: last?.createdAt ?? null,
      unread: Math.min(unread, IM_LIMITS.unreadCap),
      preview: null,
    }
  }
  hold(m: string) {
    let release!: () => void
    const p = new Promise<void>((r) => (release = r))
    const list = this.gates.get(m) ?? []
    list.push(() => p)
    this.gates.set(m, list)
    return release
  }
  fail(m: string, e: unknown) {
    const list = this.failures.get(m) ?? []
    list.push(e)
    this.failures.set(m, list)
  }
  count(m: string) {
    return this.calls.filter((c) => c.m === m).length
  }
  private async call<T>(m: string, a: unknown[], compute: () => T): Promise<T> {
    this.calls.push({ m, a })
    const failure = this.failures.get(m)?.shift()
    let result: T | undefined
    let thrown: unknown
    if (!failure)
      try {
        result = structuredClone(compute())
      } catch (e) {
        thrown = e
      }
    const gate = this.gates.get(m)?.shift()
    if (gate) await gate()
    if (failure) throw failure
    if (thrown) throw thrown
    return result as T
  }
  private find(roomId: number) {
    const r = this.rooms.get(roomId)
    if (!r) throw err(404, 'B5002')
    return r
  }

  api: ImApi = {
    options: () =>
      this.call('options', [], () => ({
        textMaxChars: 5000,
        fileMaxMb: 20,
        fileExts: ['pdf'],
        imageExts: ['png'],
        recallMinutes: 2,
        editMinutes: 5,
        groupRecallAnytime: true,
        groupMaxMembers: 200,
        stickerMax: 100,
        epoch: this.epoch,
      })),
    sync: (etag) =>
      this.call('sync', [etag], () => {
        const rooms = [...this.rooms.keys()].sort((a, b) => a - b).map((id) => this.tuple(id))
        const tag = JSON.stringify(rooms)
        return tag === etag
          ? { status: 304 as const, etag: tag }
          : { status: 200 as const, etag: tag, data: { epoch: this.epoch, rooms } }
      }),
    syncDetails: (ids) =>
      this.call('details', [[...ids]], () =>
        ids.filter((id) => this.rooms.has(id)).map((id) => this.detail(id)),
      ),
    entries: (roomId, q: Partial<ImEntriesQuery>) =>
      this.call('entries', [roomId, q], () => {
        const r = this.find(roomId)
        const rows = r.entries.filter((e) => e.seq >= r.floorSeq)
        const limit = q.limit ?? 50
        let items: ImEntry[]
        let hasMore = false
        if (q.seqs) items = rows.filter((e) => q.seqs!.includes(e.seq))
        else if (q.afterSeq !== undefined) {
          const after = rows.filter((e) => e.seq > q.afterSeq!)
          items = after.slice(0, limit)
          hasMore = after.length > limit
        } else if (q.beforeSeq !== undefined) {
          const before = rows.filter((e) => e.seq < q.beforeSeq!)
          items = before.slice(-limit)
          hasMore = before.length > limit
        } else {
          items = rows.slice(-limit)
          hasMore = rows.length > limit
        }
        return {
          items,
          hasMore,
          lastSeq: this.last(r),
          floorSeq: r.floorSeq,
          visibleFromSeq: 1,
        }
      }),
    upload: (roomId, file) =>
      this.call('upload', [roomId, file], () => ({
        objectId: ++this.objects,
        name: file.name,
        size: file.size,
        mime: file.mime,
      })),
    send: (roomId, body: ImEntrySend) =>
      this.call('send', [roomId, body], () => {
        const r = this.find(roomId)
        const dup = r.entries.find((e) => e.clientEntryId === body.clientEntryId)
        if (dup) return dup
        return this.post(roomId, {
          authorId: ME,
          clientEntryId: body.clientEntryId,
          kind: body.kind,
          text: body.text ?? null,
          stickerCode: body.stickerCode ?? null,
        })
      }),
    edit: (roomId, seq, body) =>
      this.call('edit', [roomId, seq, body], () => {
        const e = this.find(roomId).entries.find((x) => x.seq === seq)!
        if (e.rev !== body.rev) throw err(409, 'B5009')
        Object.assign(e, { text: body.text, rev: e.rev + 1 })
        return e
      }),
    recall: (roomId, seq) =>
      this.call('recall', [roomId, seq], () => {
        const e = this.find(roomId).entries.find((x) => x.seq === seq)!
        Object.assign(e, { text: null, recalledAt: e.createdAt, recalledBy: ME })
        return e
      }),
    read: (roomId, seq) =>
      this.call('read', [roomId, seq], () => {
        const r = this.find(roomId)
        r.readSeq = Math.max(r.readSeq, Math.min(seq, this.last(r)))
        return { readSeq: r.readSeq }
      }),
    directory: (etag) =>
      this.call('directory', [etag], () =>
        etag === 'd1'
          ? { status: 304 as const, etag: 'd1' }
          : { status: 200 as const, etag: 'd1', data: { depts: [], users: [] } },
      ),
    stickers: (etag) =>
      this.call('stickers', [etag], () =>
        etag === 's1'
          ? { status: 304 as const, etag: 's1' }
          : { status: 200 as const, etag: 's1', data: [] },
      ),
  }
}

/** 手动推进的定时器。 */
class Timers {
  private next = 1
  pending = new Map<number, { fn: () => void; ms: number }>()
  set = (fn: () => void, ms: number) => {
    const id = this.next++
    this.pending.set(id, { fn, ms })
    return id
  }
  clear = (id: unknown) => void this.pending.delete(id as number)
  /** 跑掉当前全部定时器 */
  runAll() {
    const due = [...this.pending.entries()]
    this.pending.clear()
    for (const [, t] of due) t.fn()
  }
  delays() {
    return [...this.pending.values()].map((t) => t.ms)
  }
}

/** 让微任务与内存缓存的事务队列都走完。 */
const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r))
}

function setup(leader = true) {
  const srv = new FakeServer()
  const cache = createMemoryCache('qw-im-test')
  const timers = new Timers()
  const clock = { now: 1_800_000_000_000 }
  let ids = 0
  const make = (): ImEngine =>
    createImEngine({
      api: srv.api,
      cache,
      userId: ME,
      isLeader: () => leader,
      now: () => clock.now,
      newId: () => `c${++ids}`,
      setTimer: timers.set,
      clearTimer: timers.clear,
    })
  return { srv, cache, timers, clock, make }
}

describe('cache contract', () => {
  it('passes against the memory cache', async () => {
    let n = 0
    const results = await runImCacheContract(async () => createMemoryCache(`qw-im-c${n++}`))
    expect(results.filter((r) => r.error)).toEqual([])
    expect(results.length).toBeGreaterThan(8)
  })

  it('names the namespace after the source, the tenant and the user', async () => {
    const a = await imCacheName('https://a.example', 1, 7)
    expect(a).toMatch(/^qw-im-[0-9a-f]{16}$/)
    expect(await imCacheName('https://a.example', 1, 7)).toBe(a)
    expect(await imCacheName('https://a.example', 1, 8)).not.toBe(a)
    expect(await imCacheName('https://a.example', 2, 7)).not.toBe(a)
    expect(await imCacheName('https://b.example', 1, 7)).not.toBe(a)
    // 命名空间租户：本人租户；代入别的租户不换库；没有租户信息按默认租户
    expect(imHomeTenantId({ id: 5, acting: false })).toBe(5)
    expect(imHomeTenantId({ id: 5, acting: true })).toBe(1)
    expect(imHomeTenantId(null)).toBe(1)
    expect(imHomeTenantId(undefined)).toBe(1)
  })

  it('evicts the least recently used object blobs beyond the cap, never pending uploads', async () => {
    const cache = createMemoryCache('qw-im-blobs')
    await cache.putBlob({ key: 'u:pending', size: 50, usedAt: 0, roomId: 1, body: 'f' })
    await putCachedBlob(cache, { key: 'o:1', size: 40, usedAt: 1, roomId: 1, body: 'a' }, 100)
    await putCachedBlob(cache, { key: 's:x', size: 40, usedAt: 2, roomId: null, body: 'b' }, 100)
    await putCachedBlob(cache, { key: 'o:3', size: 40, usedAt: 3, roomId: 1, body: 'c' }, 100)
    expect((await cache.listBlobs()).map((b) => b.key).sort()).toEqual(['o:3', 's:x', 'u:pending'])
  })
})

describe('cold start and full sync', () => {
  it('adds rooms from the tuples, fetches their details once, then revalidates with 304', async () => {
    const { srv, cache, make } = setup()
    srv.room(1, { label: 'One' })
    srv.room(2)
    srv.many(1, 3)
    const engine = make()
    await engine.start()
    await settle()
    expect(engine.state).toBe('ready')
    expect((await cache.listRooms()).map((r) => r.roomId).sort()).toEqual([1, 2])
    const one = (await cache.getRoom(1))!
    expect(one.detail?.label).toBe('One')
    expect(one.unread).toBe(3)
    expect(one.unreadEstimated).toBe(false)
    expect(srv.count('details')).toBe(1)
    expect(srv.count('entries')).toBe(0)

    // 重新加载：同一个缓存，新引擎
    engine.dispose()
    srv.calls = []
    const again = make()
    await again.start()
    await settle()
    expect(srv.calls.map((c) => c.m)).toEqual(['options', 'sync'])
    expect(srv.calls[1]!.a[0]).toBeTruthy()
  })

  it('drops vanished rooms, clears the window on a new period and rows below a raised floor', async () => {
    const { srv, cache, make } = setup()
    srv.room(1)
    srv.room(2)
    srv.room(3)
    srv.many(1, 5)
    srv.many(3, 5)
    const engine = make()
    await engine.start()
    await engine.openRoom(1)
    await engine.openRoom(3)
    await settle()
    expect(await cache.countEntries(1)).toBe(5)

    srv.rooms.delete(2)
    srv.rooms.get(1)!.periodId = 99
    srv.rooms.get(3)!.floorSeq = 4
    await engine.fullSync('foreground')
    await settle()
    expect(await cache.getRoom(2)).toBeUndefined()
    const one = (await cache.getRoom(1))!
    expect([one.periodId, one.windowLow, one.windowHigh]).toEqual([99, 0, 0])
    expect(await cache.countEntries(1)).toBe(0)
    expect((await cache.getEntries(3)).map((e) => e.seq)).toEqual([4, 5])
    expect((await cache.getRoom(3))!.windowLow).toBe(4)
  })

  it('takes the max of lastSeq and readSeq', async () => {
    const { srv, cache, make } = setup()
    srv.room(1)
    srv.many(1, 2)
    const engine = make()
    await engine.start()
    await settle()
    // 本地已读到 5（别的设备），服务端快照仍是 0
    const r = (await cache.getRoom(1))!
    await cache.putRoom({ ...r, readSeq: 5, lastSeq: 9 })
    await engine.fullSync('poll')
    await settle()
    const after = (await cache.getRoom(1))!
    expect([after.lastSeq, after.readSeq]).toEqual([9, 5])
  })
})

describe('sync races', () => {
  it('merges triggers during a full sync into one more run', async () => {
    const { srv, make } = setup()
    srv.room(1)
    const engine = make()
    await engine.start()
    await settle()
    srv.calls = []
    srv.post(1)
    const release = srv.hold('sync')
    const first = engine.fullSync('poll')
    void engine.fullSync('reconnect')
    void engine.fullSync('foreground')
    void engine.fullSync('poll')
    await settle()
    expect(srv.count('sync')).toBe(1)
    release()
    await first
    await settle()
    expect(srv.count('sync')).toBe(2)
  })

  it('keeps a room a hint created while an older full sync was in flight', async () => {
    const { srv, cache, make } = setup()
    srv.room(1)
    const engine = make()
    await engine.start()
    await settle()
    // 旧快照必须是 200（元组有变化），否则 304 根本不走删除
    srv.post(1)
    const release = srv.hold('sync')
    const sync = engine.fullSync('poll')
    await settle()
    // 请求发出后才建出的会话：旧快照里没有它
    srv.room(5)
    srv.post(5)
    engine.onEntryHint({ roomId: 5, seq: 1, authorId: PEER, kind: 'text' })
    await settle()
    expect(await cache.getRoom(5)).toBeDefined()
    release()
    await sync
    await settle()
    expect(await cache.getRoom(5)).toBeDefined()
  })

  it('applies only the newer of two out-of-order responses for a room', async () => {
    const { srv, cache, make } = setup()
    srv.room(1, { label: 'Old' })
    const engine = make()
    await engine.start()
    await settle()
    srv.rooms.get(1)!.metaRev = 2
    // 全量同步的详情先发出、后返回
    const release = srv.hold('details')
    const sync = engine.fullSync('poll')
    await settle()
    srv.rooms.get(1)!.label = 'New'
    srv.rooms.get(1)!.metaRev = 3
    engine.onRoomHint({ roomId: 1 })
    await settle()
    expect((await cache.getRoom(1))!.detail?.label).toBe('New')
    release()
    await sync
    await settle()
    expect((await cache.getRoom(1))!.detail?.label).toBe('New')
  })

  it('ignores an older tuple snapshot after a newer detail moved the room to a new period', async () => {
    const { srv, cache, make } = setup()
    srv.room(1)
    const engine = make()
    await engine.start()
    await settle()
    srv.post(1)
    const release = srv.hold('sync')
    const sync = engine.fullSync('poll')
    await settle()
    // 退群后再加入：新时期的详情先到
    srv.rooms.get(1)!.periodId = 11
    engine.onRoomHint({ roomId: 1 })
    await settle()
    expect((await cache.getRoom(1))!.periodId).toBe(11)
    await engine.openRoom(1)
    await settle()
    const details = srv.count('details')
    release()
    await sync
    await settle()
    const r = (await cache.getRoom(1))!
    expect(r.periodId).toBe(11)
    expect(r.windowHigh).toBeGreaterThan(0)
    expect(await cache.countEntries(1)).toBeGreaterThan(0)
    expect(srv.count('details')).toBe(details)
  })

  it('keeps a room a newer local write touched while a detail batch that misses it was in flight', async () => {
    const { srv, cache, make } = setup()
    srv.room(1)
    const engine = make()
    await engine.start()
    await settle()
    srv.post(1)
    const releaseSync = srv.hold('sync')
    const releaseDetails = srv.hold('details')
    const sync = engine.fullSync('poll')
    await settle()
    // 快照里还有它；取详情时服务端已没有（详情批次会想删它）
    srv.rooms.delete(1)
    releaseSync()
    await settle()
    // 详情在途时一条提示更新了本地会话：修订号比这批请求新
    engine.onEntryHint({ roomId: 1, seq: 9, authorId: PEER, kind: 'text' })
    await settle()
    expect((await cache.getRoom(1))!.lastSeq).toBe(9)
    releaseDetails()
    await sync
    await settle()
    expect(await cache.getRoom(1)).toBeDefined()
  })

  it('drops responses that arrive after a wipe', async () => {
    const { srv, cache, make } = setup()
    srv.room(1)
    const engine = make()
    const release = srv.hold('sync')
    const start = engine.start()
    await settle()
    const gen = engine.generation
    await engine.clear()
    expect(engine.generation).toBe(gen + 1)
    release()
    await start
    await settle()
    expect(await cache.listRooms()).toEqual([])
    expect(await cache.getMeta('syncEtag')).toBeUndefined()
  })
})

describe('opening rooms and pulling', () => {
  it('shows a cached room without any request and pulls only the increment', async () => {
    const { srv, cache, make } = setup()
    srv.room(1)
    srv.many(1, 4)
    const engine = make()
    await engine.start()
    await engine.openRoom(1)
    await settle()
    expect(srv.count('entries')).toBe(1)
    engine.closeRoom(1)
    srv.calls = []
    await engine.openRoom(1)
    await settle()
    expect(srv.count('entries')).toBe(0)

    const e = srv.post(1)
    engine.onEntryHint({ roomId: 1, seq: e.seq, authorId: PEER, kind: 'text' })
    await settle()
    expect(srv.calls.map((c) => c.m)).toEqual(['entries'])
    expect(srv.calls[0]!.a[1]).toMatchObject({ afterSeq: 4 })
    expect((await cache.getRoom(1))!.windowHigh).toBe(5)
  })

  it('patches a closed room from the hint alone: lastSeq and an estimated unread, no request', async () => {
    const { srv, cache, make } = setup()
    srv.room(1)
    srv.many(1, 2)
    const engine = make()
    await engine.start()
    await settle()
    srv.calls = []
    srv.post(1)
    engine.onEntryHint({ roomId: 1, seq: 3, authorId: PEER, kind: 'text' })
    engine.onEntryHint({ roomId: 1, seq: 4, authorId: ME, kind: 'text' })
    await settle()
    expect(srv.calls).toEqual([])
    const r = (await cache.getRoom(1))!
    expect([r.lastSeq, r.unread, r.unreadEstimated]).toEqual([4, 3, true])
  })

  it('pulls a list-visible room after a one second debounce', async () => {
    const { srv, timers, make } = setup()
    srv.room(1)
    srv.many(1, 2)
    const engine = make()
    await engine.start()
    await engine.openRoom(1)
    engine.closeRoom(1)
    await settle()
    engine.setVisibleRooms([1])
    srv.calls = []
    srv.post(1)
    engine.onEntryHint({ roomId: 1, seq: 3, authorId: PEER, kind: 'text' })
    await settle()
    expect(srv.count('entries')).toBe(0)
    expect(timers.delays()).toContain(1000)
    timers.runAll()
    await settle()
    expect(srv.count('entries')).toBe(1)
  })

  it('reads its own read position from another device with zero requests', async () => {
    const { srv, cache, make } = setup()
    srv.room(1)
    srv.many(1, 5)
    const engine = make()
    await engine.start()
    await engine.openRoom(1)
    await settle()
    srv.calls = []
    engine.onRoomHint({ roomId: 1, readSeq: 3 })
    await settle()
    expect(srv.calls).toEqual([])
    const r = (await cache.getRoom(1))!
    expect([r.readSeq, r.unread, r.unreadEstimated]).toEqual([3, 2, false])
  })

  it('replaces the local window with the tail page when the gap is too large', async () => {
    const { srv, cache, make } = setup()
    srv.room(1)
    srv.many(1, 10)
    const engine = make()
    await engine.start()
    await engine.openRoom(1)
    engine.closeRoom(1)
    await settle()
    srv.many(1, 400)
    await engine.fullSync('poll')
    await settle()
    srv.calls = []
    await engine.openRoom(1)
    await settle()
    const queries = srv.calls.filter((c) => c.m === 'entries').map((c) => c.a[1])
    expect(queries).toEqual([
      { afterSeq: 10, limit: 100 },
      { afterSeq: 110, limit: 100 },
      { afterSeq: 210, limit: 100 },
      { limit: 50 },
    ])
    const r = (await cache.getRoom(1))!
    expect([r.windowLow, r.windowHigh]).toEqual([361, 410])
    expect(await cache.countEntries(1)).toBe(50)
  })

  it('patches only the target of a recall, and refetches only the target of an edit', async () => {
    const { srv, cache, make } = setup()
    srv.room(1)
    srv.many(1, 3)
    srv.post(1, { kind: 'image', text: null, attachment: att(7) })
    const engine = make()
    await engine.start()
    await engine.openRoom(1)
    await settle()
    await cache.putBlob({ key: 'o:7', size: 1, usedAt: 1, roomId: 1, body: 'img' })

    // 对方撤回第 4 条：本地行直接改，不回查
    const target = srv.rooms.get(1)!.entries[3]!
    Object.assign(target, { attachment: null, recalledAt: target.createdAt, recalledBy: PEER })
    const recall = srv.post(1, {
      kind: 'event',
      text: null,
      targetSeq: 4,
      event: { code: 'entry.recall', actorId: PEER },
    })
    srv.calls = []
    engine.onEntryHint({ roomId: 1, seq: recall.seq, authorId: PEER, kind: 'event' })
    await settle()
    expect(srv.calls.map((c) => c.a[1])).toEqual([{ afterSeq: 4, limit: 100 }])
    const recalled = (await cache.getEntry(1, 4))!
    expect([recalled.recalledAt, recalled.attachment]).toEqual([recall.createdAt, null])
    expect(await cache.getBlob('o:7')).toBeUndefined()
    expect((await cache.getEntry(1, 2))!.text).toBe('m2')

    // 对方编辑第 2 条：按 seqs 只回查这一行
    Object.assign(srv.rooms.get(1)!.entries[1]!, { text: 'fixed', rev: 2 })
    const edit = srv.post(1, {
      kind: 'event',
      text: null,
      targetSeq: 2,
      event: { code: 'entry.edit', actorId: PEER },
    })
    srv.calls = []
    engine.onEntryHint({ roomId: 1, seq: edit.seq, authorId: PEER, kind: 'event' })
    await settle()
    expect(srv.calls.map((c) => c.a[1])).toEqual([{ afterSeq: 5, limit: 100 }, { seqs: [2] }])
    expect((await cache.getEntry(1, 2))!.text).toBe('fixed')
    expect((await cache.getEntry(1, 1))!.rev).toBe(1)
  })

  it('a page whose rows fail to write advances nothing: the window stays, its recall patch is rolled back', async () => {
    const { srv, cache, make } = setup()
    srv.room(1)
    srv.many(1, 3)
    const engine = make()
    await engine.start()
    await engine.openRoom(1)
    await settle()
    // 对方撤回第 2 条：这一页先改目标行，再写本页的行——后者失败
    const target = srv.rooms.get(1)!.entries[1]!
    Object.assign(target, { recalledAt: target.createdAt, recalledBy: PEER })
    const recall = srv.post(1, {
      kind: 'event',
      text: null,
      targetSeq: 2,
      event: { code: 'entry.recall', actorId: PEER },
    })
    const realTx = cache.tx
    cache.tx = (fn) =>
      realTx((ops) => {
        let writes = 0
        return fn({
          ...ops,
          putEntries: async (rows) => {
            if (++writes > 1) throw new Error('disk full')
            await ops.putEntries(rows)
          },
        })
      })
    engine.onEntryHint({ roomId: 1, seq: recall.seq, authorId: PEER, kind: 'event' })
    await settle()
    let r = (await cache.getRoom(1))!
    expect([r.windowLow, r.windowHigh]).toEqual([1, 3])
    expect(await cache.getEntry(1, recall.seq)).toBeUndefined()
    expect((await cache.getEntry(1, 2))!.recalledAt).toBeNull()
    cache.tx = realTx
    engine.onEntryHint({ roomId: 1, seq: recall.seq, authorId: PEER, kind: 'event' })
    await settle()
    r = (await cache.getRoom(1))!
    expect([r.windowLow, r.windowHigh]).toEqual([1, recall.seq])
    expect((await cache.getEntry(1, 2))!.recalledAt).toBe(recall.createdAt)
  })

  it('loads older rows with beforeSeq once the local window is used up', async () => {
    const { srv, cache, make } = setup()
    srv.room(1)
    srv.many(1, 120)
    const engine = make()
    await engine.start()
    await engine.openRoom(1)
    await settle()
    expect((await cache.getRoom(1))!.windowLow).toBe(71)
    srv.calls = []
    expect(await engine.loadOlder(1)).toBe(true)
    expect(srv.calls.map((c) => c.a[1])).toEqual([{ beforeSeq: 71, limit: 50 }])
    expect((await cache.getRoom(1))!.windowLow).toBe(21)
    expect(await engine.loadOlder(1)).toBe(false)
    expect(await engine.loadOlder(1)).toBe(false)
    expect(srv.count('entries')).toBe(2)
  })

  it('reports reading once per debounce with the highest rendered seq', async () => {
    const { srv, cache, timers, make } = setup()
    srv.room(1)
    srv.many(1, 6)
    const engine = make()
    await engine.start()
    await engine.openRoom(1)
    await settle()
    engine.markRead(1, 3)
    engine.markRead(1, 5)
    engine.markRead(1, 4)
    timers.runAll()
    await settle()
    expect(srv.calls.filter((c) => c.m === 'read').map((c) => c.a)).toEqual([[1, 5]])
    expect((await cache.getRoom(1))!.unread).toBe(1)
  })
})

const att = (objectId: number) => ({
  objectId,
  thumbObjectId: objectId + 1000,
  name: 'a.png',
  mime: 'image/png',
  size: 3,
  width: 1,
  height: 1,
  sha256: 'ab',
})

describe('lock and wipe', () => {
  it('stays locked when a full sync in flight finishes after a 401 elsewhere', async () => {
    const { srv, timers, make } = setup()
    srv.room(1)
    srv.many(1, 2)
    const engine = make()
    await engine.start()
    await settle()
    srv.post(1)
    const release = srv.hold('details')
    const sync = engine.fullSync('poll')
    await settle()
    srv.fail('read', err(401))
    engine.markRead(1, 2)
    timers.runAll()
    await settle()
    expect(engine.state).toBe('locked')
    release()
    await sync
    await settle()
    expect(engine.state).toBe('locked')
  })

  it('locks on a refresh 401 without deleting anything, and unlocks for the same account', async () => {
    const { srv, cache, make } = setup()
    srv.room(1)
    srv.many(1, 2)
    const engine = make()
    await engine.start()
    await settle()
    srv.fail('sync', err(401))
    await engine.fullSync('foreground')
    await settle()
    expect(engine.state).toBe('locked')
    expect(await cache.getRoom(1)).toBeDefined()
    srv.calls = []
    await engine.fullSync('poll')
    engine.onRoomHint({ roomId: 1 })
    await settle()
    expect(srv.calls).toEqual([])
    await engine.unlock()
    await settle()
    expect(engine.state).toBe('ready')
    expect(await cache.getRoom(1)).toBeDefined()
  })

  it('wipes everything on clear and on an epoch change', async () => {
    const { srv, cache, make } = setup()
    srv.room(1)
    const engine = make()
    const changes: string[] = []
    engine.subscribe((c) => changes.push(c.type))
    await engine.start()
    await settle()
    expect(await cache.listRooms()).toHaveLength(1)
    await engine.clear()
    expect(await cache.listRooms()).toEqual([])
    expect(changes).toContain('cleared')

    const next = make()
    await next.start()
    await settle()
    expect(await cache.getMeta('epoch')).toBe('e1')
    srv.epoch = 'e2'
    const seen: string[] = []
    next.subscribe((c) => seen.push(c.type))
    await next.fullSync('poll')
    await settle()
    expect(seen).toContain('cleared')
    expect(await cache.listRooms()).toEqual([])
    expect(await cache.getMeta('epoch')).toBeUndefined()
  })

  it('stays disabled on a 404 or 403 probe and keeps the cache', async () => {
    for (const status of [404, 403]) {
      const { srv, cache, make } = setup()
      await cache.putMeta('epoch', 'e1')
      srv.fail('options', err(status))
      const engine = make()
      await engine.start()
      expect(engine.state).toBe('disabled')
      expect(srv.count('sync')).toBe(0)
      expect(await cache.getMeta('epoch')).toBe('e1')
    }
  })

  it('goes offline on a network error and retries the full sync a minute later', async () => {
    const { srv, timers, make } = setup()
    srv.room(1)
    srv.fail('options', err(0))
    const engine = make()
    await engine.start()
    expect(engine.state).toBe('offline')
    expect(timers.delays()).toContain(60_000)
    timers.runAll()
    await settle()
    expect(engine.state).toBe('ready')
    expect(srv.count('sync')).toBe(1)
  })
})

describe('outbox', () => {
  const file = { name: 'a.pdf', size: 3, mime: 'application/pdf', localRef: 'u:1' }

  async function ready() {
    const s = setup()
    s.srv.room(1)
    const engine = s.make()
    await engine.start()
    await engine.openRoom(1)
    await settle()
    return { ...s, engine }
  }

  it('writes the outbox first, sends, then stores the row and drops the outbox together', async () => {
    const { srv, cache, engine } = await ready()
    srv.calls = []
    const id = await engine.send(1, { kind: 'text', text: 'hello 😀' })
    await settle()
    expect(srv.calls.map((c) => c.m)).toEqual(['send'])
    expect(await cache.listOutbox()).toEqual([])
    const row = (await cache.getEntry(1, 1))!
    expect([row.clientEntryId, row.text]).toEqual([id, 'hello 😀'])
    const r = (await cache.getRoom(1))!
    expect([r.windowLow, r.windowHigh, r.lastSeq, r.unread]).toEqual([1, 1, 1, 0])
  })

  it('backs off on network errors and resends with the same clientEntryId', async () => {
    const { srv, cache, timers, clock, engine } = await ready()
    srv.fail('send', err(0))
    srv.fail('send', err(503))
    const id = await engine.send(1, { kind: 'text', text: 'x' })
    await settle()
    let [o] = await cache.listOutbox()
    expect([o!.state, o!.attempts, o!.nextAttemptAt - clock.now]).toEqual(['pending', 1, 3000])
    clock.now += 3000
    timers.runAll()
    await settle()
    ;[o] = await cache.listOutbox()
    expect([o!.attempts, o!.nextAttemptAt - clock.now]).toEqual([2, 6000])
    clock.now += 6000
    timers.runAll()
    await settle()
    const sends = srv.calls
      .filter((c) => c.m === 'send')
      .map((c) => (c.a[1] as ImEntrySend).clientEntryId)
    expect(sends).toEqual([id, id, id])
    expect(await cache.listOutbox()).toEqual([])
    expect(srv.rooms.get(1)!.entries).toHaveLength(1)
  })

  it('stops on 4xx and marks the item failed for the user', async () => {
    for (const [status, code] of [
      [400, 'A0400'],
      [403, 'B5001'],
      [413, 'A0413'],
      [422, 'B5013'],
      [409, 'B5007'],
    ] as const) {
      const { srv, cache, timers, engine } = await ready()
      srv.fail('send', err(status, code))
      await engine.send(1, { kind: 'text', text: 'x' })
      await settle()
      const [o] = await cache.listOutbox()
      expect([o!.state, o!.failure]).toEqual(['failed', code])
      expect(timers.delays()).not.toContain(3000)
    }
  })

  it('drops the room on 404 B5002', async () => {
    const { srv, cache, engine } = await ready()
    srv.fail('send', err(404, 'B5002'))
    await engine.send(1, { kind: 'text', text: 'x' })
    await settle()
    expect(await cache.getRoom(1)).toBeUndefined()
    expect(await cache.listOutbox()).toEqual([])
  })

  it('a user retry of a failed item within 24 hours resends the same clientEntryId', async () => {
    const { srv, cache, engine } = await ready()
    srv.fail('send', err(422, 'B5013'))
    const id = await engine.send(1, { kind: 'text', text: 'x' })
    await settle()
    expect((await cache.listOutbox())[0]!.state).toBe('failed')
    await engine.retry(id)
    await settle()
    const sent = srv.calls
      .filter((c) => c.m === 'send')
      .map((c) => (c.a[1] as ImEntrySend).clientEntryId)
    expect(sent).toEqual([id, id])
    expect(await cache.listOutbox()).toEqual([])
  })

  it('uploads a file once even when the send fails afterwards', async () => {
    const { srv, cache, timers, clock, engine } = await ready()
    await cache.putBlob({ key: 'u:1', size: 3, usedAt: 0, roomId: 1, body: 'pdf' })
    srv.fail('send', err(0))
    await engine.send(1, { kind: 'file', file })
    await settle()
    const [o] = await cache.listOutbox()
    expect(o!.objectId).toBe(101)
    clock.now += 3000
    timers.runAll()
    await settle()
    expect(srv.count('upload')).toBe(1)
    expect((srv.calls.filter((c) => c.m === 'send').at(-1)!.a[1] as ImEntrySend).objectId).toBe(101)
    expect(await cache.listOutbox()).toEqual([])
    expect(await cache.getBlob('u:1')).toBeUndefined()
  })

  it('marks an item failed after 24 hours; resending it is a new message', async () => {
    const { srv, cache, timers, clock, engine } = await ready()
    srv.fail('send', err(0))
    const id = await engine.send(1, { kind: 'text', text: 'late' })
    await settle()
    clock.now += 86_400_001
    timers.runAll()
    await settle()
    const [o] = await cache.listOutbox()
    expect([o!.state, o!.failure]).toEqual(['failed', 'expired'])
    await engine.retry(id)
    await settle()
    const sent = srv.calls
      .filter((c) => c.m === 'send')
      .map((c) => (c.a[1] as ImEntrySend).clientEntryId)
    expect(sent).toHaveLength(2)
    expect(sent[1]).not.toBe(id)
    expect(await cache.listOutbox()).toEqual([])
  })

  it('leaves sending to the leader tab', async () => {
    const { srv, cache, make } = setup(false)
    srv.room(1)
    const engine = make()
    await engine.start()
    srv.calls = []
    await engine.send(1, { kind: 'text', text: 'x' })
    await settle()
    expect(srv.calls).toEqual([])
    expect(await cache.listOutbox()).toHaveLength(1)
  })

  it('discards a failed item with its local file', async () => {
    const { srv, cache, engine } = await ready()
    await cache.putBlob({ key: 'u:1', size: 3, usedAt: 0, roomId: 1, body: 'pdf' })
    srv.fail('upload', err(413, 'A0413'))
    const id = await engine.send(1, { kind: 'file', file })
    await settle()
    await engine.discard(id)
    expect(await cache.listOutbox()).toEqual([])
    expect(await cache.getBlob('u:1')).toBeUndefined()
  })
})

describe('directory and stickers', () => {
  it('fetches on first open and revalidates with the stored ETag', async () => {
    const { srv, cache, make } = setup()
    const engine = make()
    await engine.start()
    await engine.loadDirectory()
    await engine.loadStickers()
    expect(await cache.getDirectory()).toMatchObject({ etag: 'd1' })
    await engine.loadDirectory()
    await engine.loadStickers()
    const args = srv.calls
      .filter((c) => c.m === 'directory' || c.m === 'stickers')
      .map((c) => c.a[0])
    expect(args).toEqual([null, null, 'd1', 's1'])
  })

  it('reports whether it got them: false on a failure, so the host may ask again', async () => {
    const { srv, make } = setup()
    const engine = make()
    await engine.start()
    srv.fail('directory', err(503))
    expect(await engine.loadDirectory()).toBe(false)
    expect(await engine.loadDirectory()).toBe(true)
    expect(await engine.loadStickers()).toBe(true)
  })
})
