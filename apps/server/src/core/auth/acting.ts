import { DEFAULT_TENANT_ID, tenantPerms } from '@qiwu/shared'
import type { Request } from 'express'
import type { ActionLogEntry } from '../audit/audit-writer.js'
import { plainIp } from './auth-params.js'
import type { Session } from './token.service.js'

/** How long a platform user works inside a tenant it entered at most. */
export const ACTING_MS = 2 * 3_600_000

/**
 * Why a platform user left the tenant it entered (the `leave` row's `reason`): it left (`left`) or entered
 * another one (`switched`); its two hours passed (`expired`), multi-tenancy is off (`tenancy_off`) or it no
 * longer holds the perm to enter (`revoked`); its session ended by sign-out (`signout`) or otherwise
 * (`session_end`).
 */
export type LeaveReason =
  'left' | 'switched' | 'expired' | 'tenancy_off' | 'revoked' | 'signout' | 'session_end'

/** An epoch ms time as the rows record it. */
export const iso = (ms: number | undefined) =>
  ms === undefined ? null : new Date(ms).toISOString()

/**
 * The action log row of session `s` entering or leaving the tenant it works in (`biz_id`): a row of the
 * default tenant, the platform's, that the audited tenant never sees nor deletes (see
 * docs/design-notes.md#tenancy). Without `req` (the session ends outside its own requests) the
 * session's sign-in IP and User-Agent stand in.
 */
export function actingRow(
  s: Session,
  verb: 'enter' | 'leave',
  params: Record<string, unknown>,
  req?: Request,
): ActionLogEntry {
  return {
    domain: 'iam.tenant',
    verb,
    bizId: String(s.actingTenantId),
    method: req?.method ?? '',
    url: req?.originalUrl ?? '',
    ip: (req ? plainIp(req.ip) : s.ip) || null,
    ua: (req ? req.get('user-agent') : s.ua) ?? '',
    params,
    result: null,
    costMs: 0,
    context: {
      tenantId: DEFAULT_TENANT_ID,
      actor: {
        userId: s.userId,
        userType: s.userType,
        username: s.username,
        deptName: s.deptName,
      },
    },
  }
}

/** The `leave` row of session `s`, which worked inside a tenant until now. */
export const leaveRow = (s: Session, reason: LeaveReason, req?: Request): ActionLogEntry =>
  actingRow(s, 'leave', { reason, actingUntil: iso(s.actingUntil) }, req)

/**
 * Why session `s`, inside another tenant, leaves it now (AuthGuard, after the session's reload): the
 * switch is off, its time passed (none recorded counts as passed), or its user no longer holds
 * `iam.tenant.enter`, judged on the user's own perms (the session's; a request's perms inside the tenant
 * have the platform ones taken out, `iam.tenant.enter` among them). null: it stays.
 */
export function actingEnds(s: Session, multiTenant: boolean, now = Date.now()): LeaveReason | null {
  if (!multiTenant) return 'tenancy_off'
  if (!(now < (s.actingUntil ?? 0))) return 'expired'
  if (s.root !== true && !s.perms.includes(tenantPerms.enter)) return 'revoked'
  return null
}
