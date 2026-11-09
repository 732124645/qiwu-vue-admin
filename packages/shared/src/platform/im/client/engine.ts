import { sha256 } from '@noble/hashes/sha256'
import { encode as utf8Encode } from '@stablelib/utf8'
import {
  IM_CACHE_SCHEMA,
  type ImApiError,
  type ImBlobRecord,
  type ImCache,
  type ImCacheOps,
  type ImChange,
  type ImDraft,
  type ImEngine,
  type ImEngineOptions,
  type ImEngineState,
  type ImEntryRecord,
  type ImOutboxRecord,
  type ImRoomRecord,
  type ImSyncReason,
} from './cache.js'
import {
  IM_COUNTED_KINDS,
  IM_LIMITS,
  IM_SILENT_EVENT_CODES,
  type ImEntries,
  type ImEntry,
  type ImEntryHint,
  type ImEntrySend,
  type ImEntryKind,
  type ImOptions,
  type ImPreview,
  type ImRoomDetail,
  type ImRoomHint,
  type ImSyncTuple,
} from '../im.schema.js'
import { IM_IDB_PREFIX } from './idb-cache.js'
import { DEFAULT_TENANT_ID } from '../../../common/tenancy.js'

/**
 * 命名空间用的租户：本人所属租户。平台用户代入别的租户时聊天仍在本人租户（接口按本人租户回答），所以
 * 代入不换库；没有租户信息（多租户关闭）按默认租户。web 与移动端都经它算库名，两端同一账号同一个库名。
 */
export function imHomeTenantId(tenant: { id: number; acting: boolean } | null | undefined): number {
  return tenant && !tenant.acting ? tenant.id : DEFAULT_TENANT_ID
}

/** 账号命名空间（库名）：`qw-im-<sha256(服务源|tenantId|userId) 前 16 位>`。 */
export async function imCacheName(
  source: string,
  tenantId: number,
  userId: number,
): Promise<string> {
  const data = utf8Encode(`${source}|${tenantId}|${userId}`)
  const hash = sha256(data)
  return (
    IM_IDB_PREFIX + Array.from(hash.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
  )
}

const COUNTED = new Set<ImEntryKind>(IM_COUNTED_KINDS)
const SILENT = new Set<string>(IM_SILENT_EVENT_CODES)
const DAY_MS = 86_400_000
const POLL_MS = 60_000
const HINT_PULL_MS = 1_000
const READ_MS = 1_000
const BACKOFF_MS = 3_000
const BACKOFF_MAX_MS = 60_000
/** 打开会话时向新连拉的页数上限，超过就丢弃本地窗口改拉尾页 */
const AFTER_PAGES = 3
const TAIL = IM_LIMITS.entriesDefault

/** 迟到的结果：所属代际已被清除，整条流程静默放弃。 */
const STALE = Symbol('stale')

const statusOf = (e: unknown) => {
  const s = (e as Partial<ImApiError> | null)?.status
  return typeof s === 'number' ? s : 0
}
const codeOf = (e: unknown) => (e as Partial<ImApiError> | null)?.code
/** 断网、限流、服务端错误：退避重试，既不清也不锁。 */
const transient = (status: number) => status === 0 || status === 429 || status >= 500

const blankRoom = (roomId: number, periodId: number): ImRoomRecord => ({
  roomId,
  periodId,
  lastSeq: 0,
  readSeq: 0,
  floorSeq: 0,
  metaRev: 1,
  detail: null,
  unread: 0,
  unreadEstimated: true,
  windowLow: 0,
  windowHigh: 0,
  lastAt: null,
  localRev: 0,
})

const laterAt = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b)

/** 会话预览（与服务端同一规则：撤回行无正文，事件只给编码，正文截 60 个码点）。 */
function previewOf(e: ImEntry): ImPreview {
  return {
    seq: e.seq,
    kind: e.kind,
    authorId: e.authorId,
    authorLabel: e.authorLabel,
    text: e.text === null ? null : [...e.text].slice(0, IM_LIMITS.previewChars).join(''),
    stickerCode: e.stickerCode,
    eventCode: e.event?.code ?? null,
    recalled: e.recalledAt !== null,
    at: e.createdAt,
  }
}
const isSilent = (e: ImEntry) => e.kind === 'event' && !!e.event && SILENT.has(e.event.code)

/** 附件缓存键（表情类用内容哈希跨会话去重）。 */
export const imBlobKey = {
  object: (objectId: number) => `o:${objectId}`,
  sha: (sha256: string) => `s:${sha256}`,
}

/** 读附件缓存：命中时刷新最近使用时间（LRU）。 */
export async function getCachedBlob(
  cache: ImCache,
  key: string,
  now = Date.now(),
): Promise<ImBlobRecord | undefined> {
  const hit = await cache.getBlob(key)
  if (hit) await cache.touchBlob(key, now)
  return hit
}

/**
 * 写附件缓存并按最近使用时间淘汰到总量以内。只淘汰 `o:`/`s:` 键：发件箱里待上传的文件（宿主自定的其它键）
 * 不能被挤掉。
 */
export async function putCachedBlob(
  cache: ImCache,
  record: ImBlobRecord,
  cap: number = IM_LIMITS.blobCacheBytes,
): Promise<void> {
  await cache.putBlob(record)
  const metas = (await cache.listBlobs())
    .filter((b) => /^[os]:/.test(b.key))
    .sort((a, b) => a.usedAt - b.usedAt)
  let total = metas.reduce((n, b) => n + b.size, 0)
  for (const b of metas) {
    if (total <= cap) break
    if (b.key === record.key) continue
    await cache.deleteBlob(b.key)
    total -= b.size
  }
}

