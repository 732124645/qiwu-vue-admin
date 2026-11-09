// 移动端聊天客户端：把共同引擎（`@qiwu/shared/im-client`）接到本应用 —— 接口端口（./api）、按平台的缓存
// （App：SQLite；H5：共同的 IndexedDB 实现 + 选主）、实时提示、前后台与登录生命周期（see docs/im.md）。
// 清除与锁定：主动退出、被踢、换账号才删本地数据；会话过期（refresh 被拒）只锁定 —— 停止同步、不渲染，
// 同一账号重新登录直接复用。小程序不进聊天（入口隐藏、引擎不加载）。
import { computed, ref, shallowRef, watch } from 'vue'
import type { ImEntryHint, ImOptions, ImRoomHint } from '@qiwu/shared'
// #ifndef MP-WEIXIN
import {
  createImEngine,
  deleteDb,
  deleteOtherIdbCaches,
  electLeader,
  imCacheName,
  imHomeTenantId,
  openIdbCache,
  type ImCache,
  type ImChange,
  type ImEngine,
  type ImEngineState,
  type ImSyncReason,
} from '@qiwu/shared/im-client'
import { imApi } from './api'
import { releaseBlobUrls } from './blob-app'
import { sweepOutboxCopies } from './file-pick'
// #endif
// #ifdef APP-PLUS
import { deleteOtherSqliteCaches, openSqliteCache, removeLocalFile } from './cache-sqlite'
// #endif
import { t } from '../i18n'
import { ORIGIN, currentSessionVersion, hasSession, sessionVersion } from '../request'
import { useAuthStore } from '../stores/auth'

/** 本端是否有聊天（微信小程序不含聊天）。 */
export const IM_PLATFORM = process.env.UNI_PLATFORM !== 'mp-weixin'
/** 是否 App（构建时替换成常量；规格里可按用例切换） */
const isApp = () => process.env.UNI_PLATFORM === 'app'

/** 引擎状态（界面据此显示入口与锁定/离线提示）。 */
export const imState = ref<ImEngineState>('idle')
/** 各会话未读合计（消息 tab 角标的一部分）。 */
export const imUnread = ref(0)
/** 本地缓存里的会话数（断网时有缓存才显示入口）。 */
export const imRoomCount = ref(0)
/** 最近一次 `/options`（限额、文件白名单）；探测成功前为 null。 */
export const imOptions = shallowRef<ImOptions | null>(null)
/** H5 通话复用聊天的 Web Lock 主标签页，不另建抢占协议。 */
export const imLeader = ref(false)

/**
 * 是否显示聊天入口：探测 200（同步中/就绪），或断网/5xx 时本地有该账号的缓存；探测 404/403（开关关、
 * 套餐不含、非员工）与锁定时隐藏。
 */
export const imChatVisible = computed(
  () =>
    IM_PLATFORM &&
    (imState.value === 'ready' ||
      imState.value === 'syncing' ||
      (imState.value === 'offline' && imRoomCount.value > 0)),
)

interface Ctx {
  name: string
  engine: ImEngine
  cache: ImCache
  closed: boolean
  leader: boolean
  channel: BroadcastChannel | null
  stop: () => void
}

/** 与桌面端共用的同账号标签页通知；正文始终只从本地缓存读取。 */
type PeerMessage =
  | { type: 'wipe'; name: string }
  | { type: 'reset'; name: string }
  | { type: 'rooms'; name: string }
  | { type: 'directory'; name: string }
  | { type: 'stickers'; name: string }
  | { type: 'entries'; name: string; roomId: number }
  | { type: 'outbox'; name: string; roomId: number; id?: string }

let current: Ctx | null = null
let opening: Promise<Ctx | null> | null = null
/** 每次清除/换账号 +1：进行中的打开在完成时发现代际变了就自行丢弃 */
let generation = 0
/** 其它标签页退出后，旧会话的页面事件不能再次建库；真正重新登录会递增会话版本。 */
let retiredSession: number | null = null
/** 应用在后台：断线兜底的轮询不跑 */
let hidden = false
const listeners = new Set<(change: ImChange) => void>()

