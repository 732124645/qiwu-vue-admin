import { Err, type ImEntryKind, type ImEvent } from '@qiwu/shared'
import { Between, type EntityManager } from 'typeorm'
import { tenantId } from '../../../core/context/tenant.js'
import { BizError } from '../../../core/http/biz-error.js'
import { ImEntryEntity, ImRoomEntity, ImRosterEntity } from './entities/im.entity.js'

/**
 * 成员与可见区间的唯一判定（see docs/im.md）：列表、`afterSeq/beforeSeq/seqs`、编辑/撤回、存表情与附件文件
 * 路由都只经这里判断。当前成员（存活的 roster 行）可见 `[max(visibleFromSeq, room.floorSeq), room.lastSeq]`；
 * 非成员、已退出、跨租户 → 404 B5002；单条操作在区间外 → 404 B5012；`seqs` 在区间外静默缺省。
 * 原始 SQL 自带 `tenant_id = ?`。
 */

/** 本人在一个会话里的当前成员身份。 */
export interface ImMembership {
  room: ImRoomEntity
  roster: ImRosterEntity
}

/** 闭区间 `[from, to]`；`from > to` 表示空。 */
export interface ImSeqRange {
  from: number
  to: number
}

/**
 * 锁住会话行（`SELECT … FROM im_room … FOR UPDATE`）：凡是写会话的事务，这必须是第一条语句；之后的读
 * 因而看到锁前已提交的一切，seq 在锁内分配。会话不存在或属于别的租户 → B5002。
 */
export async function lockRoom(tx: EntityManager, roomId: number): Promise<ImRoomEntity> {
  // ORM 渲染时补上当前租户条件：别的租户的同号会话与不存在一样
  const room = await tx
    .getRepository(ImRoomEntity)
    .findOne({ where: { id: roomId }, lock: { mode: 'pessimistic_write' } })
  if (!room) throw new BizError(Err.IM_ROOM_NOT_FOUND)
  return room
}

/**
 * 调用者必须是会话的当前成员，否则 B5002。`lock` 为 true 时先 `lockRoom`（须在事务里）。
 */
export async function requireMember(
  db: EntityManager,
  roomId: number,
  userId: number,
  opts: { lock?: boolean } = {},
): Promise<ImMembership> {
  const room = opts.lock
    ? await lockRoom(db, roomId)
    : await db.getRepository(ImRoomEntity).findOneBy({ id: roomId })
  if (!room) throw new BizError(Err.IM_ROOM_NOT_FOUND)
  // 存活的 roster 行才是当前成员：退出或被移除后与从未加入一样是 404（不暴露会话是否存在）
  const roster = await db.getRepository(ImRosterEntity).findOneBy({ roomId, userId })
  if (!roster) throw new BizError(Err.IM_ROOM_NOT_FOUND)
  return { room, roster }
}

/** 本人可见区间。 */
export function visibleRange(m: ImMembership): ImSeqRange {
  return { from: Math.max(m.roster.visibleFromSeq, m.room.floorSeq), to: m.room.lastSeq }
}

/** 只留下可见区间内的 seq（去重、升序）。 */
export function clampSeqs(m: ImMembership, seqs: readonly number[]): number[] {
  const { from, to } = visibleRange(m)
  return [...new Set(seqs)].filter((s) => s >= from && s <= to).sort((a, b) => a - b)
}

/**
 * 可见区间内的一条消息（编辑、撤回、存表情、附件文件）；区间外、已被清理或不存在 → B5012。`lock` 为 true
 * 时 `FOR UPDATE`（须在已锁会话的事务里）。
 */
