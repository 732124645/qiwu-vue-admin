import { z } from 'zod'
import { i18nTextVo } from '../../common/crud.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { isImStickerCode } from './stickers.js'
import { imCallSummaryVo } from './im-media.schema.js'

/**
 * 员工即时通讯接口契约（`/api/im`，see docs/im.md）。请求体与查询都是严格对象（未知字段 400），整数都是
 * 安全整数；字段标签 `field.im.<prop>`。实时提示 `im:entry` / `im:room` 只带编号，永不带正文。
 */

// ---------- 常量 ----------

export const IM_ROOM_KINDS = ['direct', 'group'] as const
export type ImRoomKind = (typeof IM_ROOM_KINDS)[number]

export const IM_ROLES = ['owner', 'moderator', 'participant'] as const
export type ImRole = (typeof IM_ROLES)[number]
/** 群主可设置的角色（群主只经转让产生）。 */
export const IM_ASSIGNABLE_ROLES = ['moderator', 'participant'] as const

export const IM_ENTRY_KINDS = ['text', 'image', 'file', 'voice', 'sticker', 'event'] as const
export type ImEntryKind = (typeof IM_ENTRY_KINDS)[number]
/** 客户端可发送的类型（`event` 只由服务端写）。 */
export const IM_SEND_KINDS = ['text', 'image', 'file', 'voice', 'sticker'] as const
export type ImSendKind = (typeof IM_SEND_KINDS)[number]
/** 计入未读、可撤回的类型。 */
export const IM_COUNTED_KINDS: readonly ImEntryKind[] = IM_SEND_KINDS

/** 系统事件编码；`entry.edit` / `entry.recall` 不更新会话时间、不作为预览。 */
export const IM_EVENT_CODES = [
  'room.create',
  'member.add',
  'member.remove',
  'member.leave',
  'role.change',
  'owner.transfer',
  'room.rename',
  'room.close',
  'entry.edit',
  'entry.recall',
  'call.ended',
] as const
export type ImEventCode = (typeof IM_EVENT_CODES)[number]
export const IM_SILENT_EVENT_CODES: readonly ImEventCode[] = ['entry.edit', 'entry.recall']

/** 消息附件的存储引用：`im:<roomId>:<seq>`；表情：`stk:<stickerId>`。 */
export const imEntryRef = (roomId: number, seq: number) => `im:${roomId}:${seq}`
export const imStickerRef = (stickerId: number) => `stk:${stickerId}`

/** 代码常量（不做参数）。 */
export const IM_LIMITS = {
  /** `GET /sync?ids=` 与 `seqs=` 一次最多 */
  idsMax: 100,
  /** `limit` 缺省 50 */
  entriesDefault: 50,
  entriesMax: 100,
  /** 每会话未读计数封顶（客户端显示 99+） */
  unreadCap: 100,
  labelMax: 80,
  memberLabelMax: 64,
  clientEntryIdMax: 64,
  /** 预览正文截取的字数 */
  previewChars: 60,
  /** 群成员绝对上限（参数 `im.group.max_members` 的上界） */
  groupMembersMax: 2000,
  /** 文字的绝对上限（参数 `im.message.text_max_chars` 的上界，码点） */
  textCharsMax: 20000,
  /** 每人自定义表情个数 */
  stickerMax: 100,
  stickerMaxBytes: 512 * 1024,
  stickerMaxPx: 240,
  thumbPx: 360,
  /** sharp 输入像素上限与动图帧数上限 */
  inputPixels: 40_000_000,
  animatedFrames: 100,
  /** 同源代理（`proxy=1`）输出上限 */
  proxyMaxBytes: 20 * 1024 * 1024,
  /** 系统事件数据序列化后上限 */
  eventDataMaxBytes: 8 * 1024,
  /** 客户端：每会话本地窗口条数与附件缓存总量 */
  localWindow: 2000,
  blobCacheBytes: 200 * 1024 * 1024,
} as const

/** 图片固定扩展名（读取时与 `storage.allowed_exts` 取交集）。 */
export const IM_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'] as const

/**
 * 文字内容规则：去首尾空白后非空，拒绝换行与制表符以外的控制字符（含 NUL 与 C1 控制字符）。
 * 码点长度上限由参数决定，服务端另查。
 */
