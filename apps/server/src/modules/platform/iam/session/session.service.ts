import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { Err, type Page, type SessionQuery, type SessionVo } from '@qiwu/shared'
import { AuditWriter, parseUa } from '../../../../core/audit/audit-writer.js'
import { demoNetwork } from '../../../../core/audit/demo-network.js'
import { ipLocator } from '../../../../core/audit/ip-location.js'
import { type Principal, ROOT_ROLE } from '../../../../core/auth/principal.js'
import { KICKED, SessionRevoker } from '../../../../core/auth/session-revoker.js'
import {
  type OnlineSession,
  type Session,
  TokenService,
} from '../../../../core/auth/token.service.js'
import { clsGet } from '../../../../core/context/cls.js'
import { demoMode } from '../../../../core/config/demo-mode.js'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { User } from '../user/user.entity.js'

const iso = (ms: number) => new Date(ms).toISOString()
/** Case-insensitive "contains"; no filter passes everything. */
const contains = (value: string | null | undefined, q: string | undefined) =>
  !q || (value ?? '').toLowerCase().includes(q.toLowerCase())

/** The caller (AuthGuard put it in CLS; every route here needs a session). */
const principal = (): Principal => {
  const p = clsGet('principal')
  if (!p) throw new BizError(Err.UNAUTHENTICATED)
  return p
}

/**
 * Online sessions: the live sessions TokenService keeps in Redis, filtered, sorted and
 * paged here. Kicks end sessions through SessionRevoker (which pushes `session:kicked` to their sockets
 * and disconnects them) and write a `kicked` sign-in log row per ended session.
 * Data scope (IDOR; see docs/design-notes.md#security): a session belongs to its user, so a non-root caller lists and
 * kicks only the sessions of users in its `iam_user` scope (`scopedQb`, the route's perm); a kick
 * naming any other session or user is 404 for the whole call (`lockScopedIds`), and a root user's
 * sessions are never kicked by a non-root caller (422). Root sees and kicks every session.
 */
