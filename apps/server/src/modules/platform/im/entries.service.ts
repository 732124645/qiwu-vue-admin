import { createHash } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  DEFAULT_IM_GROUP_RECALL_ANYTIME,
  Err,
  IM_INT_PARAMS,
  IM_LIMITS,
  imCodePoints,
  imEntryRef,
  imParams,
  RT,
  type ImAttachment,
  type ImEntries,
  type ImEntriesQuery,
  type ImEntry,
  type ImEntryEdit,
  type ImEntrySend,
  type ImFileQuery,
  type ImUpload,
} from '@qiwu/shared'
import type { DataSource, EntityManager } from 'typeorm'
import { softDeleteRows } from '../../../core/db/references.js'
import { canonicalJson } from '../../../core/guard/idempotent.js'
import { BizError } from '../../../core/http/biz-error.js'
import type { UploadedFileData } from '../../../core/http/upload.js'
import { RealtimeService } from '../../../core/realtime/realtime.service.js'
import { ParamService } from '../../../core/settings/param.service.js'
import { type Download, StorageService } from '../storage/storage.service.js'
import { ImEntryEntity, ImRosterEntity } from './entities/im.entity.js'
import {
  activeStaff,
  appendEntry,
  clampSeqs,
  entriesBetween,
  memberIds,
  requireMember,
  visibleEntry,
  visibleRange,
} from './im-access.js'
import { ImObjectsService, type ImPrepared } from './im-objects.service.js'
import { boolParam, intParam } from './sync.service.js'

const iso = (d: Date | null) => (d ? d.toISOString() : null)

/** 从原发送时刻起 `minutes` 分钟内（0 = 关闭）。 */
const within = (sentAt: Date, minutes: number) =>
  minutes > 0 && Date.now() - sentAt.getTime() <= minutes * 60_000

/** 一行的当前状态；`clientEntryId` 只回给作者本人。 */
export function entryVo(e: ImEntryEntity, userId: number): ImEntry {
  return {
    seq: e.seq,
    kind: e.entryKind,
    authorId: e.authorId,
    authorKind: e.authorKind,
    authorLabel: e.authorLabel,
    clientEntryId: e.authorId === userId ? e.clientEntryId : null,
    text: e.textValue,
    stickerCode: e.stickerCode,
    attachment: e.attachment,
    event: e.eventData,
    targetSeq: e.targetSeq,
    rev: e.contentRev,
    createdAt: e.createdAt.toISOString(),
    editedAt: iso(e.editedAt),
    recalledAt: iso(e.recalledAt),
    recalledBy: e.recalledBy,
  }
}

/** 发送内容的规范化摘要：同一个 clientEntryId 重发时据此判断是不是同一条。 */
const digestOf = (b: ImEntrySend) =>
  createHash('sha256')
    .update(
      canonicalJson({
        kind: b.kind,
        text: b.text ?? null,
        objectId: b.objectId ?? null,
        stickerCode: b.stickerCode ?? null,
        stickerId: b.stickerId ?? null,
      }),
    )
    .digest('hex')

/**
 * 消息（see docs/im.md）：列表夹在本人可见区间；发送在会话锁内按 `last_seq+1` 分配 seq，同一作者的
 * clientEntryId 用锁定读去重；编辑与撤回按当前角色与参数判断并追加 `entry.edit` / `entry.recall` 事件。
 * 事务里只用事务自己的连接（参数、姓名在事务前读）：并发发送时等锁的事务占着连接，事务里再向连接池要
 * 连接可能把池耗尽。
 */