// eslint-disable-next-line no-control-regex
export const IM_TEXT_FORBIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/
export const imTextOk = (text: string): boolean =>
  text.trim().length > 0 && !IM_TEXT_FORBIDDEN.test(text)
/** 码点数（emoji 等代理对按一个计）。 */
export const imCodePoints = (text: string): number => [...text].length

// ---------- 基础片段 ----------

const id = z.int().positive()
const seq = z.int().min(0)
const at = z.string()

/** 路径参数里的正整数编号（`:id`、`:seq`、`:userId`）：只收十进制数字串，安全整数。 */
export const imPathId = z
  .string()
  .regex(/^[1-9]\d{0,15}$/)
  .transform(Number)
  .pipe(z.int().positive())

/** 查询串里逗号分隔的编号列表（去重，最多 `IM_LIMITS.idsMax` 个）。 */
const csvIds = z
  .string()
  .regex(/^[1-9]\d{0,15}(,[1-9]\d{0,15})*$/)
  .transform((s) => [...new Set(s.split(',').map(Number))])
  .pipe(z.array(z.int().positive()).min(1).max(IM_LIMITS.idsMax))

/** 查询串里的非负整数（只收十进制数字串）。 */
const qInt = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})$/)
  .transform(Number)
  .pipe(z.int().min(0))

const flag = z.enum(['0', '1']).transform((v) => v === '1')

const text = z.string().max(IM_LIMITS.textCharsMax * 2)
const label = z.string().trim().min(1).max(IM_LIMITS.labelMax)
const userIds = z
  .array(id)
  .min(1)
  .max(IM_LIMITS.groupMembersMax - 1)
  .refine((ids) => new Set(ids).size === ids.length, { error: 'validation.invalid' })

const register = <T extends z.ZodType>(schema: T): T => {
  fieldDomains.add(schema, { domain: 'im' })
  return schema
}

// ---------- 请求 ----------

/** `GET /sync`：不带 ids = 全量紧凑元组；带 ids = 这些会话的详情。 */
export const imSyncQuery = register(z.strictObject({ ids: csvIds.optional() }))
export type ImSyncQuery = z.output<typeof imSyncQuery>

/** `POST /rooms/directs`：取或建与 peerId 的私聊。 */
export const imDirectCreate = register(z.strictObject({ peerId: id }))
export type ImDirectCreate = z.infer<typeof imDirectCreate>

/** `POST /rooms/groups`：建群，创建者为群主，`userIds` 是其余成员（不含自己）。 */
export const imGroupCreate = register(z.strictObject({ label, userIds }))
export type ImGroupCreate = z.infer<typeof imGroupCreate>

/** `POST /rooms/:id/members`。 */
export const imMembersAdd = register(z.strictObject({ userIds }))
export type ImMembersAdd = z.infer<typeof imMembersAdd>

/** `PUT /rooms/:id/owner`。 */
export const imOwnerTransfer = register(z.strictObject({ userId: id }))
export type ImOwnerTransfer = z.infer<typeof imOwnerTransfer>

/** `PUT /rooms/:id/members/:userId/role`。 */
export const imRoleChange = register(z.strictObject({ role: z.enum(IM_ASSIGNABLE_ROLES) }))
export type ImRoleChange = z.infer<typeof imRoleChange>

/** `PUT /rooms/:id/label`。 */
export const imLabelChange = register(z.strictObject({ label }))
export type ImLabelChange = z.infer<typeof imLabelChange>

/** `PUT /rooms/:id/read`：读位置只增，且不超过会话的 lastSeq。 */
export const imReadBody = register(z.strictObject({ seq }))
export type ImReadBody = z.infer<typeof imReadBody>

/**
 * `GET /rooms/:id/entries`：`afterSeq`（不含，向新）、`beforeSeq`（不含，向旧）、`seqs`（指定行）三者
 * 至多一个；都不带 = 最新一页。结果都夹在本人可见区间内，区间外的 seqs 静默缺省。
 */
