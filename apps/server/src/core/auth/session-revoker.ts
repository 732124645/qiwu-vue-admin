import { Inject, Injectable, Logger } from '@nestjs/common'
import {
  DEFAULT_TENANT_ID,
  FIRST_PARTY_CLIENTS,
  RT,
  type RealtimeMessage,
  SESSION_END_REASONS,
  type SessionEndReason,
} from '@qiwu/shared'
import { AuditWriter } from '../audit/audit-writer.js'
import { RealtimeService } from '../realtime/realtime.service.js'
import { redisKey } from '../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../redis/redis.module.js'
import { leaveRow } from './acting.js'
import type { Session } from './token.service.js'

/** Who a session belongs to: a user, or (client_credentials) only an OAuth2 client. */
export interface SessionOwner {
  userId: number | null
  clientId: string
}

/**
 * `auth:user:{id}`: every session/token key of the owner (session, at, rt, grace entries).
 */
export const ownerIndexKey = (o: SessionOwner): string =>
  redisKey('authUser', o.userId ?? `client:${o.clientId}`)

/** Revocation reason of an admin kick (iam/session): its sockets get `session:kicked` before they end. */
export const KICKED = 'kicked'
/**
 * Revocation reasons of a password change (own) and reset (SMS, admin): sign-in bindings made with the old
 * password end too (WxMpService).
 */
export const PASSWORD_CHANGED = 'password_changed'
export const PASSWORD_RESET = 'password_reset'

/**
 * Every value under an owner index is JSON carrying its session id, a session's also its client.
 */
interface Owned {
  sid: string
  clientId?: string
  /** a mobile session's kind (Session.mobileKind) */
  mobileKind?: string
}

const kickedMsg = (sid: string): RealtimeMessage => ({
  type: RT.sessionKicked,
  payload: { sid },
})

/**
 * What the sockets of sessions revoked for `reason` get before they end: a kick `session:kicked`, an end
 * the client explains (its tenant gone, SESSION_END_REASONS) the same with that reason, others nothing.
 */
const lastMsg = (reason: string): ((sid: string) => RealtimeMessage) | undefined =>
  reason === KICKED
    ? kickedMsg
    : (SESSION_END_REASONS as readonly string[]).includes(reason)
      ? (sid) => ({
          type: RT.sessionKicked,
          payload: { sid, reason: reason as SessionEndReason },
        })
      : undefined

/**
 * The only way a session ends early (see docs/design-notes.md#auth-sessions, #security): sign-out, kicks, password changes, disabling
 * or deleting a user or an OAuth2 client, a tenant's end and refresh-token replay all end here. It
 * deletes the session and every token-type key registered under `auth:user:{id}`, then disconnects the
 * session's sockets (a kick, or an end the client explains such as its tenant's, first pushes
 * `session:kicked`) and records the leave of a session that worked inside another tenant (see
 * docs/design-notes.md#tenancy); user revocation first runs module hooks (unused OTPs consumed; WeChat bindings
 * ended on a password change). A user's pending OAuth2
 * authorization codes sit in their own expiry ZSET (`auth:codes:{id}`): `revokeUser` deletes
 * them unless filtered by client; `revokeSession` leaves them alone (a code belongs to
 * no session) and `revokeClient` leaves them to the exchange, which refuses a disabled or deleted
 * client.
 * `scripts/arch` forbids deleting `auth:*` keys anywhere else.
 */
