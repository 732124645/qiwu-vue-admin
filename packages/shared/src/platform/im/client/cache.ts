import type {
  ImDirectory,
  ImEntry,
  ImEntryEdit,
  ImEntryHint,
  ImEntries,
  ImEntriesQuery,
  ImEntrySend,
  ImOptions,
  ImRead,
  ImRoomDetail,
  ImRoomHint,
  ImSendKind,
  ImSticker,
  ImSync,
  ImUpload,
} from '../im.schema.js'

/**
 * 本地优先聊天客户端的缓存接口与引擎公开类型（see docs/im.md）。web/H5 用 IndexedDB 实现、App 用
 * SQLite 实现、测试与配额不足时用内存实现，三者跑同一套契约用例。缓存只存当前账号命名空间的数据；
 * 服务端始终是权威，缓存可以随时整库删除重建。
 */

/** 本地会话记录：同步元组 + 最近一次详情 + 本地窗口与未读状态。 */
export interface ImRoomRecord {
  roomId: number
  /** 本人成员时期；变了 = 退群后再加入，清本地窗口 */
  periodId: number
  lastSeq: number
  readSeq: number
  floorSeq: number
  metaRev: number
  /** 最近一次 `GET /sync?ids=` 的详情；未取过为 null */
  detail: ImRoomDetail | null
  /** 本地未读；`unreadEstimated` 为 true 时是按提示累加的估算值，下次全量同步取详情纠正 */
  unread: number
  unreadEstimated: boolean
  /** 本地连续窗口 `[windowLow, windowHigh]`；没有本地行时都是 0 */
  windowLow: number
  windowHigh: number
  /** 排序时间（ISO 8601）；null 排最后 */
  lastAt: string | null
  /** 本地修订号：每次写入 +1；全量同步只删除修订号早于请求开始的会话 */
  localRev: number
}

/** 本地消息行：服务端的 canonical 行 + 所属会话。 */
export interface ImEntryRecord extends ImEntry {
  roomId: number
}

/** 待发文件：平台自己的本地引用（web 为 Blob 的键，App 为 `_doc/im-outbox/` 下的副本路径）。 */
export interface ImOutboxFile {
  name: string
  size: number
  mime: string
  localRef: string
  /** 浏览器语音正文随发件箱经结构化克隆持久化；原生端只存持久文件路径。 */
  body?: unknown
}

export const IM_OUTBOX_STATES = ['pending', 'failed'] as const
export type ImOutboxState = (typeof IM_OUTBOX_STATES)[number]

/** 发件箱：发送成功（拿到 canonical 行）后与写入该行在同一个事务里删除。 */
export interface ImOutboxRecord {
  clientEntryId: string
  roomId: number
  kind: ImSendKind
  text?: string
  stickerCode?: string
  stickerId?: number
  file?: ImOutboxFile
  /** 文件已上传得到的对象；有了它重试不再重复上传 */
  objectId?: number
  state: ImOutboxState
  /** 失败原因：服务端错误码或 HTTP 状态 */
  failure?: string
  attempts: number
  /** 毫秒时间戳 */
  createdAt: number
  nextAttemptAt: number
}

/** meta 里的固定键：`epoch` 与 `schema` 不一致就整库重建。 */
export type ImMetaKey = 'epoch' | 'schema' | 'syncEtag'

/** 带 ETag 的整份快照（通讯录、我的表情）。 */
export interface ImSnapshot<T> {
  etag: string | null
  data: T
  /** 毫秒时间戳 */
  fetchedAt: number
}

/**
 * 附件缓存项：键 `o:<objectId>`（随会话删除）或 `s:<sha256>`（表情类，跨会话去重）。`body` 由平台决定：
 * web/H5 是 Blob，App 是 `uni.saveFile` 的路径。按 `usedAt` 做 LRU（总量 `IM_LIMITS.blobCacheBytes`）。
 */
export interface ImBlobRecord {
  key: string
  size: number
  usedAt: number
  /** `o:` 键所属会话；`s:` 键为 null */
  roomId: number | null
  body: unknown
}

/** 不含正文的附件缓存项（LRU 扫描用）。 */
export type ImBlobMeta = Omit<ImBlobRecord, 'body'>

/** 查询本地窗口：`[fromSeq, toSeq]` 闭区间，`order` 默认 asc，`limit` 取靠近 `order` 起点的条数。 */
export interface ImEntryRange {
  fromSeq?: number
  toSeq?: number
  limit?: number
  order?: 'asc' | 'desc'
}

