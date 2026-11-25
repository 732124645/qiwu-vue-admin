import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  DEFAULT_IM_GROUP_RECALL_ANYTIME,
  IM_COUNTED_KINDS,
  IM_INT_PARAMS,
  IM_LIMITS,
  imParams,
  type ImEvent,
  type ImEntryKind,
  type ImOptions,
  type ImPreview,
  type ImRole,
  type ImRoomDetail,
  type ImRoomKind,
  type ImSync,
  type ImSyncTuple,
} from '@qiwu/shared'
import type { DataSource, EntityManager } from 'typeorm'
import { tenantId } from '../../../core/context/tenant.js'
import { ParamService } from '../../../core/settings/param.service.js'
import { ImObjectsService } from './im-objects.service.js'
import { ImMediaGateway } from './im-media-gateway.js'

const MiB = 1024 * 1024

/** 详情查询的一行（本人存活 roster ⨝ 会话）。 */
interface DetailRow {
  room_id: number
  period_id: number
  room_kind: ImRoomKind
  label: string | null
  pair_low_id: number | null
  pair_high_id: number | null
  closed_at: Date | null
  role_code: ImRole
  visible_from_seq: number
  last_seq: number
  read_seq: number
  floor_seq: number
  meta_rev: number
  last_entry_at: Date | null
  member_count: number
}

/** 预览查询的一行。 */
interface PreviewRow {
  seq: number
  entry_kind: ImEntryKind
  author_id: number | null
  author_label: string | null
  text_value: string | null
  sticker_code: string | null
  event_data: ImEvent | null
  recalled_at: Date | null
  created_at: Date
}

/** 布尔参数：缺省用默认值，其余只认 `'true'`。 */
export async function boolParam(params: ParamService, key: string, fallback: boolean) {
  const raw = await params.get(key)
  return raw === null ? fallback : raw.trim() === 'true'
}

/** 一个整数参数（按共享的边界读取，越界回落默认值）。 */
export const intParam = (
  params: ParamService,
  p: (typeof IM_INT_PARAMS)[keyof typeof IM_INT_PARAMS],
) => params.int(p.key, p.min, p.max, p.fallback)

/**
 * 限额探测与同步（see docs/im.md）：全量同步只回本人当前会话的紧凑元组；客户端判定变化的会话再按 ids
 * 取详情（准确未读与预览）。没有游标，退群/被移除 = 元组消失，再加入 = periodId 变。
 */
@Injectable()
export class SyncService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly params: ParamService,
    private readonly objects: ImObjectsService,
    private readonly media: ImMediaGateway,
  ) {}

  /** 限额与 epoch；同时是客户端的开关探测。上传上限已与存储上限取小。 */
  async options(): Promise<ImOptions> {
    const limits = await this.objects.limits()
    const voice = await this.objects.voiceLimits()
    return {
      textMaxChars: await intParam(this.params, IM_INT_PARAMS.textMaxChars),
      fileMaxMb: Math.max(1, Math.floor(limits.maxBytes / MiB)),
      fileExts: limits.fileExts,
      imageExts: limits.imageExts,
      recallMinutes: await intParam(this.params, IM_INT_PARAMS.recallMinutes),
      editMinutes: await intParam(this.params, IM_INT_PARAMS.editMinutes),
      groupRecallAnytime: await boolParam(
        this.params,
        imParams.groupRecallAnytime,
        DEFAULT_IM_GROUP_RECALL_ANYTIME,
      ),
      groupMaxMembers: await intParam(this.params, IM_INT_PARAMS.groupMaxMembers),
      stickerMax: IM_LIMITS.stickerMax,
      epoch: await this.epoch(),
      voiceEnabled: true,
      voiceMaxSeconds: voice.maxSeconds,
      voiceMaxMb: Math.max(1, Math.floor(voice.maxBytes / MiB)),
      callEnabled: await boolParam(this.params, imParams.callEnabled, false),
      callConfigured: this.media.configured(),
    }
  }

  /**
   * 本人全部当前会话的元组，按 roomId 升序：一条走 `idx(tenant_id,user_id,deleted_at)` 的查询，O(会话数)
   * 的小 JSON，同数据同 ETag。
   */
  async full(userId: number): Promise<ImSync> {
    const tid = tenantId()
    const rows = await this.ds.query<
      {
        room_id: number
        period_id: number
        last_seq: number
        read_seq: number
        floor_seq: number
        meta_rev: number
      }[]
    >(
      `SELECT r.room_id, r.id AS period_id, m.last_seq, r.read_seq, m.floor_seq, m.meta_rev
         FROM im_roster r
         JOIN im_room m ON m.id = r.room_id AND m.tenant_id = ? AND m.deleted_at IS NULL
        WHERE r.tenant_id = ? AND r.user_id = ? AND r.deleted_at IS NULL
        ORDER BY r.room_id`,
      [tid, tid, userId],
    )
    const rooms = rows.map((r): ImSyncTuple => [
      Number(r.room_id),
      Number(r.period_id),
      Number(r.last_seq),
      Number(r.read_seq),
      Number(r.floor_seq),
      Number(r.meta_rev),
    ])
    return { epoch: await this.epoch(), rooms }
  }

  /** 给定会话的详情；不是本人当前会话的 id 缺省（客户端据此删除本地会话）。 */
  async details(ids: readonly number[], userId: number): Promise<ImRoomDetail[]> {
    return roomDetails(this.ds.manager, ids, userId)
  }

  private async epoch(): Promise<string> {
    return (await this.params.get(imParams.epoch)) ?? ''
  }
}