export async function visibleEntry(
  db: EntityManager,
  m: ImMembership,
  seq: number,
  opts: { lock?: boolean } = {},
): Promise<ImEntryEntity> {
  const { from, to } = visibleRange(m)
  if (seq < from || seq > to) throw new BizError(Err.IM_ENTRY_NOT_FOUND)
  const entry = await db.getRepository(ImEntryEntity).findOne({
    where: { roomId: m.room.id, seq },
    ...(opts.lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
  })
  if (!entry) throw new BizError(Err.IM_ENTRY_NOT_FOUND)
  return entry
}

/** 可见区间内按 seq 取行（列表用）；`desc` 时从新到旧取 `take` 行。 */
export function entriesBetween(
  db: EntityManager,
  roomId: number,
  range: ImSeqRange,
  take: number,
  desc = false,
): Promise<ImEntryEntity[]> {
  if (range.from > range.to) return Promise.resolve([])
  return db.getRepository(ImEntryEntity).find({
    where: { roomId, seq: Between(range.from, range.to) },
    order: { seq: desc ? 'DESC' : 'ASC' },
    take,
  })
}

/** 一个启用的本租户内部员工的展示信息。 */
export interface ImStaff {
  id: number
  displayName: string
  avatarUrl: string | null
}

/**
 * 给定用户里本租户启用、未删除的内部员工（私聊对象、新成员、姓名快照的唯一判定）。不在结果里的 id 就是
 * 不可用：别的租户、停用、删除、会员身份或不存在，一律同样处理。
 */
export async function activeStaff(
  db: EntityManager,
  ids: readonly number[],
): Promise<Map<number, ImStaff>> {
  if (!ids.length) return new Map()
  const rows = await db.query<{ id: number; display_name: string; avatar_url: string | null }[]>(
    // qw:no-data-scope 聊天通讯录对全体员工开放，不套用管理数据范围
    `SELECT u.id, u.display_name, u.avatar_url FROM iam_user u
      WHERE u.tenant_id = ? AND u.id IN (?) AND u.enabled = 1 AND u.user_type = 'admin'
        AND u.deleted_at IS NULL`,
    [tenantId(), [...new Set(ids)]],
  )
  return new Map(
    rows.map((r) => [
      Number(r.id),
      { id: Number(r.id), displayName: r.display_name, avatarUrl: r.avatar_url },
    ]),
  )
}

/** 会话的当前成员 ID（提示的收件人；在已锁会话的事务里读到的是锁后的成员）。 */
export async function memberIds(db: EntityManager, roomId: number): Promise<number[]> {
  const rows = await db.query<{ user_id: number }[]>(
    `SELECT r.user_id FROM im_roster r
      WHERE r.tenant_id = ? AND r.room_id = ? AND r.deleted_at IS NULL ORDER BY r.id`,
    [tenantId(), roomId],
  )
  return rows.map((r) => Number(r.user_id))
}

/** 追加一行时写入的内容（seq、会话、租户由 {@link appendEntry} 填）。 */
export type ImNewEntry = Partial<
  Pick<
    ImEntryEntity,
    | 'authorId'
    | 'authorKind'
    | 'authorLabel'
    | 'clientEntryId'
    | 'requestDigest'
    | 'textValue'
    | 'stickerCode'
    | 'attachment'
    | 'eventData'
    | 'targetSeq'
  >
> & { entryKind: ImEntryKind }

/**
 * 在已锁住的会话里追加一行：seq = `last_seq + 1`（锁持有到提交，所以同一会话的提交顺序就是 seq 顺序、
 * 读者看不到空洞，回滚也不消耗 seq）。`touch` 为 true 时更新会话时间（编辑/撤回事件不更新）；`meta` 为
 * true 时 `meta_rev + 1`（群名、成员、角色、解散变化）。返回写入后的行，并同步更新内存里的 `room`。
 */
export async function appendEntry(
  tx: EntityManager,
  room: ImRoomEntity,
  row: ImNewEntry,
  opts: { touch: boolean; meta?: boolean },
): Promise<ImEntryEntity> {
  const seq = room.lastSeq + 1
  const repo = tx.getRepository(ImEntryEntity)
  await repo.insert({ ...row, roomId: room.id, seq })
  const entry = await repo.findOneByOrFail({ roomId: room.id, seq })
  room.lastSeq = seq
  if (opts.touch) room.lastEntryAt = entry.createdAt
  if (opts.meta) room.metaRev += 1
  await tx.getRepository(ImRoomEntity).update(
    { id: room.id },
    {
      lastSeq: room.lastSeq,
      lastEntryAt: room.lastEntryAt,
      metaRev: room.metaRev,
    },
  )
  return entry
}

/** 系统事件数据超过上限时从尾部丢掉用户快照（成员表才是权威，事件只供显示）。 */
export function fitEvent(event: ImEvent, maxBytes: number): ImEvent {
  // 大批加人时事件只留前面能放下的姓名；要完整名单时改为分多条事件
  if (!event.users || Buffer.byteLength(JSON.stringify(event)) <= maxBytes) return event
  let size = Buffer.byteLength(JSON.stringify({ ...event, users: [] }))
  const users: NonNullable<ImEvent['users']> = []
  for (const u of event.users) {
    // 每项另加一个逗号的余量
    size += Buffer.byteLength(JSON.stringify(u)) + 1
    if (size > maxBytes) break
    users.push(u)
  }
  return { ...event, users }
}
