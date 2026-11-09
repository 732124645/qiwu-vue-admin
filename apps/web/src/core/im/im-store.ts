import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { useDocumentVisibility, useEventListener, useIntervalFn } from '@vueuse/core'
import { ElMessage } from 'element-plus'
import {
  IM_LIMITS,
  RT,
  type ImDirectory,
  type ImOptions,
  type ImRoomDetail,
  type ImSticker,
  type MePayload,
} from '@qiwu/shared'
import {
  createImEngine,
  createMemoryCache,
  deleteDb,
  deleteOtherIdbCaches,
  electLeader,
  getCachedBlob,
  imCacheName,
  imHomeTenantId,
  openIdbCache,
  putCachedBlob,
  type ImApi,
  type ImCache,
  type ImChange,
  type ImEngine,
  type ImDraft,
  type ImEngineState,
  type ImOutboxFile,
  type ImRoomRecord,
} from '@qiwu/shared/im-client'
import { imApi } from '@/api/platform/im'
import { i18n } from '@/core/i18n'
import { onRealtime, realtimeUp } from '@/core/realtime/socket'
import { useAuthStore } from '@/core/stores/auth'

/** 标签页之间的消息（同一账号命名空间）。 */
type PeerMessage =
  | { type: 'wipe'; name: string }
  | { type: 'reset'; name: string }
  | { type: 'rooms'; name: string }
  | { type: 'entries'; name: string; roomId: number }
  | { type: 'directory'; name: string }
  | { type: 'stickers'; name: string }
  | { type: 'outbox'; name: string; roomId: number; id?: string }

const CHANNEL = 'qw-im'
const POLL_MS = 60_000

/** 已启动的聊天 store 的清除函数；没启动过（本标签页没进过带顶栏的页面）时为 null。 */
let activeWipe: (() => Promise<void>) | null = null

/**
 * 主动退出时清除本账号的聊天缓存（auth store 的 logout 调用）：store 在运行就由它清；否则直接按命名空间
 * 删库并通知其它标签页——不为此启动 store（不发探测请求）。
 */
export async function wipeImCache(me: MePayload | null): Promise<void> {
  if (activeWipe) return activeWipe()
  if (!me) return
  const n = await imCacheName(location.origin, imHomeTenantId(me.tenant), me.user.id)
  await deleteDb(n).catch(() => undefined)
  announceWipe(n)
}

/** 告诉其它标签页：这个命名空间已清除。 */
function announceWipe(n: string) {
  if (typeof BroadcastChannel === 'undefined') return
  const once = new BroadcastChannel(CHANNEL)
  once.postMessage({ type: 'wipe', name: n } satisfies PeerMessage)
  once.close()
}

