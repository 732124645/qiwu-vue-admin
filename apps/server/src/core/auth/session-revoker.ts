import { Inject, Injectable, Logger } from '@nestjs/common'
import { FIRST_PARTY_CLIENTS, RT, type RealtimeMessage } from '@qiwu/shared'
import { RealtimeService } from '../realtime/realtime.service.js'
import { redisKey } from '../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../redis/redis.module.js'
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
}

const kickedMsg = (sid: string): RealtimeMessage => ({
  type: RT.sessionKicked,
  payload: { sid },
})

/**
 * The only way a session ends early (see docs/design-notes.md#auth-sessions, #security): sign-out, kicks, password changes, disabling
 * or deleting a user or an OAuth2 client and refresh-token replay all end here. It deletes the
 * session and every token-type key registered under `auth:user:{id}`, then disconnects the session's
 * sockets (a kick first pushes `session:kicked` to them); user revocation first runs module hooks
 * (unused OTPs consumed; WeChat bindings ended on a password change). A user's pending OAuth2
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

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Runs first in every `revokeUser`, with its reason (modules clean up their own credentials, e.g. unused
   * SMS codes, or bindings made with a changed password), before credver moves: a sign-in that reads
   * credver and then re-checks such a credential is refused or its session ended.
   */
  onRevokeUser(hook: (userId: number, reason: string) => Promise<void>): void {
    this.revokeUserHooks.push(hook)
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
   * refuses it). Call it after the change (password, reset, disable) is committed. Returns the sessions
   * it ended; a failed hook throws once they have ended.
   */
  async revokeUser(
    userId: number,
    reason: string,
    opts: { exceptSid?: string; clientId?: string } = {},
  ): Promise<Session[]> {
    const hooks = await Promise.allSettled(this.revokeUserHooks.map((hook) => hook(userId, reason)))
    await this.redis.incr(redisKey('authCredVer', userId))
    if (!opts.clientId) {
      const index = redisKey('authUserCodes', userId)
      const codes = await this.redis.zRange(index, 0, -1)
      await this.redis.unlink([...codes, index])
    }
    const ended = await this.purge(
      redisKey('authUser', userId),
      (o, clientId) =>
        (opts.exceptSid === undefined || o.sid !== opts.exceptSid) &&
        (!opts.clientId || clientId === opts.clientId),
      reason,
    )
    this.logger.log({ userId, sessions: ended.length, reason }, 'user sessions revoked')
    const failed = hooks.find((h) => h.status === 'rejected')
    if (failed) throw failed.reason
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
    const sids = await this.redis.zRange(redisKey('authOnline'), 0, -1)
    if (!sids.length) return 0
    const raws = await this.redis.mGet(sids.map((sid) => redisKey('authSession', sid)))
    const mine = sids.filter((_, i) => {
      const raw = raws[i]
      return raw != null && (JSON.parse(raw) as Session).clientId === clientId
    })
    const ended = await Promise.all(mine.map((sid) => this.revokeSession(sid, reason)))
    const count = ended.filter(Boolean).length
    this.logger.log({ clientId, sessions: count, reason }, 'client sessions revoked')
    return count
  }

  /**
   * Deletes the index members `pick` selects (given the client of their session, when its entry is
   * live), plus expired ones, and ends the sockets of their sessions; returns the sessions it ended.
   */
  private async purge(
    indexKey: string,
    pick: (o: Owned, clientId: string | undefined) => boolean,
    reason: string,
  ): Promise<Session[]> {
    const members = await this.redis.sMembers(indexKey)
    if (!members.length) return []
    const values = (await this.redis.mGet(members)).map((raw) =>
      raw ? (JSON.parse(raw) as Owned) : null,
    )
    // token entries carry only their sid: the client is their session entry's
    const clientOf = new Map<string | undefined, string>()
    for (const o of values) if (o?.clientId) clientOf.set(o.sid, o.clientId)
    const sessionKey = redisKey('authSession', '')
    const sids = new Set<string>()
    const sessions: Session[] = []
    const doomed = members.filter((key, i) => {
      const owned = values[i]
      if (!owned) return true
      if (!pick(owned, clientOf.get(owned.sid))) return false
      if (owned.sid) sids.add(owned.sid)
      if (key.startsWith(sessionKey)) sessions.push(owned as Session)
      return true
    })
    if (!doomed.length) return sessions
    const tx = this.redis.multi().unlink(doomed).sRem(indexKey, doomed)
    if (sids.size) tx.zRem(redisKey('authOnline'), [...sids]).zRem(redisKey('authSeen'), [...sids])
    await tx.exec()
    // after the keys are gone: a socket connecting meanwhile re-checks the session once it joined
    this.realtime.endSessions(sids, reason === KICKED ? kickedMsg : undefined)
    return sessions
  }
}
