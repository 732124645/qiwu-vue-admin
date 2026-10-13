import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { DEFAULT_TENANT_ID, Err, type Page, type SessionQuery, type SessionVo } from '@qiwu/shared'
import { AuditWriter, parseUa } from '../../../../core/audit/audit-writer.js'
import { demoNetwork } from '../../../../core/audit/demo-network.js'
import { ipLocator } from '../../../../core/audit/ip-location.js'
import type { Principal } from '../../../../core/auth/principal.js'
import { KICKED, SessionRevoker } from '../../../../core/auth/session-revoker.js'
import {
  type OnlineSession,
  type Session,
  TokenService,
} from '../../../../core/auth/token.service.js'
import { clsGet } from '../../../../core/context/cls.js'
import { tenantId } from '../../../../core/context/tenant.js'
import { demoMode } from '../../../../core/config/demo-mode.js'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { mayManage, protectedUsers } from '../user/protected-users.js'
import { User } from '../user/user.entity.js'

const iso = (ms: number) => new Date(ms).toISOString()
/** Case-insensitive "contains"; no filter passes everything. */
const contains = (value: string | null | undefined, q: string | undefined) =>
  !q || (value ?? '').toLowerCase().includes(q.toLowerCase())

/** Whether session `s` is of the data tenant (one that does not name its tenant predates them: the default one's). */
const ofDataTenant = (s: Session) => (s.tenantId ?? DEFAULT_TENANT_ID) === tenantId()

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
 * naming any other session or user is 404 for the whole call (`lockScopedIds`), and a protected user's
 * sessions are kicked only as `mayManage` lets (422). Root sees and kicks every session of the data
 * tenant; another tenant's is 404 to it too (see docs/design-notes.md#tenancy).
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
    const live = (await Promise.all(unique.map((sid) => this.tokens.load(sid)))).flatMap((s) =>
      s ? [s] : [],
    )
    if (by.root && !live.every(ofDataTenant)) throw new NotFoundException()
    const owners = by.root ? [] : live.map((s) => s.userId)
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

  /** The sessions whose users are in the caller's scope; root: those of the data tenant. */
  private async visible(sessions: OnlineSession[]): Promise<OnlineSession[]> {
    if (principal().root) return sessions.filter(ofDataTenant)
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
   * Runs `kick` once the caller may end sessions of `owners` (their user ids), inside one transaction
   * that locks those users: root those of the data tenant (another tenant's → 404); anyone else those
   * in its scope (a user outside it, unknown, or a session without a user → 404 for all), not a
   * protected user `mayManage` refuses (422 `iam.user_protected`), so neither can change while the
   * sessions end.
   */
  private async guarded<T>(owners: readonly (number | null)[], kick: () => Promise<T>): Promise<T> {
    const p = principal()
    return this.txHost.withTransaction(async () => {
      const ids = [...new Set(owners)]
      if (ids.includes(null)) throw new NotFoundException()
      // root too: the tenant condition holds for it (it skips the data scope only)
      await this.lockScopedIds(ids as number[])
      for (const why of (await protectedUsers(this.txHost.tx, ids as number[])).values())
        if (!mayManage(p, why)) throw new BizError(Err.IAM_USER_PROTECTED)
      return kick()
    })
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