/** 会话排序：最近活动在前，没有活动的排后，同时间按编号倒序。 */
const byActivity = (a: ImRoomRecord, b: ImRoomRecord) =>
  (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || b.roomId - a.roomId

/**
 * 员工聊天的本地优先客户端（see docs/im.md）：每个账号一个 IndexedDB 命名空间，接共享引擎、多标签页
 * 选主、实时提示、回到前台与断线轮询。登录后（`/me` 就绪）才启动；`/me` 消失（重新登录、会话过期）只
 * 停下不删；主动退出与被踢才清库（`wipe`），并经 BroadcastChannel 让其它标签页一起放手。
 */
export const useImStore = defineStore('im', () => {
  const auth = useAuthStore()
  const state = ref<ImEngineState>('idle')
  const options = shallowRef<ImOptions | null>(null)
  /** 本账号本地已有缓存（断网/5xx 时据此仍显示入口） */
  const hadCache = ref(false)
  const rooms = shallowRef<ImRoomRecord[]>([])
  /** 各会话本地消息/发件箱的变化计数：界面据此从缓存重读 */
  const entryRev = reactive(new Map<number, number>())
  const directory = shallowRef<ImDirectory | null>(null)
  const stickers = shallowRef<ImSticker[]>([])
  /** 上传进度（发件箱文件的本地引用 → 0–1） */
  const progress = reactive(new Map<string, number>())
  const leaderRef = ref(false)

  let engine: ImEngine | null = null
  let cache: ImCache | null = null
  let name: string | null = null
  let lastName: string | null = null
  let leader = false
  let releaseLeader: (() => void) | null = null
  let channel: BroadcastChannel | null = null
  let bootSeq = 0
  let roomsSeq = 0
  let wiping = false
  let quotaWarned = false
  let droppedSinceBoot = false
  const urls = new Map<string, string>()
  const loadingUrls = new Map<string, Promise<string>>()

  /** 入口是否显示：探测成功；或断网/5xx 时本地已有这个账号的缓存。锁定、停用都不显示。 */
  const enabled = computed(() => {
    if (state.value === 'ready' || state.value === 'syncing') return true
    if (state.value === 'offline') return !!options.value || hadCache.value
    return false
  })
  const unread = computed(() =>
    rooms.value.reduce((n, r) => n + Math.min(r.unread, IM_LIMITS.unreadCap), 0),
  )

  const post = (msg: PeerMessage) => {
    try {
      channel?.postMessage(msg)
    } catch {
      // 通道已关闭
    }
  }

  async function refreshRooms() {
    const mine = ++roomsSeq
    const c = cache
    if (!c || state.value === 'locked') {
      rooms.value = []
      return
    }
    try {
      const list = await c.listRooms()
      if (mine === roomsSeq && c === cache) rooms.value = list.sort(byActivity)
    } catch {
      // 库已被别的标签页删除：等清除通知
    }
  }
  const bump = (roomId: number) => entryRev.set(roomId, (entryRev.get(roomId) ?? 0) + 1)

  async function reloadSnapshots(which: 'directory' | 'stickers' | 'both' = 'both') {
    const c = cache
    if (!c) return
    if (which !== 'stickers') directory.value = (await c.getDirectory())?.data ?? null
    if (which !== 'directory') stickers.value = (await c.getStickers())?.data ?? []
  }

  /** 引擎的变化：重读缓存；主标签页再转告其它标签页。 */
  function onChange(change: ImChange) {
    const n = name
    if (!n) return
    switch (change.type) {
      case 'state':
        state.value = change.state
        options.value = engine?.options ?? options.value
        void refreshRooms()
        return
      case 'rooms':
        void refreshRooms()
        return post({ type: 'rooms', name: n })
      case 'entries':
      case 'outbox':
        bump(change.roomId)
        return post({ type: 'entries', name: n, roomId: change.roomId })
      case 'directory':
      case 'stickers':
        void reloadSnapshots(change.type)
        return post({ type: change.type, name: n })
      case 'cleared':
        // epoch 或结构版本变了：引擎已删库，同一账号重新建；其它标签页的连接随删库关闭，通知它们一起重开
        if (wiping) return
        post({ type: 'reset', name: n })
        if (auth.me) void boot(auth.me)
    }
  }

  /** 别的标签页的消息。 */
  function onPeer(ev: MessageEvent<PeerMessage>) {
    const msg = ev.data
    if (!msg || msg.name !== name) return
    if (msg.type === 'wipe') {
      // 连接关闭时先保留通知通道；确认是退出后退役，并确保这个命名空间已删除
      shutdown()
      return void deleteDb(msg.name).catch(() => undefined)
    }
    if (msg.type === 'reset') {
      shutdown()
      if (auth.me) void boot(auth.me)
      return
    }
    if (msg.type === 'rooms') return void refreshRooms()
    if (msg.type === 'directory' || msg.type === 'stickers') return void reloadSnapshots(msg.type)
    bump(msg.roomId)
    // 其它标签页写进发件箱的消息由主标签页发送
    if (msg.type === 'outbox' && msg.id && leader) void engine?.retry(msg.id)
  }

  /** 宿主的接口端口：文件按本地引用从缓存取 Blob 上传，并报进度。 */
  function engineApi(): ImApi {
    return {
      options: imApi.options,
      sync: imApi.sync,
      syncDetails: imApi.syncDetails,
      entries: imApi.entries,
      send: imApi.send,
      edit: imApi.edit,
      recall: imApi.recall,
      read: imApi.read,
      directory: imApi.directory,
      stickers: imApi.stickers,
      upload: async (roomId: number, file: ImOutboxFile, kind) => {
        const body =
          file.body instanceof Blob ? file.body : (await cache?.getBlob(file.localRef))?.body
        // 本地文件已不在（换浏览器存储、被清理）：按 400 处理，标失败由用户重新选择
        if (!(body instanceof Blob))
          throw Object.assign(new Error('local file missing'), { status: 400, code: 'local' })
        try {
          return await imApi.upload(
            roomId,
            body,
            file.name,
            (r) => progress.set(file.localRef, r),
            kind,
          )
        } finally {
          progress.delete(file.localRef)
        }
      },
    }
  }

  /** 停下（不删数据）：退出选主、关通道与连接、清界面状态。 */
  function shutdown() {
    bootSeq++
    releaseLeader?.()
    releaseLeader = null
    leader = leaderRef.value = false
    channel?.close()
    channel = null
    engine?.dispose()
    engine = null
    void cache?.close().catch(() => undefined)
    cache = null
    name = null
    for (const url of urls.values()) URL.revokeObjectURL(url)
    urls.clear()
    loadingUrls.clear()
    progress.clear()
    entryRev.clear()
    state.value = 'idle'
    options.value = null
    hadCache.value = false
    rooms.value = []
    directory.value = null
    stickers.value = []
  }

  /** 为当前账号启动：删别的账号的库（换账号）、开本账号的库（不可用或配额不足时用内存）、选主、探测与同步。 */
  async function boot(me: MePayload) {
    shutdown()
    const mine = bootSeq
    const n = await imCacheName(location.origin, imHomeTenantId(me.tenant), me.user.id)
    if (mine !== bootSeq) return
    lastName = n
    await deleteOtherIdbCaches(n).catch(() => undefined)
    let c: ImCache
    try {
      c = await openIdbCache(n, {
        onQuota: () => {
          if (quotaWarned) return
          quotaWarned = true
          ElMessage.warning(i18n.global.t('im.quota'))
        },
        // 关库可能来自退出：先锁定并保留通知通道，等明确的 reset/wipe，避免提前重建后漏掉清除通知
        onClosed: () => {
          if (cache === c && !wiping) engine?.lock()
        },
      })
    } catch {
      c = createMemoryCache(n)
    }
    if (mine !== bootSeq) return void c.close().catch(() => undefined)
    cache = c
    name = n
    droppedSinceBoot = false
    hadCache.value = !!(await c.getMeta('epoch').catch(() => undefined))
    const e = createImEngine({
      api: engineApi(),
      cache: c,
      userId: me.user.id,
      isLeader: () => leader,
    })
    engine = e
    e.subscribe(onChange)
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(CHANNEL)
      channel.onmessage = onPeer
    }
    let started = false
    let syncedAtStart = false
    const off = e.subscribe((ch) => {
      if (ch.type === 'state' && ch.state === 'syncing') syncedAtStart = true
    })
    releaseLeader = electLeader(`qw-im:${n}`, (l) => {
      leader = leaderRef.value = l
      // 前一个主标签页关了（或锁在启动之后才拿到）：接手同步与发件箱
      if (l && started && engine === e) void takeOver(e, c, 'foreground')
    })
    await reloadSnapshots()
    await e.start()
    started = true
    off()
    if (leader && !syncedAtStart && engine === e && e.state === 'ready')
      void takeOver(e, c, 'cold-start')
  }

  async function takeOver(e: ImEngine, c: ImCache, reason: 'cold-start' | 'foreground') {
    await e.fullSync(reason)
    for (const o of await c.listOutbox().catch(() => []))
      if (o.state === 'pending') void e.retry(o.clientEntryId)
  }

  /** 主动退出、被踢：清除本账号的库（引擎不在时按库名删），并通知其它标签页。 */
  async function wipe() {
    const me = auth.me
    const n =
      name ??
      lastName ??
      (me ? await imCacheName(location.origin, imHomeTenantId(me.tenant), me.user.id) : null)
    const e = engine
    wiping = true
    try {
      if (e && name === n) await e.clear()
      else if (n) {
        shutdown()
        await deleteDb(n)
      }
    } catch {
      // 删除失败：下次登录时按命名空间再删
    } finally {
      wiping = false
    }
    if (n) {
      if (channel) post({ type: 'wipe', name: n })
      else announceWipe(n)
    }
    shutdown()
    lastName = null
  }
  activeWipe = wipe

  // 账号变化：同一账号（含重新登录）复用缓存；`/me` 消失只停下
  watch(
    () => auth.me && `${imHomeTenantId(auth.me.tenant)}:${auth.me.user.id}`,
    (key) => {
      if (key && auth.me) void boot(auth.me)
      else shutdown()
    },
    { immediate: true },
  )

  onRealtime(RT.imEntry, (h) => engine?.onEntryHint(h))
  onRealtime(RT.imRoom, (h) => engine?.onRoomHint(h))
  onRealtime(RT.sessionKicked, () => void wipe())
  // 只有启动后真的断过线，重连才全量同步（首次连上不算）
  watch(realtimeUp, (up) => {
    if (!engine) return
    if (!up) droppedSinceBoot = true
    else if (droppedSinceBoot) {
      droppedSinceBoot = false
      void engine.fullSync('reconnect')
    }
  })
  const visibility = useDocumentVisibility()
  useEventListener(document, 'visibilitychange', () => {
    if (visibility.value === 'visible') void engine?.fullSync('foreground')
  })
  useIntervalFn(() => {
    if (!realtimeUp.value && visibility.value === 'visible') void engine?.fullSync('poll')
  }, POLL_MS)

  // ---------- 界面用 ----------

  /** 聊天页打开：通讯录与我的表情第一次才取，之后带 ETag 复验；列表里的会话都算可见。 */
  let chatOpen = false
  function enterChat() {
    chatOpen = true
    void engine?.loadDirectory()
    void engine?.loadStickers()
    engine?.setVisibleRooms(rooms.value.map((r) => r.roomId))
  }
  function leaveChat() {
    chatOpen = false
    engine?.setVisibleRooms([])
  }
  // 只有聊天页开着时列表才算可见；在别的页面，提示只改本地未读，不发请求
  watch(rooms, (list) => {
    if (engine && chatOpen) engine.setVisibleRooms(list.map((r) => r.roomId))
  })

  /** 发送；非主标签页写进发件箱后请主标签页发送。 */
  async function send(roomId: number, draft: ImDraft) {
    if (!engine || !name) return
    const id = await engine.send(roomId, draft)
    if (!leader) post({ type: 'outbox', name, roomId, id })
  }

  /** 选中的文件先存进本地（发件箱引用），再排队发送。 */
  async function sendFile(roomId: number, file: File, kind: 'image' | 'file') {
    const c = cache
    if (!c) return
    const localRef = `u:${crypto.randomUUID()}`
    await c.putBlob({ key: localRef, size: file.size, usedAt: Date.now(), roomId, body: file })
    await send(roomId, {
      kind,
      file: { name: file.name, size: file.size, mime: file.type, localRef },
    })
  }

  /**
   * 授权附件的对象 URL：先查内存，再查本地附件缓存（LRU），都没有才下载并存入缓存。同一个键只下载一次。
   */
  function blobUrl(
    key: string,
    roomId: number | null,
    fetch: () => Promise<Blob>,
  ): Promise<string> {
    const hit = urls.get(key)
    if (hit) return Promise.resolve(hit)
    const pending = loadingUrls.get(key)
    if (pending) return pending
    const c = cache
    const p = (async () => {
      let blob = c ? (await getCachedBlob(c, key).catch(() => undefined))?.body : undefined
      if (!(blob instanceof Blob)) {
        blob = await fetch()
        if (c)
          await putCachedBlob(c, {
            key,
            size: (blob as Blob).size,
            usedAt: Date.now(),
            roomId,
            body: blob,
          }).catch(() => undefined)
      }
      const url = URL.createObjectURL(blob as Blob)
      if (c !== cache) {
        URL.revokeObjectURL(url)
        throw Object.assign(new Error('session changed'), { status: 401 })
      }
      urls.set(key, url)
      return url
    })().finally(() => loadingUrls.delete(key))
    loadingUrls.set(key, p)
    return p
  }

  /** 建私聊/建群与群管理的返回详情直接写进本地。 */
  async function applyDetail(detail: ImRoomDetail) {
    await engine?.applyDetail(detail)
  }

  return {
    state,
    options,
    enabled,
    unread,
    rooms,
    entryRev,
    directory,
    stickers,
    progress,
    leader: leaderRef,
    cache: () => cache,
    engine: () => engine,
    enterChat,
    leaveChat,
    send,
    sendFile,
    sendVoice: (roomId: number, file: ImOutboxFile) => send(roomId, { kind: 'voice', file }),
    blobUrl,
    applyDetail,
    wipe,
  }
})
