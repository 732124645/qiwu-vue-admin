import { Inject, Injectable } from '@nestjs/common'
import { DEFAULT_TENANT_ID } from '@qiwu/shared'
import { PermVersion } from './perm-version.js'
import { SessionRevoker } from './session-revoker.js'
import { TENANT_LOOKUP, type TenantLookup } from './tenant-lookup.js'
import {
  type Session,
  TENANT_UNAVAILABLE,
  TenantUnavailable,
  TokenService,
} from './token.service.js'

/**
 * The one reload of a session's user facts (see docs/design-notes.md#permissions, #tenancy), shared by
 * AuthGuard, the refresh and the sockets (handshake and the minute recheck).
 */
@Injectable()
export class SessionCurrent {
  constructor(
    private readonly permVersion: PermVersion,
    private readonly tokens: TokenService,
    private readonly revoker: SessionRevoker,
    @Inject(TENANT_LOOKUP) private readonly tenants: TenantLookup,
  ) {}

  /**
   * The session with the user's current roles, perms and tenant end, reloaded when permVer moved or the
   * session predates the `root` flag or its tenant (both read from the user row then; an older session
   * never counts as the default tenant's unchecked). The absolute end never moves past the tenant's.
   * null = ended: the user is gone or disabled, or the row's tenant is not the session's (an older
   * session belongs to the default tenant). Throws TenantUnavailable (after revoking) when the user's
   * tenant is no longer available.
   */
  async current(session: Session): Promise<Session | null> {
    if (session.userId === null) return session
    if (
      session.root !== undefined &&
      session.tenantId !== undefined &&
      (await this.permVersion.current(session.userId)) === session.permVer
    )
      return session
    const tenantId = session.tenantId ?? DEFAULT_TENANT_ID
    const user = await this.permVersion.load(session.userId)
    if (!user) {
      if (!(await this.tenants.active(tenantId))) {
        await this.revoker.revokeSession(session.sid, TENANT_UNAVAILABLE)
        throw new TenantUnavailable()
      }
      await this.revoker.revokeSession(session.sid, 'user_unavailable')
      return null
    }
    // a user never changes tenant
    if (user.tenantId !== tenantId) {
      await this.revoker.revokeSession(session.sid, 'user_unavailable')
      return null
    }
    const next: Session = {
      ...session,
      ...user,
      // absent on the reloaded user = none (no longer limited), not the old value
      tenantExpAt: user.tenantExpAt,
      features: user.features,
      absoluteExpAt: Math.min(session.absoluteExpAt, user.tenantExpAt ?? Infinity),
    }
    return (await this.tokens.save(next)) ? next : null
  }
}