/** 当前账号的引擎与缓存（未启动、锁定或小程序为 null）。 */
export const imCurrent = () => (current && imState.value !== 'locked' ? current : null)

/** 订阅引擎变化（页面从缓存重读）；返回取消函数。 */
export function onImChange(fn: (change: ImChange) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 按平台打开缓存与删除别的命名空间。 */
const host = {
  open: (name: string, gen: number): Promise<ImCache> =>
    isApp()
      ? openSqliteCache(name)
      : openIdbCache(name, { onQuota: quotaNotice, onClosed: () => lockAfterOutsideClose(name, gen) }),
  deleteOthers: (keep: string | null): Promise<void> =>
    isApp() ? deleteOtherSqliteCaches(keep) : deleteOtherIdbCaches(keep),
}

/** H5 浏览器存储不足：本次改用临时缓存，提示一次。 */
let quotaWarned = false
function quotaNotice() {
  if (quotaWarned) return
  quotaWarned = true
  uni.showToast({ title: t('im.quota'), icon: 'none' })
}

/**
 * 外部关闭并不能说明是重置还是退出：保留通知通道并先锁定，只有明确的 reset 才能重新建库。
 */
function lockAfterOutsideClose(name: string, gen: number) {
  const ctx = current
  if (!ctx || ctx.name !== name || gen !== generation) return
  ctx.closed = true
  ctx.engine.lock()
  imUnread.value = 0
  imRoomCount.value = 0
  imState.value = 'locked'
  notify({ type: 'state', state: 'locked' })
}

/** 同源标签页只传缓存变更与生命周期，不重发网络同步。 */
function post(ctx: Ctx, message: PeerMessage) {
  try {
    ctx.channel?.postMessage(message)
  } catch {
    // 退出时可能已关闭通道
  }
}

function notify(change: ImChange) {
  for (const fn of listeners) fn(change)
}

/** 明确的退出不会重建缓存；重置才按当前账号重新冷启动。 */
function onPeer(ctx: Ctx, message: PeerMessage) {
  if (ctx !== current || !message || message.name !== ctx.name) return
  if (message.type === 'wipe' || message.type === 'reset') {
    imSessionStart()
    releaseBlobUrls()
    if (message.type === 'wipe') {
      retiredSession = currentSessionVersion()
      void deleteDb(ctx.name).catch(() => {})
      notify({ type: 'cleared' })
    } else void imStart()
    return
  }
  if (ctx.closed) return
  void refreshCounts(ctx)
  if (message.type === 'rooms') notify({ type: 'rooms', roomIds: [] })
  else if (message.type === 'directory' || message.type === 'stickers')
    notify({ type: message.type })
  else {
    notify({ type: message.type, roomId: message.roomId })
    if (message.type === 'outbox' && message.id && ctx.leader)
      void ctx.engine.retry(message.id).catch(() => {})
  }
}

/** 服务源：同一账号在不同服务器的数据互不相混。 */
const source = () => ORIGIN || (typeof location === 'undefined' ? '' : location.origin)

async function refreshCounts(ctx: Ctx) {
  try {
    const [unread, rooms] = await Promise.all([ctx.engine.totalUnread(), ctx.cache.listRooms()])
    if (ctx !== current || ctx.closed) return
    imUnread.value = unread
    imRoomCount.value = rooms.length
  } catch {
    // 缓存不可读时保持上次的数
  }
}

function dispose(ctx: Ctx) {
  ctx.stop()
  ctx.engine.dispose()
  void ctx.cache.close().catch(() => {})
}

/** 为当前登录账号打开（或复用）引擎；换了账号删除别的命名空间。 */
async function open(): Promise<Ctx | null> {
  const gen = generation
  const session = currentSessionVersion()
  const auth = useAuthStore()
  if (!auth.me) await auth.fetchMe()
  const me = auth.me
  if (!me || gen !== generation || session !== currentSessionVersion() || !hasSession()) return null
  const name = await imCacheName(source(), imHomeTenantId(me.tenant), me.user.id)
  if (gen !== generation || session !== currentSessionVersion()) return null
  if (current?.name === name) return current
  if (current) {
    dispose(current)
    current = null
  }
  // 换账号：别的命名空间（上一个账号的库与附件）一律删除，当前账号的保留复用
  await host.deleteOthers(name)
  if (gen !== generation || session !== currentSessionVersion()) return null
  const cache = await host.open(name, gen)
  if (gen !== generation || session !== currentSessionVersion()) {
    await cache.close()
    return null
  }
  // 引擎取 `/options` 时顺便记下限额与白名单（不另发请求）
  const api = {
    ...imApi,
    options: () =>
      imApi.options().then((o) => {
        if (gen === generation) imOptions.value = o
        return o
      }),
  }
  const engine = createImEngine({ api, cache, userId: me.user.id, isLeader: () => ctx.leader })
  const ctx: Ctx = {
    name,
    engine,
    cache,
    closed: false,
    leader: isApp(),
    channel: !isApp() && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('qw-im') : null,
    stop: () => {},
  }
  if (ctx.channel) ctx.channel.onmessage = (event: MessageEvent<PeerMessage>) => onPeer(ctx, event.data)
  const unsubscribe = engine.subscribe((change) => onChange(ctx, change))
  // H5 多标签页：只有主标签页同步与发送；成为主标签页时补一次全量同步
  const releaseLeader = isApp()
    ? () => {}
    : electLeader(`qw-im:${name}`, (on) => {
        ctx.leader = on
        if (ctx === current) imLeader.value = on
        if (on && ctx === current && !ctx.closed) {
          void engine.fullSync('foreground').catch(() => {})
          void cache.listOutbox().then((items) => {
            if (ctx !== current || ctx.closed) return
            for (const item of items)
              if (item.state === 'pending') void engine.retry(item.clientEntryId).catch(() => {})
          }, () => {})
        }
      })
  ctx.stop = () => {
    unsubscribe()
    releaseLeader()
    ctx.channel?.close()
  }
  current = ctx
  imLeader.value = ctx.leader
  imState.value = engine.state
  return ctx
}

function onChange(ctx: Ctx, change: ImChange) {
  if (ctx !== current || ctx.closed) return
  if (change.type === 'state') imState.value = change.state
  if (change.type === 'cleared') {
    post(ctx, { type: 'reset', name: ctx.name })
    imSessionStart()
    void imStart()
  } else if (change.type === 'rooms' || change.type === 'entries' || change.type === 'state')
    void refreshCounts(ctx)
  else if (change.type === 'outbox' && isApp())
    // 发送成功后发件箱项已删除：删掉不再被引用的副本（以及过期失败项的）
    void ctx.cache.listOutbox().then((items) => sweepOutboxCopies(items, removeLocalFile), () => {})
  if (change.type !== 'state' && change.type !== 'cleared') {
    post(ctx, { ...change, name: ctx.name })
    if (change.type === 'outbox' && !ctx.leader)
      void ctx.cache.listOutbox(change.roomId).then((items) => {
        if (ctx !== current || ctx.closed) return
        for (const item of items)
          if (item.state === 'pending')
            post(ctx, { type: 'outbox', name: ctx.name, roomId: change.roomId, id: item.clientEntryId })
      }, () => {})
  }
  notify(change)
}

/**
 * 进入（或回到）有聊天的页面：为当前账号打开引擎并冷启动（探测 `/options`、核对 epoch、全量同步）；已
 * 启动就什么都不做（回前台的同步由 `imForeground` 负责）。
 */
export async function imStart(): Promise<void> {
  if (!IM_PLATFORM || !hasSession() || retiredSession === currentSessionVersion()) return
  if (current?.closed) return
  if (current && imState.value !== 'locked') return
  let flight = opening
  if (!flight) {
    const p = open()
    opening = flight = p
    const done = () => {
      if (opening === p) opening = null
    }
    p.then(done, done)
  }
  const ctx = await flight.catch(() => null)
  if (!ctx || ctx !== current) return
  // 同一账号的锁定引擎（会话恢复）解锁复用；新引擎冷启动
  if (ctx.engine.state === 'locked') await ctx.engine.unlock().catch(() => {})
  else if (ctx.engine.state === 'idle') {
    imState.value = 'syncing'
    await ctx.engine.start().catch(() => {})
  } else return
  void refreshCounts(ctx)
}

/**
 * 第一次打开聊天（消息 tab 的聊天区或会话页）时取通讯录与我的表情，之后本地存全量、带 ETag 复验；每个账号
 * 的引擎只做一次，应用启动时不拉。任一个没取到（断网、5xx）就允许下次打开再取。
 */
let warmed: Ctx | null = null
export function imOpenChat(): void {
  const ctx = imCurrent()
  if (!ctx || warmed === ctx) return
  warmed = ctx
  // 引擎自己处理错误、只回报是否取到：失败不会以异常出现，要看返回值
  void Promise.all([ctx.engine.loadDirectory(), ctx.engine.loadStickers()]).then(
    (done) => {
      if (done.includes(false) && warmed === ctx) warmed = null
    },
    () => {
      if (warmed === ctx) warmed = null
    },
  )
}

/** 全量同步（重连、断线轮询、回前台）。 */
export function imSync(reason: ImSyncReason): void {
  const ctx = imCurrent()
  if (ctx) void ctx.engine.fullSync(reason).catch(() => {})
}

/** App 回到前台（App.vue onShow）。 */
export function imForeground(): void {
  hidden = false
  imSync('foreground')
}

/** App 进入后台（App.vue onHide）：断线兜底轮询暂停。 */
export function imBackground(): void {
  hidden = true
}

/** 断线时 60 秒兜底（与计数轮询同节奏）。 */
export function imPoll(): void {
  if (!hidden) imSync('poll')
}

/** 实时提示。 */
export const imEntryHint = (hint: ImEntryHint) => imCurrent()?.engine.onEntryHint(hint)
export const imRoomHint = (hint: ImRoomHint) => imCurrent()?.engine.onRoomHint(hint)

/**
 * 登录了新会话（auth start）：放下当前引擎（不删数据），下次进入聊天时按新账号打开 —— 同一账号复用缓存，
 * 换了账号删除旧的。
 */
export function imSessionStart(): void {
  generation++
  if (current) dispose(current)
  current = null
  imLeader.value = false
  opening = null
  imState.value = 'idle'
  imOptions.value = null
  imUnread.value = 0
  imRoomCount.value = 0
}

/**
 * 主动退出、被踢：代际 +1 让在途结果作废 → 清除当前引擎（删库）→ 删除本机全部聊天命名空间、附件缓存与
 * 发件箱副本。同步部分在第一个 await 之前完成，随后的会话结束不会再把它当作“过期”锁定。
 */
export async function imWipe(): Promise<void> {
  generation++
  retiredSession = currentSessionVersion()
  const ctx = current
  current = null
  imLeader.value = false
  opening = null
  imState.value = 'idle'
  imOptions.value = null
  imUnread.value = 0
  imRoomCount.value = 0
  if (!IM_PLATFORM) return
  if (ctx) {
    post(ctx, { type: 'wipe', name: ctx.name })
    ctx.stop()
    await ctx.engine.clear().catch(() => {})
    ctx.engine.dispose()
  }
  releaseBlobUrls()
  await host.deleteOthers(null).catch(() => {})
  if (isApp()) await sweepOutboxCopies([], removeLocalFile, Date.now(), true).catch(() => {})
}

// 会话在没有主动退出/被踢的情况下结束（refresh 被拒）：只锁定，不删数据
watch(sessionVersion, () => {
  if (hasSession() || !current) return
  current.engine.lock()
  imState.value = 'locked'
})