@Injectable()
export class SessionRevoker {
  private readonly logger = new Logger(SessionRevoker.name)
  private readonly revokeUserHooks: Array<(userId: number, reason: string) => Promise<void>> = []
  /** the hooks registered with `again`: they run a second time once credver has moved */
  private readonly revokeUserAgain: Array<(userId: number, reason: string) => Promise<void>> = []
  private readonly revokeTenantHooks: Array<(tenantId: number, reason: string) => Promise<void>> =
    []
  private readonly sessionEndedHooks: Array<
    (sid: string, reason: string, session?: Session) => Promise<void>
  > = []

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditWriter,
  ) {}

  /** 凭据已经移除后的通用结束通知；可重复投递，模块须幂等，失败不复活凭据或改变吊销结果。 */
  onSessionEnded(hook: (sid: string, reason: string, session?: Session) => Promise<void>): void {
    this.sessionEndedHooks.push(hook)
  }

  /** 先完成密钥删除再通知，避免业务补偿错误使失效会话重新可用。 */
  private async notifySessionEnded(
    sids: readonly string[],
    reason: string,
    sessions: readonly Session[] = [],
  ): Promise<void> {
    if (!this.sessionEndedHooks.length) return
    const bySid = new Map(sessions.map((session) => [session.sid, session]))
    const results = await Promise.allSettled(
      [...new Set(sids)].flatMap((sid) =>
        this.sessionEndedHooks.map((hook) =>
          Promise.resolve().then(() => hook(sid, reason, bySid.get(sid))),
        ),
      ),
    )
    const failures = results.filter((result) => result.status === 'rejected').length
    if (failures) this.logger.warn({ failures }, 'session ended handler failed')
  }

  /**
   * Runs first in every `revokeUser`, with its reason (modules clean up their own credentials, e.g. unused
   * SMS codes, or bindings made with a changed password), before credver moves: a sign-in that reads
   * credver and then re-checks such a credential is refused or its session ended. `again`: the hook runs
   * once more right after credver moved, for credentials made outside sessions that compare credver
   * only after they are stored (personal access tokens): one stored between the first run and the bump
   * is caught by the second run, one stored later sees the moved credver itself.
   */
  onRevokeUser(
    hook: (userId: number, reason: string) => Promise<void>,
    opts: { again?: boolean } = {},
  ): void {
    this.revokeUserHooks.push(hook)
    if (opts.again) this.revokeUserAgain.push(hook)
  }

  /**
   * Runs first in every `revokeTenant`, with its reason: modules end the tenant's own credentials that
   * live outside sessions (personal access tokens).
   */
  onRevokeTenant(hook: (tenantId: number, reason: string) => Promise<void>): void {
    this.revokeTenantHooks.push(hook)
  }

  /** Ends one session; returns it as it was, or null when it had already ended. */
  async revokeSession(sid: string, reason: string): Promise<Session | null> {
    const raw = await this.redis.get(redisKey('authSession', sid))
    await this.redis
      .multi()
      .zRem(redisKey('authOnline'), sid)
      .zRem(redisKey('authSeen'), sid)
      .exec()
    // no session: its at/rt keys (if any) already point nowhere; sockets it left behind just end
    if (!raw) {
      this.realtime.endSessions([sid])
      await this.notifySessionEnded([sid], reason)
      return null
    }
    const [ended = null] = await this.purge(
      ownerIndexKey(JSON.parse(raw) as SessionOwner),
      (o) => o.sid === sid,
      reason,
    )
    this.logger.log({ sid, reason }, 'session revoked')
    return ended
  }

  /**
   * Every session of the user on every client (only `clientId`'s, when given), except `exceptSid`
   * (the caller's own, e.g. after a password change). Runs the hooks, then bumps `auth:credver:{id}`,
   * so a sign-in already past its password check cannot start a session afterwards (TokenService.issue
   * refuses it), then runs the `again` hooks a second time. Call it after the change (password, reset, disable) is committed. Returns the sessions
   * it ended; a failed hook throws once they have ended.
   */
  async revokeUser(
    userId: number,
    reason: string,
    opts: { exceptSid?: string; clientId?: string } = {},
  ): Promise<Session[]> {
    const first = await Promise.allSettled(this.revokeUserHooks.map((hook) => hook(userId, reason)))
    await this.redis.incr(redisKey('authCredVer', userId))
    // 只在存好之后才比较 credver 的凭据（访问令牌）：在第一轮与递增之间存下的，由这第二轮吊销
    const again = await Promise.allSettled(this.revokeUserAgain.map((hook) => hook(userId, reason)))
    const hooks = [...first, ...again]
    if (!opts.clientId) {
      const index = redisKey('authUserCodes', userId)
      const codes = await this.redis.zRange(index, 0, -1)
      await this.redis.unlink([...codes, index])
    }
    const ended = await this.purge(
      redisKey('authUser', userId),
      (o, session) =>
        (opts.exceptSid === undefined || o.sid !== opts.exceptSid) &&
        (!opts.clientId || session?.clientId === opts.clientId),
      reason,
    )
    this.logger.log({ userId, sessions: ended.length, reason }, 'user sessions revoked')
    const failed = hooks.find((h) => h.status === 'rejected')
    if (failed) throw failed.reason
    return ended
  }

  /**
   * 单 App 会话：结束该用户除 `exceptSid`（刚签发的新会话）外的全部 App 会话（`clientId='mobile'` 且
   * `mobileKind='app'`），它们的 socket 先收到带原因的 `session:kicked`。只动会话，不像 `revokeUser`
   * 那样递增 credver、跑模块钩子或删 OAuth2 授权码：换一台设备登录不是凭据变化，web、H5、小程序与
   * 第三方会话都不受影响。用户 id 全局唯一，所以只会碰到本用户（本租户）的会话。
   */
  async revokeAppSessions(userId: number, exceptSid: string, reason: string): Promise<Session[]> {
    const ended = await this.purge(
      redisKey('authUser', userId),
      (o, session) =>
        o.sid !== exceptSid && session?.clientId === 'mobile' && session.mobileKind === 'app',
      reason,
    )
    if (ended.length)
      this.logger.log({ userId, sessions: ended.length, reason }, 'app sessions replaced')
    return ended
  }

  /**
   * Every session of OAuth2 client `clientId`, the user-delegated and the client_credentials ones: the
   * client was deleted or disabled (a client id may be registered again once deleted). Throws
   * for a first-party client: ending every console or mobile session is never a client operation.
   * Returns how many sessions it ended. One MGET over every `auth:online` member, the ceiling of
   * TokenService.online; index sessions by client if an install ever keeps far more online.
   */
  async revokeClient(clientId: string, reason: string): Promise<number> {
    if ((FIRST_PARTY_CLIENTS as readonly string[]).includes(clientId))
      throw new Error(`revokeClient: ${clientId} is a first-party client`)
    const count = await this.revokeWhere((s) => s.clientId === clientId, reason)
    this.logger.log({ clientId, sessions: count, reason }, 'client sessions revoked')
    return count
  }

  /**
   * Every session of tenant `tenantId` (its sockets get `session:kicked` with the reason when it is one
   * of SESSION_END_REASONS): the tenant was disabled or its end moved before now (see
   * docs/design-notes.md#tenancy). Call it after the tenant row is committed, then `PermVersion.bumpAll()`:
   * a session issued meanwhile reloads and is refused. A session that does not name its tenant is of
   * the default one. Scans every `auth:online` member like `revokeClient`; index sessions by tenant if
   * an install ever keeps far more online. Runs the tenant hooks first; a failed hook throws once the
   * sessions have ended. Returns how many sessions it ended.
   */
  async revokeTenant(tenantId: number, reason: string): Promise<number> {
    const hooks = await Promise.allSettled(
      this.revokeTenantHooks.map((hook) => hook(tenantId, reason)),
    )
    const count = await this.revokeWhere(
      (s) => (s.tenantId ?? DEFAULT_TENANT_ID) === tenantId,
      reason,
    )
    this.logger.log({ tenantId, sessions: count, reason }, 'tenant sessions revoked')
    const failed = hooks.find((h) => h.status === 'rejected')
    if (failed) throw failed.reason
    return count
  }

  /** Ends every online session `pick` selects; returns how many ended. */
  private async revokeWhere(pick: (s: Session) => boolean, reason: string): Promise<number> {
    const sids = await this.redis.zRange(redisKey('authOnline'), 0, -1)
    if (!sids.length) return 0
    const raws = await this.redis.mGet(sids.map((sid) => redisKey('authSession', sid)))
    const mine = sids.filter((_, i) => {
      const raw = raws[i]
      return raw != null && pick(JSON.parse(raw) as Session)
    })
    const ended = await Promise.all(mine.map((sid) => this.revokeSession(sid, reason)))
    return ended.filter(Boolean).length
  }

  /**
   * Deletes the index members `pick` selects (given their session's entry, when it is live), plus
   * expired ones, and ends the sockets of their sessions; returns the sessions it ended.
   */
  private async purge(
    indexKey: string,
    pick: (o: Owned, session: Owned | undefined) => boolean,
    reason: string,
  ): Promise<Session[]> {
    const members = await this.redis.sMembers(indexKey)
    if (!members.length) return []
    const values = (await this.redis.mGet(members)).map((raw) =>
      raw ? (JSON.parse(raw) as Owned) : null,
    )
    // token entries carry only their sid: the client and kind are their session entry's
    const sessionOf = new Map<string | undefined, Owned>()
    for (const o of values) if (o?.clientId) sessionOf.set(o.sid, o)
    const sessionKey = redisKey('authSession', '')
    const sids = new Set<string>()
    const sessions: Session[] = []
    const doomed = members.filter((key, i) => {
      const owned = values[i]
      if (!owned) return true
      if (!pick(owned, sessionOf.get(owned.sid))) return false
      if (owned.sid) sids.add(owned.sid)
      if (key.startsWith(sessionKey)) sessions.push(owned as Session)
      return true
    })
    if (!doomed.length) return sessions
    const tx = this.redis.multi().unlink(doomed).sRem(indexKey, doomed)
    if (sids.size) tx.zRem(redisKey('authOnline'), [...sids]).zRem(redisKey('authSeen'), [...sids])
    await tx.exec()
    // after the keys are gone: a socket connecting meanwhile re-checks the session once it joined
    this.realtime.endSessions(sids, lastMsg(reason))
    await this.notifySessionEnded([...sids], reason, sessions)
    // a session inside another tenant leaves it with its end, recorded in the default tenant
    for (const s of sessions)
      if (s.actingTenantId !== undefined)
        this.audit.action(leaveRow(s, reason === 'signout' ? 'signout' : 'session_end'))
    return sessions
  }
}
