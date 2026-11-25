import { randomUUID } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  Err,
  FIRST_PARTY_CLIENTS,
  IM_CALL_LIMITS,
  RT,
  imParams,
  type ImCall,
  type ImCallCreate,
  type ImCallEndReason,
} from '@qiwu/shared'
import { In, Not, type DataSource, type EntityManager } from 'typeorm'
import type { Principal } from '../../../core/auth/principal.js'
import { SessionCurrent } from '../../../core/auth/session-current.js'
import { SessionRevoker } from '../../../core/auth/session-revoker.js'
import { TENANT_LOOKUP, type TenantLookup } from '../../../core/auth/tenant-lookup.js'
import {
  APP_SESSION_EXPIRED,
  appSessionDays,
  appSessionExpiry,
  isAppSession,
  TokenService,
  type Session,
} from '../../../core/auth/token.service.js'
import { AppConfigService } from '../../../core/config/config.module.js'
import { allTenants, tenantId, withTenant } from '../../../core/context/tenant.js'
import { BizError } from '../../../core/http/biz-error.js'
import { RealtimeService } from '../../../core/realtime/realtime.service.js'
import { ParamService } from '../../../core/settings/param.service.js'
import { ImCallEntity, ImCallMemberEntity } from './entities/im-call.entity.js'
import { ImRoomEntity, ImRosterEntity } from './entities/im.entity.js'
import { activeStaff, appendEntry, memberIds, requireMember } from './im-access.js'
import { ImMediaGateway, ImMediaGatewayError } from './im-media-gateway.js'

type State = { call: ImCallEntity; members: ImCallMemberEntity[]; room: ImRoomEntity }
type Action = 'accept' | 'decline' | 'leave' | 'end' | 'heartbeat'
class SessionMoved extends Error {}
const open = (c: ImCallEntity) => c.state === 'ringing' || c.state === 'active'
const iso = (date: Date | null) => date?.toISOString() ?? null

/** 只停止调用方等待，不伪称底层工作已取消；调用方必须保留退场责任，不能遗弃业务事务。 */
export function awaitImCallStage<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) reject(signal.reason)
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}