/**
 * 本人在给定会话里的详情（同步详情与建会话/群管理接口共用，后者在提交之后调用）。未读 = 可见区间内 `seq > read_seq`、可计类型、别人发的、未撤回的行数，封顶 100；
 * 预览 = 区间内最后一条不是编辑/撤回事件的行。
 */
export async function roomDetails(
  db: EntityManager,
  ids: readonly number[],
  userId: number,
): Promise<ImRoomDetail[]> {
  if (!ids.length) return []
  const tid = tenantId()
  const rows = await db.query<DetailRow[]>(
    `SELECT m.id AS room_id, r.id AS period_id, m.room_kind, m.label, m.pair_low_id, m.pair_high_id,
            m.closed_at, r.role_code, r.visible_from_seq, m.last_seq, r.read_seq, m.floor_seq,
            m.meta_rev, m.last_entry_at,
            (SELECT COUNT(*) FROM im_roster c
              WHERE c.tenant_id = ? AND c.room_id = m.id AND c.deleted_at IS NULL) AS member_count
       FROM im_roster r
       JOIN im_room m ON m.id = r.room_id AND m.tenant_id = ? AND m.deleted_at IS NULL
      WHERE r.tenant_id = ? AND r.user_id = ? AND r.room_id IN (?) AND r.deleted_at IS NULL
      ORDER BY m.id`,
    [tid, tid, tid, userId, [...new Set(ids)]],
  )
  const out: ImRoomDetail[] = []
  for (const r of rows) {
    const lastSeq = Number(r.last_seq)
    const readSeq = Number(r.read_seq)
    const floorSeq = Number(r.floor_seq)
    const visibleFromSeq = Number(r.visible_from_seq)
    const from = Math.max(visibleFromSeq, floorSeq)
    const peer =
      r.room_kind === 'direct'
        ? Number(r.pair_low_id) === userId
          ? Number(r.pair_high_id)
          : Number(r.pair_low_id)
        : undefined
    out.push({
      roomId: Number(r.room_id),
      periodId: Number(r.period_id),
      kind: r.room_kind,
      label: r.label,
      ...(peer ? { peerId: peer } : {}),
      memberCount: Number(r.member_count),
      closedAt: r.closed_at ? r.closed_at.toISOString() : null,
      role: r.role_code,
      visibleFromSeq,
      lastSeq,
      readSeq,
      floorSeq,
      metaRev: Number(r.meta_rev),
      lastAt: r.last_entry_at ? r.last_entry_at.toISOString() : null,
      unread: await unreadOf(db, Number(r.room_id), Math.max(readSeq + 1, from), lastSeq, userId),
      preview: await previewOf(db, Number(r.room_id), from, lastSeq),
    })
  }
  return out
}

/** `[from, to]` 里别人发的、可计类型、未撤回的行数（封顶 `IM_LIMITS.unreadCap`）。 */
async function unreadOf(
  db: EntityManager,
  roomId: number,
  from: number,
  to: number,
  userId: number,
): Promise<number> {
  if (from > to) return 0
  // 子查询 LIMIT 封顶：一个积压很多的会话也只数到 100 行
  const [row] = await db.query<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM (
       SELECT e.id FROM im_entry e
        WHERE e.tenant_id = ? AND e.room_id = ? AND e.seq BETWEEN ? AND ?
          AND e.entry_kind IN (?) AND e.author_id <> ? AND e.recalled_at IS NULL
          AND e.deleted_at IS NULL
        LIMIT ?) x`,
    [tenantId(), roomId, from, to, [...IM_COUNTED_KINDS], userId, IM_LIMITS.unreadCap],
  )
  return Number(row?.n ?? 0)
}

/** `[from, to]` 里最后一条不是编辑/撤回事件的行（只有这两种事件带 `target_seq`）。 */
async function previewOf(
  db: EntityManager,
  roomId: number,
  from: number,
  to: number,
): Promise<ImPreview | null> {
  if (from > to) return null
  const [e] = await db.query<PreviewRow[]>(
    `SELECT e.seq, e.entry_kind, e.author_id, e.author_label, e.text_value, e.sticker_code,
            e.event_data, e.recalled_at, e.created_at
       FROM im_entry e
      WHERE e.tenant_id = ? AND e.room_id = ? AND e.seq BETWEEN ? AND ? AND e.target_seq IS NULL
        AND e.deleted_at IS NULL
      ORDER BY e.seq DESC LIMIT 1`,
    [tenantId(), roomId, from, to],
  )
  if (!e) return null
  const recalled = e.recalled_at !== null
  const text =
    e.entry_kind === 'text' && !recalled && e.text_value !== null
      ? [...e.text_value].slice(0, IM_LIMITS.previewChars).join('')
      : null
  return {
    seq: Number(e.seq),
    kind: e.entry_kind,
    authorId: e.author_id === null ? null : Number(e.author_id),
    authorLabel: e.author_label,
    text,
    stickerCode: recalled ? null : e.sticker_code,
    eventCode: e.entry_kind === 'event' ? (e.event_data?.code ?? null) : null,
    recalled,
    at: e.created_at.toISOString(),
  }
}