export const imEntriesQuery = register(
  z
    .strictObject({
      afterSeq: qInt.optional(),
      beforeSeq: qInt.pipe(id).optional(),
      seqs: csvIds.optional(),
      limit: qInt.pipe(z.int().min(1).max(IM_LIMITS.entriesMax)).optional(),
    })
    .superRefine((q, ctx) => {
      const set = [q.afterSeq, q.beforeSeq, q.seqs].filter((v) => v !== undefined)
      if (set.length > 1)
        ctx.addIssue({ code: 'custom', path: ['seqs'], message: 'validation.invalid' })
    }),
)
export type ImEntriesQuery = z.output<typeof imEntriesQuery>

/**
 * `POST /rooms/:id/entries`：`clientEntryId` 是客户端生成的 UUID 等（同一作者同一会话里唯一，重发用同一个）。
 * text → `text`；image / file → 先上传得到的 `objectId`；sticker → 内置 `stickerCode` 或自定义 `stickerId`
 * 二选一。多余的字段 400。
 */
export const imEntrySend = register(
  z
    .strictObject({
      clientEntryId: z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/)
        .min(1)
        .max(IM_LIMITS.clientEntryIdMax),
      kind: z.enum(IM_SEND_KINDS),
      text: text.optional(),
      objectId: id.optional(),
      stickerCode: z.string().max(32).optional(),
      stickerId: id.optional(),
    })
    .superRefine((b, ctx) => {
      const bad = (path: string, message = 'validation.invalid') =>
        ctx.addIssue({ code: 'custom', path: [path], message })
      const has = {
        text: b.text !== undefined,
        objectId: b.objectId !== undefined,
        stickerCode: b.stickerCode !== undefined,
        stickerId: b.stickerId !== undefined,
      }
      const allowed: Record<ImSendKind, (keyof typeof has)[]> = {
        text: ['text'],
        image: ['objectId'],
        file: ['objectId'],
        voice: ['objectId'],
        sticker: ['stickerCode', 'stickerId'],
      }
      for (const k of Object.keys(has) as (keyof typeof has)[])
        if (has[k] && !allowed[b.kind].includes(k)) bad(k)
      if (b.kind === 'text') {
        if (!has.text) bad('text', 'validation.required')
        else if (IM_TEXT_FORBIDDEN.test(b.text!)) bad('text', 'validation.im.control_char')
        else if (!b.text!.trim()) bad('text', 'validation.required')
      }
      if ((b.kind === 'image' || b.kind === 'file' || b.kind === 'voice') && !has.objectId)
        bad('objectId', 'validation.required')
      if (b.kind === 'sticker') {
        if (has.stickerCode === has.stickerId) bad('stickerCode', 'validation.required')
        else if (has.stickerCode && !isImStickerCode(b.stickerCode!)) bad('stickerCode')
      }
    }),
)
export type ImEntrySend = z.infer<typeof imEntrySend>

/** `PUT /rooms/:id/entries/:seq`：只改本人文字；`rev` 必须等于当前 `rev`。 */
export const imEntryEdit = register(
  z.strictObject({ text, rev: z.int().min(1) }).superRefine((b, ctx) => {
    if (IM_TEXT_FORBIDDEN.test(b.text))
      ctx.addIssue({ code: 'custom', path: ['text'], message: 'validation.im.control_char' })
    else if (!b.text.trim())
      ctx.addIssue({ code: 'custom', path: ['text'], message: 'validation.required' })
  }),
)
export type ImEntryEdit = z.infer<typeof imEntryEdit>

/** `GET /rooms/:id/entries/:seq/file`：`thumb=1` 取缩略图；`proxy=1` 同源输出（≤20MiB，不 302）。 */
export const imFileQuery = register(
  z.strictObject({ thumb: flag.optional(), proxy: flag.optional() }),
)
export type ImFileQuery = z.output<typeof imFileQuery>

/** `GET /stickers/:id/file`。 */
export const imStickerFileQuery = register(z.strictObject({ proxy: flag.optional() }))
export type ImStickerFileQuery = z.output<typeof imStickerFileQuery>

/** `POST /stickers/from-entry`：把收到的图片或表情存为我的表情。 */
export const imStickerFromEntry = register(z.strictObject({ roomId: id, seq: id }))
export type ImStickerFromEntry = z.infer<typeof imStickerFromEntry>

