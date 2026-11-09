import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  Err,
  IM_INT_PARAMS,
  IM_LIMITS,
  RT,
  type ImEvent,
  type ImGroupCreate,
  type ImLabelChange,
  type ImMember,
  type ImRead,
  type ImRole,
  type ImRoleChange,
  type ImRoomDetail,
} from '@qiwu/shared'
import type { DataSource, EntityManager } from 'typeorm'
import { tenantId } from '../../../core/context/tenant.js'
import { BizError } from '../../../core/http/biz-error.js'
import { RealtimeService } from '../../../core/realtime/realtime.service.js'
import { ParamService } from '../../../core/settings/param.service.js'
import { ImRoomEntity, ImRosterEntity } from './entities/im.entity.js'
import {
  activeStaff,
  appendEntry,
  fitEvent,
  type ImMembership,
  memberIds,
  requireMember,
} from './im-access.js'
import { intParam, roomDetails } from './sync.service.js'
import { ImCallsService } from './im-calls.service.js'

/** 一次群管理的结果：要追加的系统事件（null = 没有变化）与被移出会话的用户（他们也要收到提示）。 */
interface Outcome {
  event: ImEvent | null
  removed?: number[]
}

const isDuplicate = (e: unknown) =>
  (e as { driverError?: { code?: string } })?.driverError?.code === 'ER_DUP_ENTRY'

/**
 * 私聊与群（see docs/im.md）：每个写操作锁会话行（事务第一条语句）→ 改成员/会话 → `meta_rev+1` → 追加
 * 系统事件 → 提交 → 发提示。私聊无成员管理与退出；群角色 owner/moderator/participant。
 * 事务里只用事务自己的连接（参数在事务前读）：并发写同一会话时等锁的事务占着连接，事务里再向连接池
 * 要连接可能把池耗尽。
 */