/**
 * 同步、发送与重试流程（依赖注入接口与缓存，不碰 DOM/uni）。规则见 docs/im.md 的本地优先客户端：
 * 冷启动/重连/回前台/断线轮询才全量同步（单飞合并、请求序号、按本地修订号删除）；提示只在本地打补丁，
 * 打开着或列表可见的会话才按 `afterSeq` 拉增量；一批行、窗口上界与发件箱确认在同一个缓存事务里写；
 * 清除时代际 +1，旧代际的在途响应一律丢弃。
 */
export function createImEngine(options: ImEngineOptions): ImEngine {
  const { api, cache, userId } = options
  const isLeader = options.isLeader ?? (() => true)
  const now = options.now ?? Date.now
  const newId = options.newId ?? (() => crypto.randomUUID())
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer =
    options.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let state: ImEngineState = 'idle'
  let generation = 0
  let disposed = false
  let opts: ImOptions | null = null
  const listeners = new Set<(change: ImChange) => void>()
  const open = new Set<number>()
  let visible = new Set<number>()
  /** 请求序号：每个会话只应用比已应用序号新的响应 */
  let reqSeq = 0
  const applied = new Map<number, number>()
  /** 本地修订号时钟（每次写会话 +1） */
  let revClock = 0
  let syncing: Promise<void> | null = null
  let syncDirty = false
  const pulls = new Map<number, Promise<void>>()
  const pullWant = new Map<number, number>()
  const readWant = new Map<number, number>()
  const detailQueue = new Set<number>()
  let detailScheduled = false
  let flushing: Promise<void> | null = null
  let flushAgain = false
  let directoryLoad: Promise<boolean> | null = null
  let stickersLoad: Promise<boolean> | null = null
  const timers = new Map<string, unknown>()

  // ---------- 基础 ----------

  const emit = (change: ImChange) => {
    for (const fn of listeners)
      try {
        fn(change)
      } catch {
        // 界面监听出错不影响引擎
      }
  }
  const setState = (s: ImEngineState) => {
    if (state === s) return
    state = s
    emit({ type: 'state', state: s })
  }
  const running = () => !disposed && state !== 'locked' && state !== 'disabled'
  /** 等待之后核对代际：清除过就放弃 */
  const check = (gen: number) => {
    if (gen !== generation) throw STALE
  }
  const after = (key: string, ms: number, fn: () => void) => {
    const old = timers.get(key)
    if (old !== undefined) clearTimer(old)
    timers.set(
      key,
      setTimer(
        () => {
          timers.delete(key)
          fn()
        },
        Math.max(0, ms),
      ),
    )
  }
  const stopTimers = () => {
    for (const h of timers.values()) clearTimer(h)
    timers.clear()
  }
  /** 后台流程的错误：401 锁定；断网/429/5xx 标离线并 60 秒后再全量同步；其它保持现状等下次触发。 */
  const handle = (e: unknown) => {
    if (e === STALE) return
    const s = statusOf(e)
    if (s === 401) return lock()
    if (transient(s) && running()) {
      setState('offline')
      after('poll', POLL_MS, () => void fullSync('poll'))
    }
  }
  const quiet = (p: Promise<unknown>) => void p.catch(handle)
  const mine = (e: ImEntry) =>
    userId !== undefined ? e.authorId === userId : e.clientEntryId !== null
  /** 本人可见的最小 seq（入群时刻与清理下界的较大者） */
  const lowerBound = (r: ImRoomRecord) => Math.max(1, r.floorSeq, r.detail?.visibleFromSeq ?? 1)

  async function putRoom(ops: ImCacheOps, r: ImRoomRecord) {
    r.localRev = ++revClock
    await ops.putRoom(r)
  }

  /** 清理下界升高：删掉它以下的本地行，窗口随之收缩（整个窗口都在下面就清空）。 */
  async function raiseFloor(ops: ImCacheOps, r: ImRoomRecord, floor: number) {
    await ops.deleteEntries(r.roomId, floor)
    if (r.windowHigh < floor) r.windowLow = r.windowHigh = 0
    else r.windowLow = Math.max(r.windowLow, floor)
    r.floorSeq = floor
  }

  /** 成员时期变了（退群后再加入）：清本地窗口。 */
  async function resetPeriod(ops: ImCacheOps, r: ImRoomRecord, periodId: number) {
    await ops.deleteEntries(r.roomId)
    r.windowLow = r.windowHigh = 0
    r.detail = null
    r.periodId = periodId
  }

  /**
   * 未读：读位置追上就是 0；本地窗口完整覆盖 `(readSeq, lastSeq]` 时按本地行精确重算（不计本人、事件与
   * 撤回）并去掉“估算”；否则只保证不超过 `lastSeq - readSeq`。
   */
  async function recount(ops: ImCacheOps, r: ImRoomRecord) {
    if (r.readSeq >= r.lastSeq) {
      r.unread = 0
      r.unreadEstimated = false
      return
    }
    const covered =
      r.windowHigh >= r.lastSeq &&
      r.windowLow > 0 &&
      r.windowLow <= Math.max(r.readSeq + 1, lowerBound(r))
    if (!covered) {
      r.unread = Math.min(r.unread, r.lastSeq - r.readSeq)
      return
    }
    const rows = await ops.getEntries(r.roomId, { fromSeq: r.readSeq + 1 })
    r.unread = Math.min(
      IM_LIMITS.unreadCap,
      rows.filter((e) => COUNTED.has(e.kind) && !mine(e) && e.recalledAt === null).length,
    )
    r.unreadEstimated = false
  }

  /** 一条详情并入本地会话（建出不存在的会话）。 */
  async function mergeDetail(ops: ImCacheOps, existing: ImRoomRecord | undefined, d: ImRoomDetail) {
    const r = existing ?? blankRoom(d.roomId, d.periodId)
    if (existing && existing.periodId !== d.periodId) await resetPeriod(ops, r, d.periodId)
    r.detail = d
    if (d.floorSeq > r.floorSeq) await raiseFloor(ops, r, d.floorSeq)
    // 提示可能比详情新：本地 lastSeq 更大时未读仍是估算
    const ahead = r.lastSeq > d.lastSeq
    r.lastSeq = Math.max(r.lastSeq, d.lastSeq)
    r.readSeq = Math.max(r.readSeq, d.readSeq)
    r.metaRev = Math.max(r.metaRev, d.metaRev)
    r.lastAt = laterAt(r.lastAt, d.lastAt)
    r.unread = d.unread
    r.unreadEstimated = ahead
    if (r.readSeq > d.readSeq || ahead) await recount(ops, r)
    await putRoom(ops, r)
  }

  // ---------- 全量同步 ----------

  /** 探测 `/options`：404/403 → 停用；epoch 与本地不同 → 整库清除（宿主重建）。 */
  async function probe(gen: number): Promise<boolean> {
    let o: ImOptions
    try {
      o = await api.options()
    } catch (e) {
      check(gen)
      const s = statusOf(e)
      if (s === 404 || s === 403) {
        setState('disabled')
        return false
      }
      throw e
    }
    check(gen)
    opts = o
    const epoch = await cache.getMeta('epoch')
    check(gen)
    if (epoch && epoch !== o.epoch) {
      await clear()
      return false
    }
    if (!epoch) await cache.putMeta('epoch', o.epoch)
    return true
  }

  /** 按元组比较：消失的删除（只删修订号早于请求开始的）、时期变清窗、下界升删行、seq 取 max；返回要取详情的会话。 */
  async function applyTuples(
    ops: ImCacheOps,
    tuples: readonly ImSyncTuple[],
    mySeq: number,
    startRev: number,
    etag: string | null,
  ): Promise<number[]> {
    const local = new Map((await ops.listRooms()).map((r) => [r.roomId, r]))
    const server = new Set(tuples.map((t) => t[0]))
    for (const r of local.values())
      if (!server.has(r.roomId) && r.localRev <= startRev) await ops.deleteRoom(r.roomId)
    const changed: number[] = []
    for (const [roomId, periodId, lastSeq, readSeq, floorSeq, metaRev] of tuples) {
      if ((applied.get(roomId) ?? 0) > mySeq) continue
      const existing = local.get(roomId)
      const r = existing ?? blankRoom(roomId, periodId)
      const diff =
        !existing ||
        r.periodId !== periodId ||
        r.lastSeq !== lastSeq ||
        r.readSeq !== readSeq ||
        r.floorSeq !== floorSeq ||
        r.metaRev !== metaRev ||
        r.unreadEstimated ||
        !r.detail
      if (existing && r.periodId !== periodId) await resetPeriod(ops, r, periodId)
      if (floorSeq > r.floorSeq) await raiseFloor(ops, r, floorSeq)
      r.lastSeq = Math.max(r.lastSeq, lastSeq)
      r.readSeq = Math.max(r.readSeq, readSeq)
      r.metaRev = Math.max(r.metaRev, metaRev)
      applied.set(roomId, mySeq)
      if (!diff) continue
      // 详情取回之前都算估算：中途失败时下一次（哪怕 304）仍会补取
      r.unreadEstimated = true
      r.unread = Math.min(r.unread, Math.max(0, r.lastSeq - r.readSeq))
      await putRoom(ops, r)
      changed.push(roomId)
    }
    // 与这批写入同一事务记下 ETag：写失败就不记，下次照常整份比较
    if (etag) await ops.putMeta('syncEtag', etag)
    return changed
  }

  /** `GET /sync?ids=` 一批：有的并入，缺的（不再是当前成员）删除——同样只删修订号早于请求开始的。 */
  async function fetchDetails(gen: number, ids: readonly number[]) {
    for (let i = 0; i < ids.length; i += IM_LIMITS.idsMax) {
      const batch = ids.slice(i, i + IM_LIMITS.idsMax)
      const mySeq = ++reqSeq
      const startRev = revClock
      const details = await api.syncDetails(batch)
      check(gen)
      const got = new Map(details.map((d) => [d.roomId, d]))
      await cache.tx(async (ops) => {
        for (const id of batch) {
          if ((applied.get(id) ?? 0) > mySeq) continue
          const r = await ops.getRoom(id)
          const d = got.get(id)
          if (d) await mergeDetail(ops, r, d)
          else if (r && r.localRev <= startRev) await ops.deleteRoom(id)
          applied.set(id, mySeq)
        }
      })
      check(gen)
      emit({ type: 'rooms', roomIds: [...batch] })
    }
  }

  /** 一次全量同步：探测 → `/sync`（带 ETag）→ 元组比较 → 变化的会话分批取详情。 */
  async function runSync(gen: number, probed: boolean) {
    setState('syncing')
    if (!probed && !(await probe(gen))) return
    const mySeq = ++reqSeq
    const startRev = revClock
    const etag = (await cache.getMeta('syncEtag')) ?? null
    check(gen)
    const res = await api.sync(etag)
    check(gen)
    let ids: number[]
    if (res.status === 304) {
      ids = (await cache.listRooms())
        .filter((r) => r.unreadEstimated || !r.detail)
        .map((r) => r.roomId)
    } else {
      if (opts && res.data.epoch !== opts.epoch) return void (await clear())
      ids = await cache.tx((ops) => applyTuples(ops, res.data.rooms, mySeq, startRev, res.etag))
      check(gen)
      emit({ type: 'rooms', roomIds: res.data.rooms.map((t) => t[0]) })
    }
    if (ids.length) await fetchDetails(gen, ids)
    // 期间别处 401 已锁定（或停用）：不能被同步结束改回 ready
    if (running()) setState('ready')
  }

  function fullSync(reason: ImSyncReason, probed = false): Promise<void> {
    if (!running() || !isLeader()) return Promise.resolve()
    if (syncing) {
      // 单飞：进行中再触发只记一笔，结束后合并成一次
      syncDirty = true
      return syncing
    }
    const gen = generation
    // 冷启动刚探测过（非主标签页启动后才拿到主锁）：不再重复探测
    let first = probed || (reason === 'cold-start' && opts !== null)
    syncing = (async () => {
      try {
        do {
          syncDirty = false
          await runSync(gen, first)
          first = false
        } while (syncDirty && gen === generation && running())
      } catch (e) {
        handle(e)
      }
    })().finally(() => {
      if (gen === generation) syncing = null
    })
    return syncing
  }

  async function start() {
    if (!running()) return
    const gen = generation
    try {
      const schema = await cache.getMeta('schema')
      check(gen)
      if (schema && schema !== IM_CACHE_SCHEMA) return void (await clear())
      if (!schema) await cache.putMeta('schema', IM_CACHE_SCHEMA)
      for (const r of await cache.listRooms()) revClock = Math.max(revClock, r.localRev)
      check(gen)
      if (!(await probe(gen))) return
      if (isLeader()) await fullSync('cold-start', true)
      else setState('ready')
      quiet(flush())
    } catch (e) {
      handle(e)
    }
  }

  // ---------- 提示 ----------

  function queueDetail(roomId: number) {
    detailQueue.add(roomId)
    if (detailScheduled) return
    detailScheduled = true
    const gen = generation
    // 同一轮事件里的多条提示合并成一个请求
    queueMicrotask(() => {
      detailScheduled = false
      const ids = [...detailQueue]
      detailQueue.clear()
      if (ids.length && gen === generation && running()) quiet(fetchDetails(gen, ids))
    })
  }

  function onEntryHint(h: ImEntryHint) {
    if (!running()) return
    const gen = generation
    quiet(
      (async () => {
        const r = await cache.getRoom(h.roomId)
        check(gen)
        if (!r) {
          if (isLeader()) queueDetail(h.roomId)
          return
        }
        if (isLeader() && h.seq > r.lastSeq) {
          await cache.tx(async (ops) => {
            const cur = await ops.getRoom(h.roomId)
            if (!cur || h.seq <= cur.lastSeq) return
            cur.lastSeq = h.seq
            if (COUNTED.has(h.kind)) {
              cur.lastAt = laterAt(cur.lastAt, new Date(now()).toISOString())
              if (h.authorId !== userId && h.seq > cur.readSeq) {
                cur.unread = Math.min(IM_LIMITS.unreadCap, cur.unread + 1)
                cur.unreadEstimated = true
              }
            }
            await putRoom(ops, cur)
          })
          check(gen)
          emit({ type: 'rooms', roomIds: [h.roomId] })
        }
        if (h.seq <= r.windowHigh) return
        if (open.has(h.roomId)) await pull(h.roomId, h.seq)
        else if (isLeader() && visible.has(h.roomId))
          after(`hint:${h.roomId}`, HINT_PULL_MS, () => quiet(pull(h.roomId, h.seq)))
      })(),
    )
  }

  function onRoomHint(h: ImRoomHint) {
    if (!running() || !isLeader()) return
    if (h.readSeq === undefined) return queueDetail(h.roomId)
    const readSeq = h.readSeq
    const gen = generation
    // 本人在别的设备读了：本地取 max，零请求
    quiet(
      cache
        .tx(async (ops) => {
          const r = await ops.getRoom(h.roomId)
          if (!r || readSeq <= r.readSeq) return false
          r.readSeq = readSeq
          await recount(ops, r)
          await putRoom(ops, r)
          return true
        })
        .then((changed) => {
          check(gen)
          if (changed) emit({ type: 'rooms', roomIds: [h.roomId] })
        }),
    )
  }

  // ---------- 拉取消息 ----------

  /**
   * 一页消息写进本地（一个事务）：窗口上下界、撤回事件直接改目标行、发件箱确认、超 2000 条删最旧、预览与
   * 未读。返回本地窗口里需要按 `seqs` 回查的编辑目标。
   */
  async function applyPage(
    ops: ImCacheOps,
    roomId: number,
    res: ImEntries,
    mode: 'after' | 'before' | 'tail',
  ): Promise<number[]> {
    const r = await ops.getRoom(roomId)
    if (!r) return []
    const items = [...res.items].sort((a, b) => a.seq - b.seq)
    if (res.floorSeq > r.floorSeq) await raiseFloor(ops, r, res.floorSeq)
    r.lastSeq = Math.max(r.lastSeq, res.lastSeq)
    if (r.detail) r.detail = { ...r.detail, visibleFromSeq: res.visibleFromSeq }
    const first = items[0]
    const last = items.at(-1)
    if (mode === 'tail') {
      await ops.deleteEntries(roomId)
      r.windowLow = first?.seq ?? 0
      r.windowHigh = last?.seq ?? 0
    } else if (first && last) {
      if (mode === 'after') {
        // 与窗口不连续（清理推进了下界、第一次拉）：旧窗口作废
        if (r.windowHigh === 0 || first.seq > r.windowHigh + 1) {
          await ops.deleteEntries(roomId)
          r.windowLow = first.seq
        }
        r.windowHigh = Math.max(r.windowHigh, last.seq)
      } else {
        r.windowLow = r.windowLow ? Math.min(r.windowLow, first.seq) : first.seq
        r.windowHigh = Math.max(r.windowHigh, last.seq)
      }
    }
    const here = new Set(items.map((e) => e.seq))
    const editTargets: number[] = []
    for (const e of items) {
      if (e.kind !== 'event' || !e.event || e.targetSeq === null || here.has(e.targetSeq)) continue
      const target = await ops.getEntry(roomId, e.targetSeq)
      if (!target) continue
      if (e.event.code === 'entry.recall' && target.recalledAt === null) {
        // 撤回：直接改本地目标行、清附件缓存，不必回查
        await dropAttachment(ops, target)
        await ops.putEntries([
          {
            ...target,
            text: null,
            stickerCode: null,
            attachment: null,
            recalledAt: e.createdAt,
            recalledBy: e.event.actorId,
          },
        ])
        if (r.detail?.preview?.seq === target.seq)
          r.detail = { ...r.detail, preview: { ...r.detail.preview, text: null, recalled: true } }
      } else if (e.event.code === 'entry.edit') editTargets.push(e.targetSeq)
    }
    await ops.putEntries(items.map((e) => ({ ...e, roomId })))
    const acked = new Set(items.map((e) => e.clientEntryId).filter((id) => id !== null))
    if (acked.size)
      for (const o of await ops.listOutbox(roomId))
        if (acked.has(o.clientEntryId)) await removeOutbox(ops, o)
    if (
      mode !== 'before' &&
      r.windowLow &&
      r.windowHigh - r.windowLow + 1 > IM_LIMITS.localWindow
    ) {
      const cut = r.windowHigh - IM_LIMITS.localWindow + 1
      await ops.deleteEntries(roomId, cut)
      r.windowLow = cut
    }
    for (const e of items) {
      if (isSilent(e)) continue
      r.lastAt = laterAt(r.lastAt, e.createdAt)
      if (r.detail && e.seq >= (r.detail.preview?.seq ?? 0))
        r.detail = { ...r.detail, preview: previewOf(e) }
    }
    await recount(ops, r)
    await putRoom(ops, r)
    return editTargets
  }

  async function dropAttachment(ops: ImCacheOps, e: ImEntryRecord) {
    if (!e.attachment) return
    await ops.deleteBlob(imBlobKey.object(e.attachment.objectId))
    if (e.attachment.thumbObjectId !== undefined)
      await ops.deleteBlob(imBlobKey.object(e.attachment.thumbObjectId))
  }

  async function removeOutbox(ops: ImCacheOps, o: ImOutboxRecord) {
    await ops.deleteOutbox(o.clientEntryId)
    if (o.file) await ops.deleteBlob(o.file.localRef)
  }

  /** 用 canonical 行覆盖本地已有的行（编辑/撤回结果、编辑事件的回查）。 */
  async function putCanonical(roomId: number, entries: readonly ImEntry[], onlyExisting: boolean) {
    await cache.tx(async (ops) => {
      const r = await ops.getRoom(roomId)
      if (!r) return
      for (const e of entries) {
        const old = await ops.getEntry(roomId, e.seq)
        if (!old && onlyExisting) continue
        if (old && e.recalledAt !== null) await dropAttachment(ops, old)
        await ops.putEntries([{ ...e, roomId }])
        if (r.detail?.preview?.seq === e.seq) r.detail = { ...r.detail, preview: previewOf(e) }
      }
      await recount(ops, r)
      await putRoom(ops, r)
    })
    emit({ type: 'entries', roomId })
  }

  async function refetchEdits(gen: number, roomId: number, seqs: number[]) {
    if (!seqs.length) return
    const res = await api.entries(roomId, { seqs: [...new Set(seqs)].slice(0, IM_LIMITS.idsMax) })
    check(gen)
    await putCanonical(roomId, res.items, true)
  }

  /** 拉最新一页并替换本地窗口（没有本地行，或缺口太大）。 */
  async function loadTail(gen: number, roomId: number) {
    const res = await api.entries(roomId, { limit: TAIL })
    check(gen)
    const edits = await cache.tx((ops) => applyPage(ops, roomId, res, 'tail'))
    check(gen)
    emit({ type: 'entries', roomId })
    emit({ type: 'rooms', roomIds: [roomId] })
    await refetchEdits(gen, roomId, edits)
  }

  /** 按 `afterSeq` 连拉最多 3 页；仍有更多就丢弃本地窗口改拉尾页（不保留缺口前未修正的旧行）。 */
  async function pullOnce(gen: number, roomId: number, r: ImRoomRecord) {
    if (r.windowHigh === 0) return loadTail(gen, roomId)
    let high = r.windowHigh
    for (let page = 0; page < AFTER_PAGES; page++) {
      const res = await api.entries(roomId, { afterSeq: high, limit: IM_LIMITS.entriesMax })
      check(gen)
      const edits = await cache.tx((ops) => applyPage(ops, roomId, res, 'after'))
      check(gen)
      emit({ type: 'entries', roomId })
      emit({ type: 'rooms', roomIds: [roomId] })
      await refetchEdits(gen, roomId, edits)
      if (!res.hasMore || !res.items.length) return
      high = res.items.reduce((m, e) => Math.max(m, e.seq), high)
    }
    await loadTail(gen, roomId)
  }

  /** 每会话单飞：拉取进行中再来的需求只抬高目标 seq，结束后还不够才再拉一次。 */
  function pull(roomId: number, want: number): Promise<void> {
    pullWant.set(roomId, Math.max(pullWant.get(roomId) ?? 0, want))
    const running_ = pulls.get(roomId)
    if (running_) return running_
    const gen = generation
    const p = (async () => {
      let lastHigh = -1
      for (;;) {
        const r = await cache.getRoom(roomId)
        check(gen)
        const target = pullWant.get(roomId) ?? 0
        if (!r || (r.windowHigh > 0 && target <= r.windowHigh) || r.windowHigh === lastHigh) break
        lastHigh = r.windowHigh
        try {
          await pullOnce(gen, roomId, r)
        } catch (e) {
          if (!(await gone(roomId, e))) throw e
          break
        }
      }
    })().finally(() => {
      pulls.delete(roomId)
      pullWant.delete(roomId)
    })
    pulls.set(roomId, p)
    return p
  }

  /** 会话已不存在或本人已不是成员（404 B5002）：删本地会话。返回是否按此处理了。 */
  async function gone(roomId: number, e: unknown): Promise<boolean> {
    if (e === STALE || statusOf(e) !== 404 || codeOf(e) !== 'B5002') return false
    open.delete(roomId)
    await cache.deleteRoom(roomId)
    emit({ type: 'rooms', roomIds: [roomId] })
    return true
  }

  async function openRoom(roomId: number) {
    open.add(roomId)
    if (!running()) return
    const gen = generation
    try {
      const r = await cache.getRoom(roomId)
      check(gen)
      // 本地窗口已到 lastSeq：零请求
      if (r && (r.windowHigh === 0 ? r.lastSeq > 0 : r.lastSeq > r.windowHigh))
        await pull(roomId, r.lastSeq)
    } catch (e) {
      handle(e)
    }
  }

  async function loadOlder(roomId: number): Promise<boolean> {
    if (!running()) return false
    const gen = generation
    const r = await cache.getRoom(roomId)
    check(gen)
    if (!r) return false
    if (r.windowHigh === 0) {
      if (r.lastSeq === 0) return false
      await loadTail(gen, roomId)
      const after_ = await cache.getRoom(roomId)
      return !!after_ && after_.windowLow > lowerBound(after_)
    }
    if (r.windowLow <= lowerBound(r)) return false
    let res: ImEntries
    try {
      res = await api.entries(roomId, { beforeSeq: r.windowLow, limit: TAIL })
    } catch (e) {
      if (await gone(roomId, e)) return false
      throw e
    }
    check(gen)
    const edits = await cache.tx((ops) => applyPage(ops, roomId, res, 'before'))
    check(gen)
    emit({ type: 'entries', roomId })
    await refetchEdits(gen, roomId, edits)
    return res.hasMore
  }

  // ---------- 发件箱 ----------

  async function findOutbox(ops: ImCacheOps, id: string, roomId?: number) {
    return (await ops.listOutbox(roomId)).find((o) => o.clientEntryId === id)
  }

  /** 改一条发件箱记录（已被丢弃或确认的不再复活）。 */
  async function updateOutbox(id: string, patch: Partial<ImOutboxRecord>) {
    const item = await cache.tx(async (ops) => {
      const cur = await findOutbox(ops, id)
      if (!cur) return undefined
      const next = { ...cur, ...patch }
      await ops.putOutbox(next)
      return next
    })
    if (item) emit({ type: 'outbox', roomId: item.roomId })
    return item
  }

  /** 发送成功：canonical 行、窗口上界与删除发件箱在同一事务。 */
  async function ack(item: ImOutboxRecord, entry: ImEntry): Promise<boolean> {
    let gap = false
    await cache.tx(async (ops) => {
      const cur = await findOutbox(ops, item.clientEntryId, item.roomId)
      if (cur) await removeOutbox(ops, cur)
      const r = await ops.getRoom(item.roomId)
      if (!r) return
      await ops.putEntries([{ ...entry, roomId: item.roomId }])
      if (r.windowHigh === 0 || entry.seq === r.windowHigh + 1) {
        if (r.windowHigh === 0) r.windowLow = entry.seq
        r.windowHigh = entry.seq
      } else if (entry.seq > r.windowHigh + 1) gap = true
      r.lastSeq = Math.max(r.lastSeq, entry.seq)
      r.lastAt = laterAt(r.lastAt, entry.createdAt)
      if (r.detail && entry.seq >= (r.detail.preview?.seq ?? 0))
        r.detail = { ...r.detail, preview: previewOf(entry) }
      await recount(ops, r)
      await putRoom(ops, r)
    })
    emit({ type: 'outbox', roomId: item.roomId })
    emit({ type: 'entries', roomId: item.roomId })
    emit({ type: 'rooms', roomIds: [item.roomId] })
    return gap
  }

  /**
   * 投递一条：文件先上传并把 objectId 写回（重试不重复上传）→ 同一 clientEntryId 发送。返回 false 表示
   * 暂时失败（退避中），同一会话后面的消息等它。
   */
  async function deliver(gen: number, item: ImOutboxRecord): Promise<boolean> {
    try {
      let objectId = item.objectId
      if (item.file && objectId === undefined) {
        const up = await api.upload(item.roomId, item.file, item.kind)
        check(gen)
        objectId = up.objectId
        if (!(await updateOutbox(item.clientEntryId, { objectId }))) return true
      }
      const body: ImEntrySend = { clientEntryId: item.clientEntryId, kind: item.kind }
      if (item.kind === 'text') body.text = item.text
      else if (item.kind === 'sticker') {
        if (item.stickerCode !== undefined) body.stickerCode = item.stickerCode
        else body.stickerId = item.stickerId
      } else body.objectId = objectId
      const entry = await api.send(item.roomId, body)
      check(gen)
      if ((await ack(item, entry)) && open.has(item.roomId)) quiet(pull(item.roomId, entry.seq))
      return true
    } catch (e) {
      if (e === STALE) throw e
      const s = statusOf(e)
      if (s === 401) {
        lock()
        throw STALE
      }
      if (transient(s)) {
        const attempts = item.attempts + 1
        await updateOutbox(item.clientEntryId, {
          attempts,
          nextAttemptAt: now() + Math.min(BACKOFF_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS),
        })
        return false
      }
      // 已不是成员：删本地会话（连同它的发件箱）
      if (await gone(item.roomId, e)) return true
      // 400/403/409/413/422 等：停止，由用户重发或丢弃
      await updateOutbox(item.clientEntryId, {
        state: 'failed',
        failure: String(codeOf(e) ?? s),
      })
      return true
    }
  }

  async function flushOnce(gen: number) {
    const items = await cache.listOutbox()
    check(gen)
    let next = Infinity
    const waiting = new Set<number>()
    for (const item of items) {
      if (item.state !== 'pending' || waiting.has(item.roomId)) continue
      if (now() - item.createdAt > DAY_MS) {
        // 24 小时还没成功：标失败，用户重发即新消息
        await updateOutbox(item.clientEntryId, { state: 'failed', failure: 'expired' })
        continue
      }
      if (item.nextAttemptAt > now()) {
        waiting.add(item.roomId)
        next = Math.min(next, item.nextAttemptAt)
        continue
      }
      if (!running()) return
      if (!(await deliver(gen, item))) {
        waiting.add(item.roomId)
        const cur = (await cache.listOutbox(item.roomId)).find(
          (o) => o.clientEntryId === item.clientEntryId,
        )
        if (cur) next = Math.min(next, cur.nextAttemptAt)
      }
      check(gen)
    }
    if (next < Infinity) after('outbox', next - now(), () => quiet(flush()))
  }

  /** 发件箱单飞：只在主标签页（App 恒为主）发送。 */
  function flush(): Promise<void> {
    if (!running() || !isLeader()) return Promise.resolve()
    if (flushing) {
      flushAgain = true
      return flushing
    }
    const gen = generation
    flushing = (async () => {
      do {
        flushAgain = false
        await flushOnce(gen)
      } while (flushAgain && gen === generation)
    })()
      .catch(handle)
      .finally(() => {
        if (gen === generation) flushing = null
      })
    return flushing
  }

  async function send(roomId: number, draft: ImDraft): Promise<string> {
    const at = now()
    const item: ImOutboxRecord = {
      clientEntryId: newId(),
      roomId,
      kind: draft.kind,
      state: 'pending',
      attempts: 0,
      createdAt: at,
      nextAttemptAt: at,
    }
    if (draft.kind === 'text') item.text = draft.text
    else if (draft.kind === 'sticker') {
      if ('stickerCode' in draft) item.stickerCode = draft.stickerCode
      else item.stickerId = draft.stickerId
    } else item.file = draft.file
    await cache.putOutbox(item)
    emit({ type: 'outbox', roomId })
    quiet(flush())
    return item.clientEntryId
  }

  async function retry(clientEntryId: string) {
    const fresh = await cache.tx(async (ops) => {
      const cur = await findOutbox(ops, clientEntryId)
      if (!cur) return undefined
      const at = now()
      if (at - cur.createdAt > DAY_MS) {
        // 过期的重发是一条新消息：新 clientEntryId，文件重新上传（旧对象已被回收）
        await ops.deleteOutbox(cur.clientEntryId)
        const next: ImOutboxRecord = {
          ...cur,
          clientEntryId: newId(),
          objectId: undefined,
          state: 'pending',
          failure: undefined,
          attempts: 0,
          createdAt: at,
          nextAttemptAt: at,
        }
        await ops.putOutbox(next)
        return next
      }
      const next: ImOutboxRecord = {
        ...cur,
        state: 'pending',
        failure: undefined,
        attempts: 0,
        nextAttemptAt: at,
      }
      await ops.putOutbox(next)
      return next
    })
    if (!fresh) return
    emit({ type: 'outbox', roomId: fresh.roomId })
    quiet(flush())
  }

  async function discard(clientEntryId: string) {
    const roomId = await cache.tx(async (ops) => {
      const cur = await findOutbox(ops, clientEntryId)
      if (cur) await removeOutbox(ops, cur)
      return cur?.roomId
    })
    if (roomId !== undefined) emit({ type: 'outbox', roomId })
  }

  async function edit(roomId: number, seq: number, text: string, rev: number) {
    const gen = generation
    try {
      const e = await api.edit(roomId, seq, { text, rev })
      check(gen)
      await putCanonical(roomId, [e], false)
    } catch (e) {
      // rev 已变：回查这一行，界面显示最新内容
      if (e !== STALE && codeOf(e) === 'B5009') await refetchEdits(gen, roomId, [seq]).catch(handle)
      throw e
    }
  }

  async function recall(roomId: number, seq: number) {
    const gen = generation
    const e = await api.recall(roomId, seq)
    check(gen)
    await putCanonical(roomId, [e], false)
  }

  // ---------- 已读 ----------

  async function reportRead(roomId: number) {
    const want = readWant.get(roomId)
    readWant.delete(roomId)
    if (want === undefined || !running()) return
    const gen = generation
    const r = await cache.getRoom(roomId)
    check(gen)
    if (!r || want <= r.readSeq) return
    const res = await api.read(roomId, want)
    check(gen)
    await cache.tx(async (ops) => {
      const cur = await ops.getRoom(roomId)
      if (!cur || res.readSeq <= cur.readSeq) return
      cur.readSeq = res.readSeq
      await recount(ops, cur)
      await putRoom(ops, cur)
    })
    emit({ type: 'rooms', roomIds: [roomId] })
  }

  function markRead(roomId: number, seq: number) {
    if (!running()) return
    readWant.set(roomId, Math.max(readWant.get(roomId) ?? 0, seq))
    if (timers.has(`read:${roomId}`)) return
    after(`read:${roomId}`, READ_MS, () => quiet(reportRead(roomId)))
  }

  // ---------- 通讯录与表情 ----------

  function loadDirectory(): Promise<boolean> {
    if (!running()) return Promise.resolve(false)
    const gen = generation
    directoryLoad ??= (async () => {
      const snap = await cache.getDirectory()
      check(gen)
      const res = await api.directory(snap?.etag ?? null)
      check(gen)
      if (res.status === 200)
        await cache.putDirectory({ etag: res.etag, data: res.data, fetchedAt: now() })
      else if (snap) await cache.putDirectory({ ...snap, fetchedAt: now() })
      emit({ type: 'directory' })
      return true
    })()
      .catch((e: unknown) => {
        handle(e)
        return false
      })
      .finally(() => (directoryLoad = null))
    return directoryLoad
  }

  function loadStickers(): Promise<boolean> {
    if (!running()) return Promise.resolve(false)
    const gen = generation
    stickersLoad ??= (async () => {
      const snap = await cache.getStickers()
      check(gen)
      const res = await api.stickers(snap?.etag ?? null)
      check(gen)
      if (res.status === 200)
        await cache.putStickers({ etag: res.etag, data: res.data, fetchedAt: now() })
      else if (snap) await cache.putStickers({ ...snap, fetchedAt: now() })
      emit({ type: 'stickers' })
      return true
    })()
      .catch((e: unknown) => {
        handle(e)
        return false
      })
      .finally(() => (stickersLoad = null))
    return stickersLoad
  }

  // ---------- 锁定与清除 ----------

  function lock() {
    if (disposed || state === 'locked') return
    stopTimers()
    setState('locked')
  }

  async function unlock() {
    if (disposed || state !== 'locked') return
    setState('idle')
    await start()
  }

  /** 清除：代际 +1（在途响应作废）→ 关连接并删库 → 通知界面。之后这个引擎与缓存都不再使用。 */
  async function clear() {
    generation++
    stopTimers()
    open.clear()
    applied.clear()
    pullWant.clear()
    readWant.clear()
    detailQueue.clear()
    syncing = flushing = directoryLoad = stickersLoad = null
    pulls.clear()
    disposed = true
    state = 'idle'
    try {
      await cache.destroy()
    } finally {
      emit({ type: 'cleared' })
    }
  }

  return {
    get state() {
      return state
    },
    get generation() {
      return generation
    },
    get options() {
      return opts
    },
    start,
    fullSync: (reason) => fullSync(reason),
    onEntryHint,
    onRoomHint,
    openRoom,
    closeRoom: (roomId) => void open.delete(roomId),
    loadOlder,
    send,
    retry,
    discard,
    edit,
    recall,
    markRead,
    loadDirectory,
    loadStickers,
    totalUnread: async () =>
      (await cache.listRooms()).reduce((n, r) => n + Math.min(r.unread, IM_LIMITS.unreadCap), 0),
    lock,
    unlock,
    clear,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    dispose: () => {
      disposed = true
      stopTimers()
      listeners.clear()
    },
    setVisibleRooms: (ids) => (visible = new Set(ids)),
    applyDetail: async (detail) => {
      const mySeq = ++reqSeq
      await cache.tx(async (ops) => {
        if ((applied.get(detail.roomId) ?? 0) > mySeq) return
        await mergeDetail(ops, await ops.getRoom(detail.roomId), detail)
        applied.set(detail.roomId, mySeq)
      })
      emit({ type: 'rooms', roomIds: [detail.roomId] })
    },
    forgetRoom: async (roomId) => {
      open.delete(roomId)
      await cache.deleteRoom(roomId)
      emit({ type: 'rooms', roomIds: [roomId] })
    },
  }
}