/** `PUT /stickers/order`：本人全部表情的新顺序。 */
export const imStickerOrder = register(
  z.strictObject({
    ids: z
      .array(id)
      .min(1)
      .max(IM_LIMITS.stickerMax)
      .refine((ids) => new Set(ids).size === ids.length, { error: 'validation.invalid' }),
  }),
)
export type ImStickerOrder = z.infer<typeof imStickerOrder>

// ---------- 响应 ----------

/** `GET /options`：限额与 epoch；同时是客户端的开关探测（404 = 关闭或套餐不含，403 = 非员工）。 */
export const imOptionsVo = z.strictObject({
  textMaxChars: z.int(),
  fileMaxMb: z.int(),
  fileExts: z.array(z.string()),
  imageExts: z.array(z.string()),
  recallMinutes: z.int(),
  editMinutes: z.int(),
  groupRecallAnytime: z.boolean(),
  groupMaxMembers: z.int(),
  stickerMax: z.int(),
  epoch: z.string(),
  voiceEnabled: z.boolean().optional(),
  voiceMaxSeconds: z.int().min(1).max(300).optional(),
  voiceMaxMb: z.int().min(1).max(20).optional(),
  callEnabled: z.boolean().optional(),
  callConfigured: z.boolean().optional(),
})
export type ImOptions = z.infer<typeof imOptionsVo>

/** 通讯录：本租户启用部门与启用的内部员工（不含手机号、邮箱、登录名）。 */
export const imDirectoryDeptVo = z.strictObject({
  id,
  parentId: z.int().min(0),
  name: z.string(),
  nameI18n: i18nTextVo.optional(),
  sortNo: z.int(),
})
export const imDirectoryUserVo = z.strictObject({
  id,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  /** 部门停用或缺失时为 null */
  deptId: id.nullable(),
})
export const imDirectoryVo = z.strictObject({
  depts: z.array(imDirectoryDeptVo),
  users: z.array(imDirectoryUserVo),
})
export type ImDirectoryDept = z.infer<typeof imDirectoryDeptVo>
export type ImDirectoryUser = z.infer<typeof imDirectoryUserVo>
export type ImDirectory = z.infer<typeof imDirectoryVo>

/**
 * 全量同步的紧凑元组 `[roomId, periodId, lastSeq, readSeq, floorSeq, metaRev]`：`periodId` 是本人当前
 * 成员时期（roster 行 id），再加入即变；按 roomId 升序。
 */
export const imSyncTupleVo = z.tuple([id, id, seq, seq, seq, z.int().min(1)])
export type ImSyncTuple = z.infer<typeof imSyncTupleVo>
export const imSyncVo = z.strictObject({ epoch: z.string(), rooms: z.array(imSyncTupleVo) })
export type ImSync = z.infer<typeof imSyncVo>

/** 会话预览：最后一条不是编辑/撤回事件的行；撤回行无正文，事件只给编码，正文截 60 字。 */
export const imPreviewVo = z.strictObject({
  seq: id,
  kind: z.enum(IM_ENTRY_KINDS),
  authorId: id.nullable(),
  authorLabel: z.string().nullable(),
  text: z.string().nullable(),
  stickerCode: z.string().nullable(),
  eventCode: z.enum(IM_EVENT_CODES).nullable(),
  recalled: z.boolean(),
  at,
})
export type ImPreview = z.infer<typeof imPreviewVo>

/** `GET /sync?ids=` 的一项；也是建私聊/建群与群管理接口的返回。 */
export const imRoomDetailVo = z.strictObject({
  roomId: id,
  /** 本人当前成员时期 */
  periodId: id,
  kind: z.enum(IM_ROOM_KINDS),
  /** 群名；私聊为 null（客户端显示对方姓名） */
  label: z.string().nullable(),
  /** 私聊对方的用户 ID */
  peerId: id.optional(),
  memberCount: z.int().min(0),
  closedAt: at.nullable(),
  role: z.enum(IM_ROLES),
  visibleFromSeq: seq,
  lastSeq: seq,
  readSeq: seq,
  floorSeq: seq,
  metaRev: z.int().min(1),
  lastAt: at.nullable(),
  /** 未读数（封顶 `IM_LIMITS.unreadCap`） */
  unread: z.int().min(0),
  preview: imPreviewVo.nullable(),
})
export type ImRoomDetail = z.infer<typeof imRoomDetailVo>