/**
 * 事务里可做的读写。实现方要求：`tx` 回调里只能 await 这些方法（IndexedDB 事务在等待别的异步时会自动
 * 提交），回调抛错时整个事务回滚、不留任何部分写入。
 */
export interface ImCacheOps {
  getRoom(roomId: number): Promise<ImRoomRecord | undefined>
  listRooms(): Promise<ImRoomRecord[]>
  putRoom(room: ImRoomRecord): Promise<void>
  /** 删会话连同它的本地行、发件箱与 `o:` 附件缓存项 */
  deleteRoom(roomId: number): Promise<void>

  getEntry(roomId: number, seq: number): Promise<ImEntryRecord | undefined>
  getEntries(roomId: number, range?: ImEntryRange): Promise<ImEntryRecord[]>
  putEntries(entries: readonly ImEntryRecord[]): Promise<void>
  /** 删 `seq < belowSeq` 的行；不给 belowSeq 时删该会话全部本地行 */
  deleteEntries(roomId: number, belowSeq?: number): Promise<void>
  countEntries(roomId: number): Promise<number>

  listOutbox(roomId?: number): Promise<ImOutboxRecord[]>
  putOutbox(item: ImOutboxRecord): Promise<void>
  deleteOutbox(clientEntryId: string): Promise<void>

  getMeta(key: ImMetaKey): Promise<string | undefined>
  putMeta(key: ImMetaKey, value: string): Promise<void>

  getDirectory(): Promise<ImSnapshot<ImDirectory> | undefined>
  putDirectory(snapshot: ImSnapshot<ImDirectory>): Promise<void>
  getStickers(): Promise<ImSnapshot<ImSticker[]> | undefined>
  putStickers(snapshot: ImSnapshot<ImSticker[]>): Promise<void>

  getBlob(key: string): Promise<ImBlobRecord | undefined>
  putBlob(blob: ImBlobRecord): Promise<void>
  touchBlob(key: string, usedAt: number): Promise<void>
  deleteBlob(key: string): Promise<void>
  listBlobs(): Promise<ImBlobMeta[]>
}

/** 一个账号命名空间的本地缓存。 */
export interface ImCache extends ImCacheOps {
  /** 命名空间（库名），`qw-im-<16 位十六进制>` */
  readonly name: string
  /** 原子写：回调里的全部读写一起提交或一起回滚 */
  tx<T>(fn: (ops: ImCacheOps) => Promise<T>): Promise<T>
  /** 关闭连接（不删数据） */
  close(): Promise<void>
  /** 删除整个命名空间的数据（App 还删附件文件） */
  destroy(): Promise<void>
}

/** 本地缓存结构版本；变了整库重建。 */
export const IM_CACHE_SCHEMA = '1'

// ---------- 引擎 ----------

/** 带 ETag 的 GET 结果：304 时没有数据。 */
export type ImConditional<T> =
  { status: 200; etag: string | null; data: T } | { status: 304; etag: string | null }

/**
 * 接口出错时引擎拿到的错误：`status` 为 HTTP 状态（断网为 0），`code` 为业务错误码（如 `B5002`）。
 * 断网/429/5xx 退避重试；400/403/413/422 停止并标失败；404 删除该会话；401 由宿主锁定。
 */
export interface ImApiError {
  status: number
  code?: string
}

/** 引擎依赖的接口端口（宿主用自己的请求层实现；带登录令牌与 `If-None-Match`）。 */
export interface ImApi {
  options(): Promise<ImOptions>
  sync(etag: string | null): Promise<ImConditional<ImSync>>
  syncDetails(ids: readonly number[]): Promise<ImRoomDetail[]>
  entries(roomId: number, query: Partial<ImEntriesQuery>): Promise<ImEntries>
  upload(roomId: number, file: ImOutboxFile, kind?: ImSendKind): Promise<ImUpload>
  send(roomId: number, body: ImEntrySend): Promise<ImEntry>
  edit(roomId: number, seq: number, body: ImEntryEdit): Promise<ImEntry>
  recall(roomId: number, seq: number): Promise<ImEntry>
  read(roomId: number, seq: number): Promise<ImRead>
  directory(etag: string | null): Promise<ImConditional<ImDirectory>>
  stickers(etag: string | null): Promise<ImConditional<ImSticker[]>>
}

/** 触发全量同步的原因。 */
export type ImSyncReason = 'cold-start' | 'reconnect' | 'foreground' | 'poll' | 'epoch'