/** 通话的业务状态与媒体状态分离；每次写事务都先锁原聊天房间，网络和有吊销副作用的认证在事务外。 */
@Injectable()
export class ImCallsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly params: ParamService,
    private readonly tokens: TokenService,
    private readonly current: SessionCurrent,
    private readonly revoker: SessionRevoker,
    @Inject(TENANT_LOOKUP) private readonly tenants: TenantLookup,
    private readonly cfg: AppConfigService,
    private readonly gateway: ImMediaGateway,
    private readonly rt: RealtimeService,
  ) {}

  /** 套餐外的开关仍由路由判断；这个参数关闭时只停止新调用，不停止清理。 */
  async enabled(): Promise<boolean> {
    return (
      this.cfg.get('APP_IM') && (await this.params.get(imParams.callEnabled))?.trim() === 'true'
    )
  }

  /** 事务外真实复核，包含当前员工/租户与按当前参数计算的 App 期限。 */
  async qualified(sid: string, signal?: AbortSignal): Promise<Session | null> {
    signal?.throwIfAborted()
    let session: Session | null
    try {
      // 已进入认证的吊销清理仍按既有语义完成；信号只禁止返回后再进入下一业务阶段。
      const loaded = await this.tokens.load(sid)
      signal?.throwIfAborted()
      session = loaded ? await this.current.current(loaded) : null
      signal?.throwIfAborted()
    } catch {
      signal?.throwIfAborted()
      return null
    }
    if (
      !session?.userId ||
      !(FIRST_PARTY_CLIENTS as readonly string[]).includes(session.clientId) ||
      session.userType !== 'admin' ||
      session.flags.mustChangePassword ||
      session.flags.passwordExpired ||
      (session.features !== undefined && !session.features.includes('im'))
    )
      return null
    const active = await this.tenants.active(session.tenantId!)
    signal?.throwIfAborted()
    if (!active) return null
    if (isAppSession(session)) {
      const days = await appSessionDays(this.params)
      signal?.throwIfAborted()
      if (Date.now() >= appSessionExpiry(session, days, Date.now())) {
        await this.revoker.revokeSession(sid, APP_SESSION_EXPIRED)
        signal?.throwIfAborted()
        return null
      }
    }
    const staff = await activeStaff(this.ds.manager, [session.userId])
    signal?.throwIfAborted()
    if (!staff.has(session.userId)) return null
    return session
  }

  /** 从请求主体取真实会话；没有第一方 sid 的凭据不能换取媒体票据。 */
  private async actor(principal: Principal): Promise<Session> {
    const session = principal.sid ? await this.qualified(principal.sid) : null
    if (!session || session.userId !== principal.userId || session.tenantId !== tenantId())
      throw new BizError(Err.UNAUTHENTICATED)
    return session
  }

  /** 本人的未终局通话；其它房间成员不能借列表探测未被邀请的通话。 */
  async active(principal: Principal): Promise<ImCall[]> {
    const actor = await this.actor(principal)
    const ids = await this.ds.query<{ id: number }[]>(
      `SELECT c.id FROM im_call c JOIN im_call_member m ON m.call_id=c.id AND m.tenant_id=c.tenant_id
       WHERE c.tenant_id=? AND m.user_id=? AND c.state_code <> 'ended' AND c.deleted_at IS NULL AND m.deleted_at IS NULL ORDER BY c.id DESC LIMIT 100`,
      [tenantId(), actor.userId],
    )
    const result: ImCall[] = []
    for (const call of ids) {
      try {
        result.push(await this.readFor(Number(call.id), actor))
      } catch (error) {
        if (!(error instanceof BizError) || error.err.code !== Err.IM_CALL_NOT_FOUND.code)
          throw error
      }
    }
    return result
  }

  /** 读取只回业务元数据，成员时期失效、未被邀请或跨租户都相同 404。 */
  async get(id: number, principal: Principal): Promise<ImCall> {
    return this.readFor(id, await this.actor(principal))
  }

  private async readFor(id: number, actor: Session): Promise<ImCall> {
    const state = await this.readState(this.ds.manager, id)
    await this.requireParticipant(this.ds.manager, state, actor.userId!)
    return this.vo(state, actor)
  }

  /** 同房间的创建串行化，同请求返回原通话；未知创建与 ending 都占用原房间槽。 */
  async create(roomId: number, body: ImCallCreate, principal: Principal): Promise<ImCall> {
    const actor = await this.actor(principal)
    await requireMember(this.ds.manager, roomId, actor.userId!)
    if (!(await this.enabled()) || !this.gateway.configured())
      throw new BizError(Err.IM_CALL_UNAVAILABLE)
    let callId: number
    try {
      callId = await this.ds.transaction(async (tx) => {
        const membership = await requireMember(tx, roomId, actor.userId!, { lock: true })
        if (membership.room.scopeCode !== 'staff') throw new BizError(Err.IM_ROOM_NOT_FOUND)
        if (!(await this.current.unchanged(actor))) throw new SessionMoved()
        if (membership.room.closedAt) throw new BizError(Err.IM_ROOM_CLOSED)
        const ids =
          membership.room.roomKind === 'direct'
            ? [
                membership.room.pairLowId === actor.userId
                  ? membership.room.pairHighId!
                  : membership.room.pairLowId!,
              ]
            : body.userIds
        if (
          !ids?.length ||
          ids.includes(actor.userId!) ||
          (membership.room.roomKind === 'direct' && body.userIds !== undefined)
        )
          throw new BizError(Err.VALIDATION_FAILED)
        const original = await tx
          .getRepository(ImCallEntity)
          .findOneBy({ roomId, callerId: actor.userId!, clientCallId: body.clientCallId })
        if (original) {
          const prior = await this.readState(tx, original.id)
          await this.requireParticipant(tx, prior, actor.userId!)
          const old = prior.members
            .filter((m) => m.userId !== actor.userId)
            .map((m) => m.userId)
            .sort((a, b) => a - b)
          if (
            original.mode !== body.mode ||
            JSON.stringify(old) !== JSON.stringify([...ids].sort((a, b) => a - b))
          )
            throw new BizError(Err.IM_CLIENT_ID_CONFLICT)
          return original.id
        }
        if (await tx.getRepository(ImCallEntity).existsBy({ roomId, state: Not('ended') }))
          throw new BizError(Err.IM_CALL_CONFLICT)
        const users = [actor.userId!, ...ids]
        const staff = await activeStaff(tx, users)
        const rosters = await tx
          .getRepository(ImRosterEntity)
          .find({ where: { roomId, userId: In(users) } })
        if (staff.size !== users.length || rosters.length !== users.length)
          throw new BizError(Err.IM_USER_UNAVAILABLE)
        const now = new Date()
        const insert = await tx.getRepository(ImCallEntity).insert({
          roomId,
          callerId: actor.userId!,
          clientCallId: body.clientCallId,
          mode: body.mode,
          state: 'ringing',
          mediaRoom: `qw_im_t${tenantId()}_${randomUUID()}`,
          mediaStatus: 'intent',
          mediaOperationId: randomUUID(),
          createInFlight: false,
          createStartedAt: null,
          checkedAt: now,
          inviteExpiresAt: new Date(now.getTime() + IM_CALL_LIMITS.inviteSeconds * 1000),
          startedAt: null,
          endingAt: null,
          endedAt: null,
          endReason: null,
          rev: 1,
          summarySeq: null,
        })
        const id = Number(insert.identifiers[0]!.id)
        await tx.getRepository(ImCallMemberEntity).insert(
          users.map((userId) => ({
            callId: id,
            userId,
            rosterId: rosters.find((r) => r.userId === userId)!.id,
            sid: userId === actor.userId ? actor.sid : null,
            state: userId === actor.userId ? ('accepted' as const) : ('invited' as const),
            displayName: staff.get(userId)!.displayName,
            identity: `u_${userId}`,
            lastSeenAt: userId === actor.userId ? now : null,
          })),
        )
        return id
      })
    } catch (error) {
      if (error instanceof SessionMoved) throw new BizError(Err.UNAUTHENTICATED)
      throw error
    }
    await this.hint(callId)
    await this.reconcile(callId)
    return this.readFor(callId, actor)
  }

  /** 接听/重接只绑定第一个有效 sid；其它动作严格依照当前成员状态，不隐式恢复 left。 */
  async act(id: number, action: Action, principal: Principal): Promise<ImCall> {
    const actor = await this.actor(principal)
    // 认证先在锁外完成；reconcile 也不把完整认证带入房间事务。
    const authorized = await this.readFor(id, actor)
    if (action === 'accept' && (!(await this.enabled()) || !this.gateway.configured()))
      throw new BizError(Err.IM_CALL_UNAVAILABLE)
    let changed: boolean
    try {
      changed = await this.ds.transaction(async (tx) => {
        const state = await this.lockState(tx, id, authorized.roomId)
        const me = await this.requireParticipant(tx, state, actor.userId!)
        if (!(await this.current.unchanged(actor))) throw new SessionMoved()
        const call = state.call
        if (me.sid && me.sid !== actor.sid && (action !== 'decline' || me.state !== 'invited'))
          throw new BizError(Err.IM_CALL_SESSION)
        if (!open(call)) {
          if (
            (action === 'end' && call.callerId === actor.userId) ||
            (action === 'leave' && me.state === 'left')
          )
            return false
          throw new BizError(Err.IM_CALL_STATE)
        }
        if (action === 'accept') {
          if (call.inviteExpiresAt.getTime() <= Date.now() && call.state === 'ringing') {
            this.ending(state, 'no_answer')
            await this.save(tx, state)
            return true
          }
          const rejoin =
            me.state === 'left' &&
            state.room.roomKind === 'group' &&
            call.state === 'active' &&
            me.sid === actor.sid
          if (me.state !== 'invited' && me.state !== 'accepted' && !rejoin)
            throw new BizError(Err.IM_CALL_STATE)
          // 同一设备重复接听只刷新存活时间，不触发全体客户端重新拉取。
          const alreadyAccepted = me.state === 'accepted'
          me.state = 'accepted'
          me.sid = actor.sid
          me.lastSeenAt = new Date()
          await tx.getRepository(ImCallMemberEntity).save(me)
          if (alreadyAccepted) return false
          const count = state.members.filter((m) => m.state === 'accepted').length
          if (count >= 2 && call.state === 'ringing') {
            call.state = 'active'
            call.startedAt = new Date()
          }
        } else if (action === 'decline') {
          if (me.state === 'declined') return false
          if (me.state !== 'invited') throw new BizError(Err.IM_CALL_STATE)
          me.state = 'declined'
          await tx.getRepository(ImCallMemberEntity).save(me)
          if (
            !state.members.some((m) => m.state === 'invited') &&
            state.members.filter((m) => m.state === 'accepted').length < 2
          )
            this.ending(state, 'declined')
        } else {
          if (
            me.sid !== actor.sid ||
            (me.state !== 'accepted' && !(action === 'leave' && me.state === 'left'))
          )
            throw new BizError(Err.IM_CALL_STATE)
          if (action === 'leave' && me.state === 'left') return false
          if (action === 'heartbeat') {
            // 心跳是成员存活信息，不改变公开通话版本，也不广播业务状态提示。
            me.lastSeenAt = new Date()
            await tx.getRepository(ImCallMemberEntity).save(me)
            return false
          } else if (action === 'end') {
            if (call.callerId !== actor.userId) throw new BizError(Err.IM_CALL_STATE)
            this.ending(state, 'ended')
          } else {
            me.state = 'left'
            if (
              call.callerId === actor.userId ||
              state.room.roomKind === 'direct' ||
              state.members.filter((m) => m.state === 'accepted').length < 2
            )
              this.ending(state, 'left')
          }
          await tx.getRepository(ImCallMemberEntity).save(me)
        }
        await this.save(tx, state)
        return true
      })
    } catch (error) {
      if (!(error instanceof SessionMoved)) throw error
      await this.markEnding(id, 'session_ended')
      throw new BizError(Err.UNAUTHENTICATED)
    }
    if (changed) await this.hint(id)
    if (action !== 'heartbeat') await this.reconcile(id)
    return this.readFor(id, actor)
  }

  /** 锁外签名，返回前再次真实认证；失效票据绝不能返回调用方。 */
  async join(id: number, principal: Principal) {
    const actor = await this.actor(principal)
    const authorized = await this.readFor(id, actor)
    if (!(await this.enabled()) || !this.gateway.configured())
      throw new BizError(Err.IM_CALL_UNAVAILABLE)
    await this.reconcile(id)
    let signed: { room: string; identity: string; name: string; mode: ImCallEntity['mode'] }
    try {
      signed = await this.ds.transaction(async (tx) => {
        const state = await this.lockState(tx, id, authorized.roomId)
        const me = await this.requireParticipant(tx, state, actor.userId!)
        if (me.sid !== actor.sid) throw new BizError(Err.IM_CALL_SESSION)
        if (me.state !== 'accepted' || !open(state.call)) throw new BizError(Err.IM_CALL_STATE)
        if (!(await this.current.unchanged(actor))) throw new SessionMoved()
        if (state.call.mediaStatus !== 'ready' || state.call.createInFlight)
          throw new BizError(Err.IM_CALL_UNAVAILABLE)
        return {
          room: state.call.mediaRoom,
          identity: me.identity,
          name: me.displayName,
          mode: state.call.mode,
        }
      })
    } catch (error) {
      if (!(error instanceof SessionMoved)) throw error
      await this.markEnding(id, 'session_ended')
      throw new BizError(Err.UNAUTHENTICATED)
    }
    let grant: Awaited<ReturnType<ImMediaGateway['grant']>>
    try {
      grant = await this.gateway.grant(signed.room, signed.identity, signed.name, signed.mode)
    } catch {
      throw new BizError(Err.IM_CALL_UNAVAILABLE)
    }
    const latest = await this.qualified(actor.sid)
    if (!latest || latest.userId !== actor.userId || !(await this.enabled())) {
      await this.markEnding(id, 'session_ended')
      throw new BizError(Err.UNAUTHENTICATED)
    }
    // 签名等待期间的退群、结束或其它设备接听也须在返回前重新核对。
    let call: ImCall
    try {
      call = await this.readFor(id, latest)
      if (!call.canJoin) throw new BizError(Err.IM_CALL_STATE)
    } catch (error) {
      await this.markEnding(id, 'membership_changed')
      throw error
    }
    return { ...grant, call }
  }

  /** 成员更改事务已经持有房间锁，直接标结束意图，不在这里做网络或完整会话认证。 */
  async membershipChanged(
    tx: EntityManager,
    roomId: number,
    removed: readonly number[],
    closed: boolean,
  ): Promise<number[]> {
    const calls = await tx
      .getRepository(ImCallEntity)
      .find({ where: { roomId, state: Not('ended') } })
    const changed: number[] = []
    for (const call of calls) {
      const members = await tx.getRepository(ImCallMemberEntity).findBy({ callId: call.id })
      if (!closed && !members.some((m) => removed.includes(m.userId))) continue
      if (!open(call)) continue
      call.state = 'ending'
      call.endReason ??= 'membership_changed'
      call.endingAt ??= new Date()
      call.rev++
      await tx.getRepository(ImCallEntity).save(call)
      changed.push(call.id)
    }
    return changed
  }

  /** sid 结束后只持久化结束意图；持续清理负责网络，钩子失败不能复活认证凭据。 */
  async sessionEnded(sid: string): Promise<void> {
    // qw:cross-tenant sid 为服务器生成的全局会话编号，结束通知可能已经没有会话所属租户。
    const rows = await allTenants(() =>
      this.ds.query<{ tenant_id: number; call_id: number }[]>(
        // qw:cross-tenant 全局 sid 已结束，只找其参与的租户/通话编号，不返回成员详情。
        `SELECT DISTINCT m.tenant_id,m.call_id FROM im_call_member m JOIN im_call c ON c.id=m.call_id AND c.tenant_id=m.tenant_id
       WHERE m.sid=? AND m.deleted_at IS NULL AND c.deleted_at IS NULL AND c.state_code <> 'ended'`,
        [sid],
      ),
    )
    for (const row of rows) {
      // qw:cross-tenant 只处理结束 sid 对应的通话，写入仍回到该行自己的租户上下文。
      await withTenant(Number(row.tenant_id), () =>
        this.markEnding(Number(row.call_id), 'session_ended'),
      )
    }
  }

  /** 小事务认领一次控制操作；未知创建只查询，不重复发起 CreateRoom。 */
  async reconcile(id: number, signal?: AbortSignal): Promise<void> {
    const pending: Promise<unknown>[] = []
    // 锁外认证可以停止等待；锁内仅无吊销副作用的 unchanged 可竞速，迟到结果不能继续本事务。
    const read = <T>(start: () => Promise<T>): Promise<T> => {
      signal?.throwIfAborted()
      const work = start()
      pending.push(work)
      return signal ? awaitImCallStage(work, signal) : work
    }
    try {
      signal?.throwIfAborted()
      const initial = await read(() => this.readState(this.ds.manager, id, signal))
      signal?.throwIfAborted()
      if (initial.call.state === 'ended') return
      const sessions = new Map<string, Session | null>()
      for (const m of initial.members) {
        const sid = m.sid
        if (sid && (m.state === 'accepted' || m.state === 'left')) {
          const session = await read(() => this.qualified(sid, signal))
          signal?.throwIfAborted()
          sessions.set(sid, session)
        }
      }
      const enabled = await read(() => this.enabled())
      signal?.throwIfAborted()
      const operation = await this.ds.transaction(async (tx) => {
        const state = await this.lockState(tx, id, initial.call.roomId, !!signal, signal)
        signal?.throwIfAborted()
        const before = this.projection(state.call)
        state.call.checkedAt = new Date()
        if (state.call.state === 'ended') return null
        if (!enabled) this.ending(state, 'disabled')
        if (state.room.closedAt) this.ending(state, 'membership_changed')
        if (state.room.scopeCode !== 'staff') this.ending(state, 'membership_changed')
        if (Date.now() - state.call.createdAt.getTime() >= IM_CALL_LIMITS.maxSeconds * 1000)
          this.ending(state, 'timeout')
        const staff = await activeStaff(
          tx,
          state.members.map((m) => m.userId),
        )
        signal?.throwIfAborted()
        for (const m of state.members) {
          const roster = await tx
            .getRepository(ImRosterEntity)
            .findOneBy({ id: m.rosterId, roomId: state.room.id, userId: m.userId })
          signal?.throwIfAborted()
          if (!roster || !staff.has(m.userId)) this.ending(state, 'membership_changed')
          if (m.sid && (m.state === 'accepted' || m.state === 'left')) {
            const session = sessions.get(m.sid)
            if (!session || !(await read(() => this.current.unchanged(session))))
              this.ending(state, 'session_ended')
            signal?.throwIfAborted()
            if (
              m.state === 'accepted' &&
              (!m.lastSeenAt ||
                Date.now() - m.lastSeenAt.getTime() > IM_CALL_LIMITS.heartbeatGraceSeconds * 1000)
            )
              this.ending(state, 'timeout')
          }
        }
        if (state.call.state === 'ringing' && state.call.inviteExpiresAt.getTime() <= Date.now())
          this.ending(state, 'no_answer')
        const call = state.call
        let action: 'create' | 'observe' | 'delete' | null = null
        if (
          call.state === 'ending' &&
          ((call.mediaStatus === 'intent' && !call.createInFlight) || call.mediaStatus === 'closed')
        ) {
          // 意图尚未发出且没有在途请求，持父房间锁即可确定没有媒体需要删除。
          if (call.mediaStatus === 'intent') call.mediaStatus = 'closed'
          await this.finish(tx, state, signal)
          signal?.throwIfAborted()
        } else if (call.mediaStatus === 'intent') {
          if (!this.gateway.configured()) this.ending(state, 'unavailable')
          else {
            call.mediaStatus = 'creating'
            call.createInFlight = true
            call.createStartedAt = new Date()
            action = 'create'
          }
        } else if (call.mediaStatus === 'creating' || call.mediaStatus === 'unknown')
          action = 'observe'
        else if (
          call.state === 'ending' &&
          (call.mediaStatus === 'ready' || call.mediaStatus === 'closing')
        ) {
          call.mediaStatus = 'closing'
          action = 'delete'
        }
        const changed = before !== this.projection(call)
        await this.save(tx, state, changed, signal)
        // 最后检查在事务 callback 内；已经发出的 COMMIT 无法由 AbortSignal 撤回。
        signal?.throwIfAborted()
        return { action, room: call.mediaRoom, operationId: call.mediaOperationId, changed }
      })
      signal?.throwIfAborted()
      if (operation?.changed) await this.hint(id, signal)
      signal?.throwIfAborted()
      if (!operation?.action) return
      signal?.throwIfAborted()
      try {
        if (operation.action === 'create') {
          await this.gateway.createRoom(operation.room, signal)
          signal?.throwIfAborted()
          await this.mediaResult(id, operation.operationId, 'created', signal)
        } else if (operation.action === 'observe') {
          const found = await this.gateway.hasRoom(operation.room, signal)
          signal?.throwIfAborted()
          if (found) await this.mediaResult(id, operation.operationId, 'created', signal)
          // not-found 不能证明未决 CreateRoom 没有在途，继续保留 unknown/inflight。
          else await this.mediaResult(id, operation.operationId, 'unknown', signal)
        } else {
          await this.gateway.deleteRoom(operation.room, signal)
          signal?.throwIfAborted()
          await this.mediaResult(id, operation.operationId, 'deleted', signal)
        }
        signal?.throwIfAborted()
      } catch (error) {
        if (signal?.aborted) return
        if (operation.action === 'create')
          await this.mediaResult(
            id,
            operation.operationId,
            error instanceof ImMediaGatewayError && !error.mayHaveCreated
              ? 'not_created'
              : 'unknown',
            signal,
          )
        signal?.throwIfAborted()
        // 删除/查询失败保留存量，下次仍从 checked_at 队列恢复，不伪造终局。
      }
    } finally {
      // 读调用不可取消时保留退场责任；maintenance 在这里完成前继续占 running，避免逐轮堆积。
      await Promise.allSettled(pending)
    }
  }

  private async mediaResult(
    id: number,
    operationId: string | null,
    outcome: 'created' | 'deleted' | 'not_created' | 'unknown',
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    const known = await this.ds.getRepository(ImCallEntity).findOneBy({ id })
    signal?.throwIfAborted()
    if (!known) return
    const changed = await this.ds.transaction(async (tx) => {
      const state = await this.lockState(tx, id, known.roomId, !!signal, signal)
      signal?.throwIfAborted()
      const c = state.call
      if (c.state === 'ended' || c.mediaOperationId !== operationId) return false
      const before = this.projection(c)
      if (outcome === 'unknown') c.mediaStatus = 'unknown'
      else if (outcome === 'created') {
        c.createInFlight = false
        c.mediaStatus = c.state === 'ending' ? 'closing' : 'ready'
      } else if (outcome === 'not_created') {
        c.createInFlight = false
        c.mediaStatus = 'closed'
        this.ending(state, 'unavailable')
      } else if (!c.createInFlight) c.mediaStatus = 'closed'
      if (c.state === 'ending' && c.mediaStatus === 'closed' && !c.createInFlight)
        await this.finish(tx, state, signal)
      signal?.throwIfAborted()
      const changed = before !== this.projection(c)
      if (changed) await this.save(tx, state, true, signal)
      signal?.throwIfAborted()
      return changed
    })
    signal?.throwIfAborted()
    if (changed) await this.hint(id, signal)
  }

  /** 结束意图单独提交，调用方即使认证已失效也不会在原房间锁内触发吊销链。 */
  async markEnding(id: number, reason: ImCallEndReason): Promise<void> {
    const known = await this.ds.getRepository(ImCallEntity).findOneBy({ id })
    if (!known) return
    const changed = await this.ds.transaction(async (tx) => {
      const state = await this.lockState(tx, id, known.roomId)
      if (!open(state.call)) return false
      this.ending(state, reason)
      await this.save(tx, state)
      return true
    })
    if (changed) await this.hint(id)
  }

  private ending(state: State, reason: ImCallEndReason): void {
    if (open(state.call)) {
      state.call.state = 'ending'
      state.call.endReason = reason
      state.call.endingAt ??= new Date()
    }
  }

  /** 终局事件、seq 与 call 终态在同一房间事务内，只允许确认无在途创建时释放槽。 */
  private async finish(tx: EntityManager, state: State, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const c = state.call
    if (c.createInFlight || c.mediaStatus !== 'closed') return
    c.state = 'ended'
    c.endingAt ??= new Date()
    c.endedAt ??= new Date()
    c.endReason ??= 'ended'
    if (c.summarySeq === null) {
      const entry = await appendEntry(
        tx,
        state.room,
        {
          entryKind: 'event',
          eventData: {
            code: 'call.ended',
            actorId: c.callerId,
            call: {
              callId: c.id,
              mode: c.mode,
              endReason: c.endReason,
              durationSeconds: c.startedAt
                ? Math.min(
                    IM_CALL_LIMITS.maxSeconds,
                    Math.max(0, Math.floor((c.endingAt.getTime() - c.startedAt.getTime()) / 1000)),
                  )
                : 0,
            },
          },
        },
        { touch: true },
      )
      signal?.throwIfAborted()
      c.summarySeq = entry.seq
    }
  }

  /** 巡检游标和成员心跳不进入业务版本，只有客户端可见状态变化才发提示。 */
  private projection(call: ImCallEntity): string {
    return JSON.stringify([
      call.state,
      call.mediaStatus,
      call.createInFlight,
      call.startedAt,
      call.endedAt,
      call.endReason,
      call.summarySeq,
    ])
  }

  private async save(
    tx: EntityManager,
    state: State,
    bump = true,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    if (bump) state.call.rev++
    await tx.getRepository(ImCallEntity).save(state.call)
    signal?.throwIfAborted()
  }

  private async readState(db: EntityManager, id: number, signal?: AbortSignal): Promise<State> {
    signal?.throwIfAborted()
    const call = await db.getRepository(ImCallEntity).findOneBy({ id })
    signal?.throwIfAborted()
    if (!call) throw new BizError(Err.IM_CALL_NOT_FOUND)
    const room = await db.getRepository(ImRoomEntity).findOneBy({ id: call.roomId })
    signal?.throwIfAborted()
    if (!room) throw new BizError(Err.IM_CALL_NOT_FOUND)
    const members = await db
      .getRepository(ImCallMemberEntity)
      .find({ where: { callId: id }, order: { id: 'ASC' } })
    signal?.throwIfAborted()
    return { call, room, members }
  }

  private async lockState(
    tx: EntityManager,
    id: number,
    roomId: number,
    nowait = false,
    signal?: AbortSignal,
  ): Promise<State> {
    signal?.throwIfAborted()
    // 父房间编号先在事务外读取；锁内不做子查询，避免等待房间锁之前建立旧的一致性快照。
    const tid = tenantId()
    const rows = await tx.query<{ id: number }[]>(
      // arch-allow: sql-concat 固定 NOWAIT 语法。tenant: 父房间租户与编号始终使用占位参数。
      `SELECT r.id FROM im_room r WHERE r.tenant_id=? AND r.deleted_at IS NULL AND r.id=? FOR UPDATE${nowait ? ' NOWAIT' : ''}`,
      [tid, roomId],
    )
    signal?.throwIfAborted()
    if (!rows.length) throw new BizError(Err.IM_CALL_NOT_FOUND)
    const state = await this.readState(tx, id, signal)
    signal?.throwIfAborted()
    if (state.call.roomId !== roomId) throw new BizError(Err.IM_CALL_NOT_FOUND)
    return state
  }

  private async requireParticipant(
    db: EntityManager,
    state: State,
    userId: number,
  ): Promise<ImCallMemberEntity> {
    const me = state.members.find((m) => m.userId === userId)
    if (
      state.room.scopeCode !== 'staff' ||
      !me ||
      !(await db
        .getRepository(ImRosterEntity)
        .existsBy({ id: me.rosterId, roomId: state.room.id, userId }))
    )
      throw new BizError(Err.IM_CALL_NOT_FOUND)
    return me
  }

  private vo(state: State, actor: Session): ImCall {
    const c = state.call,
      me = state.members.find((m) => m.userId === actor.userId)!
    const currentSid = me.sid === actor.sid
    const alive = open(c)
    return {
      id: c.id,
      roomId: c.roomId,
      mode: c.mode,
      state: c.state,
      callerId: c.callerId,
      rev: c.rev,
      createdAt: c.createdAt.toISOString(),
      startedAt: iso(c.startedAt),
      endedAt: iso(c.endedAt),
      inviteExpiresAt: c.inviteExpiresAt.toISOString(),
      endReason: c.endReason,
      members: state.members.map(({ userId, displayName, identity, state: memberState }) => ({
        userId,
        displayName,
        identity,
        state: memberState,
      })),
      canAccept:
        alive &&
        (c.state === 'active' || c.inviteExpiresAt.getTime() > Date.now()) &&
        ((me.state === 'invited' && (!me.sid || currentSid)) ||
          (me.state === 'left' &&
            c.state === 'active' &&
            state.room.roomKind === 'group' &&
            currentSid)),
      canDecline: alive && me.state === 'invited',
      canJoin:
        alive &&
        me.state === 'accepted' &&
        currentSid &&
        c.mediaStatus === 'ready' &&
        !c.createInFlight,
      canLeave: alive && me.state === 'accepted' && currentSid,
      canEnd: alive && c.callerId === actor.userId && currentSid,
    }
  }

  /** 提示只带编号；终局消息另发给当前房间成员，未被邀请者仍不能读取 live call 详情。 */
  async hint(id: number, signal?: AbortSignal): Promise<void> {
    const state = await this.readState(this.ds.manager, id, signal)
    signal?.throwIfAborted()
    this.rt.toUsers(
      state.members.map((m) => m.userId),
      { type: RT.imCall, payload: { callId: id, roomId: state.room.id, rev: state.call.rev } },
    )
    if (state.call.state === 'ended' && state.call.summarySeq !== null) {
      const members = await memberIds(this.ds.manager, state.room.id)
      signal?.throwIfAborted()
      this.rt.toUsers(members, {
        type: RT.imEntry,
        payload: {
          roomId: state.room.id,
          seq: state.call.summarySeq,
          authorId: null,
          kind: 'event',
        },
      })
    }
  }
}