@Injectable()
export class EntriesService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly params: ParamService,
    private readonly rt: RealtimeService,
    private readonly storage: StorageService,
    private readonly objects: ImObjectsService,
  ) {}

  /**
   * `afterSeq`（不含，向新）/ `beforeSeq`（不含，向旧）/ `seqs`（指定行，区间外静默缺省）/ 都不带 = 最新
   * 一页；结果升序，都夹在本人可见区间里。
   */
  async list(roomId: number, query: ImEntriesQuery, userId: number): Promise<ImEntries> {
    const db = this.ds.manager
    const m = await requireMember(db, roomId, userId)
    const range = visibleRange(m)
    const limit = query.limit ?? IM_LIMITS.entriesDefault
    let rows: ImEntryEntity[]
    let hasMore = false
    if (query.seqs) {
      const seqs = clampSeqs(m, query.seqs)
      rows = seqs.length
        ? (
            await db
              .getRepository(ImEntryEntity)
              .find({ where: seqs.map((seq) => ({ roomId, seq })) })
          ).sort((a, b) => a.seq - b.seq)
        : []
    } else if (query.afterSeq !== undefined) {
      rows = await entriesBetween(
        db,
        roomId,
        { from: Math.max(query.afterSeq + 1, range.from), to: range.to },
        limit + 1,
      )
      hasMore = rows.length > limit
      rows = rows.slice(0, limit)
    } else {
      const to = query.beforeSeq === undefined ? range.to : Math.min(query.beforeSeq - 1, range.to)
      rows = await entriesBetween(db, roomId, { from: range.from, to }, limit + 1, true)
      hasMore = rows.length > limit
      rows = rows.slice(0, limit).reverse()
    }
    return {
      items: rows.map((e) => entryVo(e, userId)),
      hasMore,
      lastSeq: m.room.lastSeq,
      floorSeq: m.room.floorSeq,
      visibleFromSeq: m.roster.visibleFromSeq,
    }
  }

  /** 上传图片或文件（当前成员、未解散）；限额与类型由文件服务判断。 */
  async upload(
    roomId: number,
    file: UploadedFileData | undefined,
    userId: number,
  ): Promise<ImUpload> {
    const m = await requireMember(this.ds.manager, roomId, userId)
    if (m.room.closedAt) throw new BizError(Err.IM_ROOM_CLOSED)
    return this.objects.upload(file, userId)
  }

  /** 语音上传与普通附件相同，先核对当前成员和房间状态。 */
  async uploadVoice(
    roomId: number,
    file: UploadedFileData | undefined,
    userId: number,
  ): Promise<ImUpload> {
    const m = await requireMember(this.ds.manager, roomId, userId)
    if (m.room.closedAt) throw new BizError(Err.IM_ROOM_CLOSED)
    return this.objects.uploadVoice(file, userId)
  }

  /**
   * 发送；同 clientEntryId 同内容返回原行当前状态，不同内容 B5008。先鉴权为成员（非成员拿到的只是
   * 404，查重在鉴权之后），再在锁外准备附件；事务里锁会话 → 复查成员、未解散、私聊对象仍是启用员工 →
   * 锁定读查 clientEntryId（并发的同 id 请求在会话锁上排队，进锁后看到先到者的行，返回同一 seq）→
   * 分配 seq、绑定附件对象 → 提交 → 提示。`@Idempotent()` 只挡 3 秒内的重复提交，跨会话与重启的幂等
   * 靠这里与唯一键。
   */
  async send(roomId: number, body: ImEntrySend, userId: number): Promise<ImEntry> {
    const repo = this.ds.getRepository(ImEntryEntity)
    await requireMember(this.ds.manager, roomId, userId)
    const digest = digestOf(body)
    // 已发成功的重发：附件对象已绑定，不能再准备一次，直接按原行回答
    const prior = await repo.findOneBy({
      roomId,
      authorId: userId,
      clientEntryId: body.clientEntryId,
    })
    if (prior) return this.replay(prior, digest, userId)
    if (body.kind === 'text') {
      const max = await intParam(this.params, IM_INT_PARAMS.textMaxChars)
      if (imCodePoints(body.text!) > max) throw new BizError(Err.VALIDATION_FAILED)
    }
    const me = (await activeStaff(this.ds.manager, [userId])).get(userId)
    let prepared: ImPrepared | null = null
    if (body.kind === 'image' || body.kind === 'file' || body.kind === 'voice')
      prepared = await this.objects.prepare({ kind: body.kind, objectId: body.objectId! }, userId)
    else if (body.kind === 'sticker' && body.stickerId !== undefined)
      prepared = await this.objects.prepare({ kind: 'sticker', stickerId: body.stickerId }, userId)
    const done = await this.ds.transaction(async (tx) => {
      const m = await requireMember(tx, roomId, userId, { lock: true })
      if (m.room.closedAt) throw new BizError(Err.IM_ROOM_CLOSED)
      if (m.room.roomKind === 'direct') {
        const peer = m.room.pairLowId === userId ? m.room.pairHighId! : m.room.pairLowId!
        if (!(await activeStaff(tx, [peer])).has(peer)) throw new BizError(Err.IM_USER_UNAVAILABLE)
      }
      const same = await tx.getRepository(ImEntryEntity).findOne({
        where: { roomId, authorId: userId, clientEntryId: body.clientEntryId },
        lock: { mode: 'pessimistic_write' },
      })
      if (same) return { entry: same, members: null }
      const entry = await appendEntry(
        tx,
        m.room,
        {
          entryKind: body.kind,
          authorId: userId,
          authorKind: 'admin',
          authorLabel: me?.displayName ?? null,
          clientEntryId: body.clientEntryId,
          requestDigest: digest,
          textValue: body.kind === 'text' ? body.text! : null,
          stickerCode: body.stickerCode ?? null,
          attachment: prepared?.attachment ?? null,
        },
        { touch: true },
      )
      // 一条消息一个对象：bindRefs 只取未绑定的本人对象，别人的、已绑定的整批 400 并回滚
      if (prepared)
        await this.storage.bindRefs(
          prepared.objectIds,
          'im.attachment',
          imEntryRef(roomId, entry.seq),
          userId,
          tx,
        )
      return { entry, members: await memberIds(tx, roomId) }
    })
    if (!done.members) return this.replay(done.entry, digest, userId)
    this.rt.toUsers(done.members, {
      type: RT.imEntry,
      payload: { roomId, seq: done.entry.seq, authorId: userId, kind: done.entry.entryKind },
    })
    return entryVo(done.entry, userId)
  }

  /** 编辑本人文字（编辑时间窗以原发送时刻计，编辑不延长）；返回目标行的新状态。 */
  async edit(roomId: number, seq: number, body: ImEntryEdit, userId: number): Promise<ImEntry> {
    const minutes = await intParam(this.params, IM_INT_PARAMS.editMinutes)
    const max = await intParam(this.params, IM_INT_PARAMS.textMaxChars)
    if (imCodePoints(body.text) > max) throw new BizError(Err.VALIDATION_FAILED)
    const done = await this.ds.transaction(async (tx) => {
      const m = await requireMember(tx, roomId, userId, { lock: true })
      if (m.room.closedAt) throw new BizError(Err.IM_ROOM_CLOSED)
      const entry = await visibleEntry(tx, m, seq, { lock: true })
      // 系统事件行、别人的、非文字、已撤回、超时间窗一律不可编辑（群主与 root 也一样）
      if (
        entry.entryKind !== 'text' ||
        entry.authorId !== userId ||
        entry.recalledAt ||
        !within(entry.createdAt, minutes)
      )
        throw new BizError(Err.IM_EDIT_DENIED)
      if (body.rev !== entry.contentRev) throw new BizError(Err.IM_REV_CONFLICT)
      const repo = tx.getRepository(ImEntryEntity)
      // 不留旧文：覆盖正文、修订号 +1
      await repo.update(
        { id: entry.id },
        { textValue: body.text, contentRev: entry.contentRev + 1, editedAt: new Date() },
      )
      const event = await appendEntry(
        tx,
        m.room,
        { entryKind: 'event', eventData: { code: 'entry.edit', actorId: userId }, targetSeq: seq },
        { touch: false },
      )
      return {
        target: await repo.findOneByOrFail({ id: entry.id }),
        seq: event.seq,
        members: await memberIds(tx, roomId),
      }
    })
    this.eventHint(roomId, done.seq, done.members)
    return entryVo(done.target, userId)
  }

  /**
   * 撤回（锁会话后按当前角色与当前参数判断）：系统事件行任何人不可撤回；本人在 `recall_minutes` 内；群里
   * 撤回他人：owner 任何人，moderator 只能撤回作者当前为 participant 的（作者已退群、被降级、停用或删除
   * 都算 participant）；`group_recall_anytime=false` 时同样受时间窗。已撤回再撤回返回原状态、不追加事件。
   * 撤回清内容与附件并在同一事务软删绑定的对象。
   */
  async recall(roomId: number, seq: number, userId: number): Promise<ImEntry> {
    const minutes = await intParam(this.params, IM_INT_PARAMS.recallMinutes)
    const anytime = await boolParam(
      this.params,
      imParams.groupRecallAnytime,
      DEFAULT_IM_GROUP_RECALL_ANYTIME,
    )
    const done = await this.ds.transaction(async (tx) => {
      const m = await requireMember(tx, roomId, userId, { lock: true })
      if (m.room.closedAt) throw new BizError(Err.IM_ROOM_CLOSED)
      const entry = await visibleEntry(tx, m, seq, { lock: true })
      if (entry.entryKind === 'event') throw new BizError(Err.IM_RECALL_DENIED)
      if (entry.recalledAt) return { target: entry, seq: null, members: [] }
      if (entry.authorId === userId) {
        // 群主、管理员撤回自己的消息也走本人时间窗
        if (!within(entry.createdAt, minutes)) throw new BizError(Err.IM_RECALL_DENIED)
      } else {
        const mine = m.roster.roleCode
        if (m.room.roomKind !== 'group' || mine === 'participant')
          throw new BizError(Err.IM_ROLE_REQUIRED)
        if (
          mine === 'moderator' &&
          (await this.currentRole(tx, roomId, entry.authorId)) !== 'participant'
        )
          throw new BizError(Err.IM_ROLE_REQUIRED)
        if (!anytime && !within(entry.createdAt, minutes)) throw new BizError(Err.IM_RECALL_DENIED)
      }
      const objectIds = attachmentObjects(entry.attachment)
      const repo = tx.getRepository(ImEntryEntity)
      await repo.update(
        { id: entry.id },
        {
          textValue: null,
          stickerCode: null,
          attachment: null,
          recalledAt: new Date(),
          recalledBy: userId,
        },
      )
      await softDeleteRows(tx, 'fs_object', objectIds)
      const event = await appendEntry(
        tx,
        m.room,
        {
          entryKind: 'event',
          eventData: { code: 'entry.recall', actorId: userId },
          targetSeq: seq,
        },
        { touch: false },
      )
      return {
        target: await repo.findOneByOrFail({ id: entry.id }),
        seq: event.seq,
        members: await memberIds(tx, roomId),
      }
    })
    if (done.seq !== null) this.eventHint(roomId, done.seq, done.members)
    return entryVo(done.target, userId)
  }

  /** 消息附件（当前成员、可见区间、未撤回、该行有附件），之后交给文件服务核对对象并输出。 */
  async file(roomId: number, seq: number, query: ImFileQuery, userId: number): Promise<Download> {
    const m = await requireMember(this.ds.manager, roomId, userId)
    const entry = await visibleEntry(this.ds.manager, m, seq)
    if (entry.recalledAt || !entry.attachment) throw new BizError(Err.IM_ENTRY_NOT_FOUND)
    return this.objects.serve(roomId, seq, entry.attachment, {
      thumb: query.thumb ?? false,
      proxy: query.proxy ?? false,
    })
  }

  /** 重发同一个 clientEntryId：内容相同返回原行当前状态，不同 B5008。 */
  private replay(prior: ImEntryEntity, digest: string, userId: number): ImEntry {
    if (prior.requestDigest !== digest) throw new BizError(Err.IM_CLIENT_ID_CONFLICT)
    return entryVo(prior, userId)
  }

  /**
   * 作者在会话里的当前角色：已退群、账号停用/删除或不再是员工都按 participant（moderator 可以撤回）。
   */
  private async currentRole(
    tx: EntityManager,
    roomId: number,
    authorId: number | null,
  ): Promise<string> {
    if (authorId === null) return 'participant'
    const roster = await tx.getRepository(ImRosterEntity).findOneBy({ roomId, userId: authorId })
    if (!roster || !(await activeStaff(tx, [authorId])).has(authorId)) return 'participant'
    return roster.roleCode
  }

  /** 编辑/撤回事件的提示（只有编号，永不带正文）。 */
  private eventHint(roomId: number, seq: number, members: number[]): void {
    this.rt.toUsers(members, {
      type: RT.imEntry,
      payload: { roomId, seq, authorId: null, kind: 'event' },
    })
  }
}

/** 一条消息绑定的文件对象（原图/文件与缩略图）。 */
const attachmentObjects = (a: ImAttachment | null): number[] =>
  a ? [a.objectId, ...(a.thumbObjectId ? [a.thumbObjectId] : [])] : []