@Injectable()
export class RoomsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly params: ParamService,
    private readonly rt: RealtimeService,
    private readonly calls: ImCallsService,
  ) {}

  /**
   * 取或建与 peerId 的私聊（同一对员工唯一）。对象必须是本租户启用员工且不是自己（B5003）。不写创建事件，
   * 两人都从 seq 1 可见。并发建同一对：后到者的插入在唯一键上等先到者提交后得到重复键，改为重读。
   */
  async openDirect(peerId: number, userId: number): Promise<ImRoomDetail> {
    if (peerId === userId) throw new BizError(Err.IM_USER_UNAVAILABLE)
    const staff = await activeStaff(this.ds.manager, [userId, peerId])
    if (!staff.has(peerId)) throw new BizError(Err.IM_USER_UNAVAILABLE)
    const [low, high] = userId < peerId ? [userId, peerId] : [peerId, userId]
    let roomId = await this.findDirect(low, high)
    if (!roomId) {
      try {
        roomId = await this.ds.transaction(async (tx) => {
          const { identifiers } = await tx
            .getRepository(ImRoomEntity)
            .insert({ roomKind: 'direct', scopeCode: 'staff', pairLowId: low, pairHighId: high })
          const id = Number(identifiers[0]!.id)
          await tx.getRepository(ImRosterEntity).insert(
            [userId, peerId].map((uid) => ({
              roomId: id,
              userId: uid,
              roleCode: 'participant' as const,
              memberLabel: staff.get(uid)?.displayName ?? '',
              visibleFromSeq: 1,
            })),
          )
          return id
        })
        this.rt.toUsers([userId, peerId], { type: RT.imRoom, payload: { roomId } })
      } catch (e) {
        if (!isDuplicate(e)) throw e
        roomId = await this.findDirect(low, high)
        if (!roomId) throw e
      }
    }
    return this.detail(roomId, userId)
  }

  /** 建群，创建者为群主、其余为成员；人数含群主，超过参数上限 B5005。 */
  async createGroup(body: ImGroupCreate, userId: number): Promise<ImRoomDetail> {
    if (body.userIds.includes(userId)) throw new BizError(Err.IM_USER_UNAVAILABLE)
    const max = await intParam(this.params, IM_INT_PARAMS.groupMaxMembers)
    if (body.userIds.length + 1 > max) throw new BizError(Err.IM_MEMBER_LIMIT, { max })
    const { roomId, members } = await this.ds.transaction(async (tx) => {
      const staff = await activeStaff(tx, [userId, ...body.userIds])
      if (body.userIds.some((id) => !staff.has(id))) throw new BizError(Err.IM_USER_UNAVAILABLE)
      const { identifiers } = await tx
        .getRepository(ImRoomEntity)
        .insert({ roomKind: 'group', scopeCode: 'staff', label: body.label })
      const id = Number(identifiers[0]!.id)
      const room = await tx.getRepository(ImRoomEntity).findOneByOrFail({ id })
      await tx.getRepository(ImRosterEntity).insert(
        [userId, ...body.userIds].map((uid) => ({
          roomId: id,
          userId: uid,
          roleCode: (uid === userId ? 'owner' : 'participant') as ImRole,
          memberLabel: staff.get(uid)?.displayName ?? '',
          // 建群事件就是第 1 条
          visibleFromSeq: 1,
        })),
      )
      await appendEntry(
        tx,
        room,
        {
          entryKind: 'event',
          eventData: fitEvent(
            {
              code: 'room.create',
              actorId: userId,
              label: body.label,
              users: body.userIds.map((uid) => ({ id: uid, name: staff.get(uid)!.displayName })),
            },
            IM_LIMITS.eventDataMaxBytes,
          ),
        },
        { touch: true },
      )
      return { roomId: id, members: [userId, ...body.userIds] }
    })
    this.hint(roomId, 1, members, [])
    return this.detail(roomId, userId)
  }

  /** 当前成员列表（群主、管理员在前）。用户已删除时显示入会时的姓名快照，`enabled` 为 false。 */
  async members(roomId: number, userId: number): Promise<ImMember[]> {
    await requireMember(this.ds.manager, roomId, userId)
    const tid = tenantId()
    const rows = await this.ds.query<
      {
        user_id: number
        role_code: ImRole
        member_label: string
        display_name: string | null
        avatar_url: string | null
        enabled: number | null
        user_type: string | null
      }[]
    >(
      // qw:no-data-scope 聊天成员的姓名与头像对同会话员工开放，不套用管理数据范围
      `SELECT r.user_id, r.role_code, r.member_label, u.display_name, u.avatar_url, u.enabled, u.user_type
         FROM im_roster r
         LEFT JOIN iam_user u ON u.id = r.user_id AND u.tenant_id = ? AND u.deleted_at IS NULL
        WHERE r.tenant_id = ? AND r.room_id = ? AND r.deleted_at IS NULL
        ORDER BY FIELD(r.role_code, 'owner', 'moderator', 'participant'), r.id`,
      [tid, tid, roomId],
    )
    return rows.map((r) => ({
      userId: Number(r.user_id),
      role: r.role_code,
      displayName: r.display_name ?? r.member_label,
      avatarUrl: r.avatar_url,
      enabled: Number(r.enabled) === 1 && r.user_type === 'admin',
    }))
  }

  /** 加人（owner/moderator）；已在群里的忽略，新成员从加入事件起可见；人数锁内校验。 */
  async addMembers(
    roomId: number,
    userIds: readonly number[],
    userId: number,
  ): Promise<ImRoomDetail> {
    if (userIds.includes(userId)) throw new BizError(Err.IM_USER_UNAVAILABLE)
    const max = await intParam(this.params, IM_INT_PARAMS.groupMaxMembers)
    await this.mutate(roomId, userId, async (tx, m, rosters) => {
      if (m.roster.roleCode === 'participant') throw new BizError(Err.IM_ROLE_REQUIRED)
      const present = new Set(rosters.map((r) => r.userId))
      const fresh = userIds.filter((id) => !present.has(id))
      if (!fresh.length) return { event: null }
      const staff = await activeStaff(tx, fresh)
      if (fresh.some((id) => !staff.has(id))) throw new BizError(Err.IM_USER_UNAVAILABLE)
      // 调小上限只拒新增，不踢已有成员
      if (rosters.length + fresh.length > max) throw new BizError(Err.IM_MEMBER_LIMIT, { max })
      await tx.getRepository(ImRosterEntity).insert(
        fresh.map((uid) => ({
          roomId,
          userId: uid,
          roleCode: 'participant' as const,
          memberLabel: staff.get(uid)!.displayName,
          // 新时期从加入事件那一条起可见，看不到加入前（含离开期间）的内容
          visibleFromSeq: m.room.lastSeq + 1,
        })),
      )
      return {
        event: {
          code: 'member.add',
          actorId: userId,
          users: fresh.map((uid) => ({ id: uid, name: staff.get(uid)!.displayName })),
        },
      }
    })
    return this.detail(roomId, userId)
  }

  /** 移人（owner 可移任何其他人，moderator 只能移 participant）。 */
  async removeMember(roomId: number, targetId: number, userId: number): Promise<ImRoomDetail> {
    if (targetId === userId) throw new BizError(Err.IM_ROLE_REQUIRED)
    await this.mutate(roomId, userId, async (tx, m, rosters) => {
      const mine = m.roster.roleCode
      if (mine === 'participant') throw new BizError(Err.IM_ROLE_REQUIRED)
      const target = rosters.find((r) => r.userId === targetId)
      if (!target) throw new BizError(Err.IM_USER_UNAVAILABLE)
      if (mine === 'moderator' && target.roleCode !== 'participant')
        throw new BizError(Err.IM_ROLE_REQUIRED)
      await tx.getRepository(ImRosterEntity).softDelete({ id: target.id })
      return {
        event: {
          code: 'member.remove',
          actorId: userId,
          users: [{ id: targetId, name: target.memberLabel }],
        },
        removed: [targetId],
      }
    })
    return this.detail(roomId, userId)
  }

  /**
   * 退群；群主还有其他成员时 B5006（先转让），只剩自己时退群即解散。已解散的群任何成员都可以退。
   */
  async leave(roomId: number, userId: number): Promise<void> {
    await this.mutate(
      roomId,
      userId,
      async (tx, m, rosters) => {
        const alone = rosters.length === 1
        if (m.roster.roleCode === 'owner' && !m.room.closedAt && !alone)
          throw new BizError(Err.IM_OWNER_TRANSFER_REQUIRED)
        await tx.getRepository(ImRosterEntity).softDelete({ id: m.roster.id })
        if (alone && !m.room.closedAt) {
          m.room.closedAt = new Date()
          await tx.getRepository(ImRoomEntity).update({ id: roomId }, { closedAt: m.room.closedAt })
          return { event: { code: 'room.close', actorId: userId }, removed: [userId] }
        }
        return {
          event: {
            code: 'member.leave',
            actorId: userId,
            users: [{ id: userId, name: m.roster.memberLabel }],
          },
          removed: [userId],
        }
      },
      { allowClosed: true },
    )
  }

  /**
   * 转让群主：群主本人；群主账号已停用/删除/不再是员工时，任一 moderator（没有 moderator 时任一成员）
   * 也可以（锁内判断，不挂 iam 钩子）。新群主必须是当前成员且是启用员工；原群主改为普通成员。
   */
  async transferOwner(roomId: number, targetId: number, userId: number): Promise<ImRoomDetail> {
    await this.mutate(roomId, userId, async (tx, m, rosters) => {
      const owner = rosters.find((r) => r.roleCode === 'owner')
      const target = rosters.find((r) => r.userId === targetId)
      const moderators = rosters.filter((r) => r.roleCode === 'moderator').map((r) => r.userId)
      const staff = await activeStaff(tx, [
        targetId,
        ...(owner ? [owner.userId] : []),
        ...moderators,
      ])
      if (!target || !staff.has(targetId)) throw new BizError(Err.IM_USER_UNAVAILABLE)
      const mine = m.roster.roleCode
      if (mine !== 'owner') {
        const ownerGone = !owner || !staff.has(owner.userId)
        // 只算仍是启用员工的 moderator：都已停用时普通成员也能接手，群不会无人可管
        const hasModerator = moderators.some((id) => staff.has(id))
        if (!ownerGone || (mine !== 'moderator' && hasModerator))
          throw new BizError(Err.IM_ROLE_REQUIRED)
      }
      // 角色检查之后才判“已是群主”：无权者不能借这个空操作探测谁是群主
      if (owner?.userId === targetId) return { event: null }
      const repo = tx.getRepository(ImRosterEntity)
      // 先降原群主再升新群主：每个会话至多一个群主由唯一键保证
      if (owner) await repo.update({ id: owner.id }, { roleCode: 'participant' })
      await repo.update({ id: target.id }, { roleCode: 'owner' })
      return {
        event: {
          code: 'owner.transfer',
          actorId: userId,
          users: [
            ...(owner ? [{ id: owner.userId, name: owner.memberLabel }] : []),
            { id: targetId, name: target.memberLabel },
          ],
        },
      }
    })
    return this.detail(roomId, userId)
  }

  /** 设管理员或取消（仅 owner；不能改自己与群主）。 */
  async setRole(
    roomId: number,
    targetId: number,
    body: ImRoleChange,
    userId: number,
  ): Promise<ImRoomDetail> {
    await this.mutate(roomId, userId, async (tx, m, rosters) => {
      if (m.roster.roleCode !== 'owner' || targetId === userId)
        throw new BizError(Err.IM_ROLE_REQUIRED)
      const target = rosters.find((r) => r.userId === targetId)
      if (!target) throw new BizError(Err.IM_USER_UNAVAILABLE)
      if (target.roleCode === body.role) return { event: null }
      await tx.getRepository(ImRosterEntity).update({ id: target.id }, { roleCode: body.role })
      return {
        event: {
          code: 'role.change',
          actorId: userId,
          users: [{ id: targetId, name: target.memberLabel }],
          role: body.role,
        },
      }
    })
    return this.detail(roomId, userId)
  }

  /** 改群名（owner/moderator）。 */
  async rename(roomId: number, body: ImLabelChange, userId: number): Promise<ImRoomDetail> {
    await this.mutate(roomId, userId, async (tx, m) => {
      if (m.roster.roleCode === 'participant') throw new BizError(Err.IM_ROLE_REQUIRED)
      if (m.room.label === body.label) return { event: null }
      await tx.getRepository(ImRoomEntity).update({ id: roomId }, { label: body.label })
      return { event: { code: 'room.rename', actorId: userId, label: body.label } }
    })
    return this.detail(roomId, userId)
  }

  /** 解散（仅 owner）：写 `closed_at`，成员仍可读保留期内历史、可退群，不能再发送或管理。 */
  async close(roomId: number, userId: number): Promise<ImRoomDetail> {
    await this.mutate(roomId, userId, async (tx, m) => {
      if (m.roster.roleCode !== 'owner') throw new BizError(Err.IM_ROLE_REQUIRED)
      await tx.getRepository(ImRoomEntity).update({ id: roomId }, { closedAt: new Date() })
      return { event: { code: 'room.close', actorId: userId } }
    })
    return this.detail(roomId, userId)
  }

  /**
   * 读位置只增，且不超过会话的 lastSeq：先普通读会话的 last_seq，再单表条件更新（两个常量，不写多表
   * UPDATE）；变化时给本人发 `im:room {roomId, readSeq}`（别的设备据此零请求更新）。
   */
  async read(roomId: number, seq: number, userId: number): Promise<ImRead> {
    const m = await requireMember(this.ds.manager, roomId, userId)
    const tid = tenantId()
    await this.ds.query(
      `UPDATE im_roster SET read_seq = GREATEST(read_seq, LEAST(?, ?))
        WHERE tenant_id = ? AND room_id = ? AND user_id = ? AND deleted_at IS NULL`,
      [seq, m.room.lastSeq, tid, roomId, userId],
    )
    const [row] = await this.ds.query<{ read_seq: number }[]>(
      `SELECT r.read_seq FROM im_roster r
        WHERE r.tenant_id = ? AND r.room_id = ? AND r.user_id = ? AND r.deleted_at IS NULL`,
      [tid, roomId, userId],
    )
    // 两步之间被移出会话：与非成员一样
    if (!row) throw new BizError(Err.IM_ROOM_NOT_FOUND)
    const readSeq = Number(row.read_seq)
    if (readSeq !== m.roster.readSeq)
      this.rt.toUser(userId, { type: RT.imRoom, payload: { roomId, readSeq } })
    return { readSeq }
  }

  /**
   * 群管理的公共流程：锁会话 → 复查当前成员 → 只限群、未解散（`allowClosed` 除外）→ `act` 改成员或会话
   * → 有变化时追加系统事件并 `meta_rev+1` → 提交 → 给受影响用户（现成员与被移出者）发 `im:room`、给
   * 现成员发 `im:entry`。
   */
  private async mutate(
    roomId: number,
    userId: number,
    act: (tx: EntityManager, m: ImMembership, rosters: ImRosterEntity[]) => Promise<Outcome>,
    opts: { allowClosed?: boolean } = {},
  ): Promise<void> {
    const done = await this.ds.transaction(async (tx) => {
      const m = await requireMember(tx, roomId, userId, { lock: true })
      // 私聊没有成员管理与退出
      if (m.room.roomKind !== 'group') throw new BizError(Err.IM_ROLE_REQUIRED)
      if (m.room.closedAt && !opts.allowClosed) throw new BizError(Err.IM_ROOM_CLOSED)
      const rosters = await tx.getRepository(ImRosterEntity).find({ where: { roomId } })
      const out = await act(tx, m, rosters)
      if (!out.event) return null
      const changedCalls = await this.calls.membershipChanged(
        tx,
        roomId,
        out.removed ?? [],
        out.event.code === 'room.close',
      )
      const entry = await appendEntry(
        tx,
        m.room,
        { entryKind: 'event', eventData: fitEvent(out.event, IM_LIMITS.eventDataMaxBytes) },
        { touch: true, meta: true },
      )
      return {
        seq: entry.seq,
        members: await memberIds(tx, roomId),
        removed: out.removed ?? [],
        changedCalls,
      }
    })
    if (done) {
      this.hint(roomId, done.seq, done.members, done.removed)
      for (const id of done.changedCalls) await this.calls.hint(id)
    }
  }

  /** 提交后的提示：`im:room` 给现成员与被移出者，`im:entry` 给现成员（只有编号，永不带正文）。 */
  private hint(roomId: number, seq: number, members: number[], removed: number[]): void {
    this.rt.toUsers([...new Set([...members, ...removed])], {
      type: RT.imRoom,
      payload: { roomId },
    })
    this.rt.toUsers(members, {
      type: RT.imEntry,
      payload: { roomId, seq, authorId: null, kind: 'event' },
    })
  }

  /** 按（较小 id，较大 id）找同一对员工的唯一私聊。 */
  private async findDirect(low: number, high: number): Promise<number | undefined> {
    const room = await this.ds
      .getRepository(ImRoomEntity)
      .findOneBy({ scopeCode: 'staff', pairLowId: low, pairHighId: high })
    return room?.id
  }

  /** 提交之后本人视角的会话详情。 */
  private async detail(roomId: number, userId: number): Promise<ImRoomDetail> {
    const [d] = await roomDetails(this.ds.manager, [roomId], userId)
    if (!d) throw new BizError(Err.IM_ROOM_NOT_FOUND)
    return d
  }
}