/** 群成员。用户已删除时 `displayName` 是入群时的姓名快照，`enabled` 为 false。 */
export const imMemberVo = z.strictObject({
  userId: id,
  role: z.enum(IM_ROLES),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  enabled: z.boolean(),
})
export type ImMember = z.infer<typeof imMemberVo>

/** 消息附件（缩略图只有图片与表情有）；`sha256` 供客户端去重缓存。 */
export const imAttachmentVo = z.strictObject({
  objectId: id,
  thumbObjectId: id.optional(),
  name: z.string(),
  mime: z.string(),
  size: z.int().min(0),
  width: z.int().min(0).optional(),
  height: z.int().min(0).optional(),
  sha256: z.string(),
  durationMs: z.int().min(1).max(300_000).optional(),
})
export type ImAttachment = z.infer<typeof imAttachmentVo>

/** 系统事件数据（`users` 带姓名快照；`role` 只在 role.change；`label` 只在建群与改名）。 */
export const imEventVo = z.strictObject({
  code: z.enum(IM_EVENT_CODES),
  actorId: id.nullable(),
  users: z.array(z.strictObject({ id, name: z.string() })).optional(),
  label: z.string().optional(),
  role: z.enum(IM_ROLES).optional(),
  call: imCallSummaryVo.optional(),
})
export type ImEvent = z.infer<typeof imEventVo>

/** 一条消息或事件的当前状态（编辑后为新文字，撤回后内容与附件为 null）。 */
export const imEntryVo = z.strictObject({
  seq: id,
  kind: z.enum(IM_ENTRY_KINDS),
  authorId: id.nullable(),
  authorKind: z.string().nullable(),
  authorLabel: z.string().nullable(),
  /** 只回给作者本人（别人看到 null） */
  clientEntryId: z.string().nullable(),
  text: z.string().nullable(),
  stickerCode: z.string().nullable(),
  attachment: imAttachmentVo.nullable(),
  event: imEventVo.nullable(),
  targetSeq: id.nullable(),
  rev: z.int().min(1),
  createdAt: at,
  editedAt: at.nullable(),
  recalledAt: at.nullable(),
  recalledBy: id.nullable(),
})
export type ImEntry = z.infer<typeof imEntryVo>

/** `GET /rooms/:id/entries`。 */
export const imEntriesVo = z.strictObject({
  items: z.array(imEntryVo),
  hasMore: z.boolean(),
  lastSeq: seq,
  floorSeq: seq,
  visibleFromSeq: seq,
})
export type ImEntries = z.infer<typeof imEntriesVo>

/** `POST /rooms/:id/uploads`：未绑定的对象，24 小时内不发送会被回收。 */
export const imUploadVo = z.strictObject({
  objectId: id,
  name: z.string(),
  size: z.int().min(0),
  mime: z.string(),
  durationMs: z.int().min(1).max(300_000).optional(),
})
export type ImUpload = z.infer<typeof imUploadVo>

/** `PUT /rooms/:id/read`：生效后的读位置。 */
export const imReadVo = z.strictObject({ readSeq: seq })
export type ImRead = z.infer<typeof imReadVo>

/** 本人自定义表情。 */
export const imStickerVo = z.strictObject({
  id,
  sha256: z.string(),
  mime: z.string(),
  width: z.int().min(0),
  height: z.int().min(0),
})
export type ImSticker = z.infer<typeof imStickerVo>

// ---------- 实时提示 ----------

/** `im:entry`：会话里多了第 seq 条（kind 含 `event`）。 */
export const imEntryHint = z.strictObject({
  roomId: id,
  seq: id,
  authorId: id.nullable(),
  kind: z.enum(IM_ENTRY_KINDS),
})
export type ImEntryHint = z.infer<typeof imEntryHint>

/** `im:room`：带 readSeq = 本人在别的设备读到这里；不带 = 成员、角色、群名或解散变化。 */
export const imRoomHint = z.strictObject({ roomId: id, readSeq: seq.optional() })
export type ImRoomHint = z.infer<typeof imRoomHint>