@Injectable()
export class SessionService extends BaseCrudService<User> {
  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly tokens: TokenService,
    private readonly revoker: SessionRevoker,
    private readonly audit: AuditWriter,
  ) {
    super(txHost, User)
  }

  /** Filters and pages in memory over every live session (TokenService.online's ceiling). */
  async list(q: SessionQuery): Promise<Page<SessionVo>> {
    const mySid = principal().sid
    const rows = (await this.visible(await this.tokens.online())).filter(
      (s) =>
        contains(s.username, q.username) &&
        (demoMode() || contains(s.ip, q.ip)) &&
        (!q.clientId || s.clientId === q.clientId),
    )
    const sort = q.sort?.length ? q.sort : [{ field: 'loginAt', order: 'DESC' } as const]
    rows.sort((a, b) => {
      for (const { field, order } of sort) {
        const d = (a[field] ?? 0) - (b[field] ?? 0)
        if (d) return order === 'ASC' ? d : -d
      }
      return a.sid < b.sid ? -1 : 1
    })
    const start = (q.page - 1) * q.pageSize
    return {
      items: await Promise.all(
        rows
          .slice(start, start + q.pageSize)
          .map(async (s) => vo(s, mySid, await ipLocator.location(s.ip))),
      ),
      total: rows.length,
    }
  }

  /**
   * Ends the given sessions; unknown or already ended ones are skipped. Returns how many ended. Any
   * live one the caller may not kick (`guarded`) → nothing ends.
   */
  async kick(sids: readonly string[]): Promise<number> {
    const by = principal()
    const unique = [...new Set(sids)]
    const owners = by.root
      ? []
      : (await Promise.all(unique.map((sid) => this.tokens.load(sid)))).flatMap((s) =>
          s ? [s.userId] : [],
        )
    return this.guarded(owners, async () => {
      let kicked = 0
      for (const sid of unique) {
        const ended = await this.revoker.revokeSession(sid, KICKED)
        if (ended) {
          this.log(ended, by)
          kicked++
        }
      }
      return kicked
    })
  }

  /** One session; 404 when it is unknown or already ended. */
  async kickOne(sid: string): Promise<number> {
    const kicked = await this.kick([sid])
    if (!kicked) throw new BizError(Err.NOT_FOUND)
    return kicked
  }

  /** Every session of the user on every client (also refuses a sign-in racing it). */
  async kickUser(userId: number): Promise<number> {
    const by = principal()
    return this.guarded([userId], async () => {
      const ended = await this.revoker.revokeUser(userId, KICKED)
      for (const s of ended) this.log(s, by)
      return ended.length
    })
  }

  /** The sessions whose users are in the caller's scope; root: all of them. */
  private async visible(sessions: OnlineSession[]): Promise<OnlineSession[]> {
    if (principal().root) return sessions
    const ids = [...new Set(sessions.flatMap((s) => (s.userId === null ? [] : [s.userId])))]
    if (!ids.length) return []
    const rows = await this.scopedQb('t')
      .select('t.id', 'id')
      .andWhere('t.id IN (:...ids)', { ids })
      .getRawMany<{ id: number | string }>()
    const seen = new Set(rows.map((r) => Number(r.id)))
    return sessions.filter((s) => s.userId !== null && seen.has(s.userId))
  }

  /**
   * Runs `kick` once the caller may end sessions of `owners` (their user ids): root always; anyone
   * else inside one transaction that locks those users in its scope (a user outside it, unknown, or a
   * session without a user → 404 for all) and refuses a root user (422 `iam.user_protected`), so
   * neither can change while the sessions end.
   */
  private async guarded<T>(owners: readonly (number | null)[], kick: () => Promise<T>): Promise<T> {
    if (principal().root) return kick()
    return this.txHost.withTransaction(async () => {
      const ids = [...new Set(owners)]
      if (ids.includes(null)) throw new NotFoundException()
      await this.lockScopedIds(ids as number[])
      if (ids.length && (await this.anyRoot(ids as number[])))
        throw new BizError(Err.IAM_USER_PROTECTED)
      return kick()
    })
  }

  /** Whether any of `ids` holds the builtin root role. */
  private async anyRoot(ids: readonly number[]): Promise<boolean> {
    const [row] = await this.txHost.tx.query<unknown[]>(
      `SELECT 1 FROM iam_user_roles ur
         JOIN iam_role r ON r.id = ur.role_id AND r.deleted_at IS NULL
        WHERE ur.user_id IN (?) AND ur.deleted_at IS NULL AND r.code = ? AND r.is_builtin = 1 LIMIT 1`,
      [ids, ROOT_ROLE],
    )
    return row !== undefined
  }

  /** The kicked user's sign-in log row: the session's own client, IP and UA; `by` the admin. */
  private log(s: Session, by: Principal) {
    this.audit.signin({
      kind: 'kicked',
      userId: s.userId,
      userType: s.userType,
      username: s.username ?? '',
      clientId: s.clientId,
      ip: s.ip,
      ua: s.ua,
      ok: true,
      msgKey: 'signin.kicked',
      msgParams: { by: by.username ?? `#${by.userId}` },
    })
  }
}

function vo(s: OnlineSession, mySid: string | undefined, location: string | null): SessionVo {
  const { browser, os } = parseUa(s.ua)
  return demoNetwork({
    sid: s.sid,
    userId: s.userId,
    username: s.username ?? null,
    deptName: s.deptName ?? null,
    userType: s.userType,
    clientId: s.clientId,
    ip: s.ip,
    location,
    browser,
    os,
    userAgent: s.ua,
    keepSignedIn: s.keepSignedIn,
    loginAt: iso(s.loginAt),
    lastSeenAt: s.lastSeenAt === null ? null : iso(s.lastSeenAt),
    expiresAt: iso(s.expiresAt),
    current: s.sid === mySid,
  })
}
