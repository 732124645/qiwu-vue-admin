import { Inject, Injectable } from '@nestjs/common'
import type { Request } from 'express'
import { AuditWriter } from '../audit/audit-writer.js'
import { redisKey } from '../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../redis/redis.module.js'
import { ACTING_MS, actingRow, iso, type LeaveReason, leaveRow } from './acting.js'
import { type Session, TokenService } from './token.service.js'

/** How long the first leave of a stay keeps later ones of it from being logged again. */
const LEAVE_ONCE_MS = 60_000

/**
 * A platform user's session entering and leaving another tenant (see docs/design-notes.md#tenancy): the
 * session records the tenant and its end, each step is an action log row of the default tenant.
 */
@Injectable()
export class TenantActing {
  constructor(
    private readonly tokens: TokenService,
    private readonly audit: AuditWriter,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Session `s` works inside tenant `tenantId` from now on, `ACTING_MS` at most; a tenant it was inside is
   * left first (`switched`). false: the session ended meanwhile.
   */
  async enter(s: Session, tenantId: number, reason: string, req: Request): Promise<boolean> {
    const from = s.actingTenantId === undefined ? s : await this.leave(s, 'switched', req)
    if (!from) return false
    const next: Session = { ...from, actingTenantId: tenantId, actingUntil: Date.now() + ACTING_MS }
    if (!(await this.tokens.save(next))) return false
    this.audit.action(
      actingRow(next, 'enter', { body: { reason }, actingUntil: iso(next.actingUntil) }, req),
    )
    return true
  }

  /**
   * Session `s` back in its user's own tenant; null: the session ended meanwhile. Saving is the same for
   * concurrent requests that read the same stay (`actingUntil`); only the first of them logs the leave.
   */
  async leave(s: Session, reason: LeaveReason, req?: Request): Promise<Session | null> {
    const next: Session = { ...s, actingTenantId: undefined, actingUntil: undefined }
    if (!(await this.tokens.save(next))) return null
    const first = await this.redis.set(
      redisKey('authActingLeave', s.sid, String(s.actingUntil)),
      '1',
      { condition: 'NX', expiration: { type: 'PX', value: LEAVE_ONCE_MS } },
    )
    if (first === 'OK') this.audit.action(leaveRow(s, reason, req))
    return next
  }
}