/** 引擎状态：`locked` = 会话过期只锁不清；`disabled` = 探测 404/403（开关关、套餐不含、非员工）。 */
export type ImEngineState = 'idle' | 'syncing' | 'ready' | 'offline' | 'locked' | 'disabled'

/** 引擎通知界面的变化（界面据此从缓存重读）。 */
export type ImChange =
  | { type: 'state'; state: ImEngineState }
  | { type: 'rooms'; roomIds: number[] }
  | { type: 'entries'; roomId: number }
  | { type: 'outbox'; roomId: number }
  | { type: 'directory' }
  | { type: 'stickers' }
  | { type: 'cleared' }

/** 用户要发的一条消息（文件由宿主先放进本地引用）。 */
export type ImDraft =
  | { kind: 'text'; text: string }
  | { kind: 'sticker'; stickerCode: string }
  | { kind: 'sticker'; stickerId: number }
  | { kind: 'image' | 'file' | 'voice'; file: ImOutboxFile }

/** 构造引擎的依赖：接口、缓存与可替换的时钟和编号（测试用）。 */
export interface ImEngineOptions {
  api: ImApi
  cache: ImCache
  /** 当前标签页/进程是否负责同步与发送（web 多标签页选主；App 恒为 true） */
  isLeader?: () => boolean
  /** 毫秒时间戳 */
  now?: () => number
  /** 新消息的 clientEntryId */
  newId?: () => string
  /** 定时器（测试可替换） */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** 当前账号：判断提示里的消息是不是自己发的（不给时按 clientEntryId 推断本地行） */
  userId?: number
}

/** 引擎公开方法（web 的 store 与移动端的 client 都只经这些方法驱动引擎）。 */
export interface ImEngine {
  readonly state: ImEngineState
  /** 每次清除 +1；旧代际的在途响应一律丢弃 */
  readonly generation: number
  /** 最近一次探测到的限额与 epoch；探测成功前为 null */
  readonly options: ImOptions | null
  /** 冷启动：探测 `/options`、核对 epoch、全量同步 */
  start(): Promise<void>
  /** 全量同步（单飞：进行中再触发只置 dirty，结束后再跑一次） */
  fullSync(reason: ImSyncReason): Promise<void>
  /** 处理实时提示 */
  onEntryHint(hint: ImEntryHint): void
  onRoomHint(hint: ImRoomHint): void
  /** 打开/离开会话（打开的会话收到提示即增量拉取） */
  openRoom(roomId: number): Promise<void>
  closeRoom(roomId: number): void
  /** 向上翻页：先读本地再 `beforeSeq`；返回是否还有更早的 */
  loadOlder(roomId: number): Promise<boolean>
  /** 写发件箱并排队发送，返回 clientEntryId */
  send(roomId: number, draft: ImDraft): Promise<string>
  retry(clientEntryId: string): Promise<void>
  discard(clientEntryId: string): Promise<void>
  edit(roomId: number, seq: number, text: string, rev: number): Promise<void>
  recall(roomId: number, seq: number): Promise<void>
  /** 上报已渲染的最大可见 seq（防抖） */
  markRead(roomId: number, seq: number): void
  /**
   * 第一次打开聊天时才取通讯录与我的表情，之后带 ETag 复验。返回这次是否取到（200/304）；失败时错误已按
   * 后台流程处理（锁定/离线），宿主据 false 允许下次再取
   */
  loadDirectory(): Promise<boolean>
  loadStickers(): Promise<boolean>
  /** 各会话未读合计 */
  totalUnread(): Promise<number>
  /** 会话过期（refresh 401）：停止同步、不渲染缓存，不删数据 */
  lock(): void
  /** 同一账号重新登录后解除锁定 */
  unlock(): Promise<void>
  /** 主动退出、被踢、换账号、epoch 变化：代际 +1、关连接、删库 */
  clear(): Promise<void>
  /** 会话列表当前看得见的会话：它们收到提示时防抖 1 秒按 `afterSeq` 增量拉取（顺便更新预览） */
  setVisibleRooms(ids: readonly number[]): void
  /** 建私聊/建群与群管理接口直接返回的详情：写进本地，不再回查 */
  applyDetail(detail: ImRoomDetail): Promise<void>
  /** 本人退群后本地删掉该会话 */
  forgetRoom(roomId: number): Promise<void>
  subscribe(listener: (change: ImChange) => void): () => void
  /** 停止定时器与订阅（不删数据） */
  dispose(): void
}
