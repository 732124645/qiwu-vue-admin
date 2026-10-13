import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { DEFAULT_TENANT_ID, Err } from '@qiwu/shared'
import type { Request, Response } from 'express'
import { SKIP_HTTP_TRACE, traceHttpAlways } from '../audit/audit-writer.js'
import { AppConfigService } from '../config/config.module.js'
import { clsSet } from '../context/cls.js'
import { BizError } from '../http/biz-error.js'
import { actingEnds } from './acting.js'
import { IS_PUBLIC, OAUTH_SCOPE } from './decorators.js'
import { PLATFORM_ONLY, type PlatformOnlyWho } from './platform-only.js'
import { SessionCurrent } from './session-current.js'
import { TenantActing } from './tenant-acting.js'
import { HOME_TENANT } from './tenant-scope.js'
import { TENANT_LOOKUP, type TenantLookup } from './tenant-lookup.js'
import { CONSOLE_CLIENT, isFirstParty, type Session, TokenService } from './token.service.js'
import { USER_LOOKUP, type UserLookup } from './user-lookup.js'

/** The only routes a session with `mustChangePassword`/`passwordExpired` may call (see docs/design-notes.md#auth-sessions). */
export const PASSWORD_CHANGE_ALLOWED: ReadonlySet<string> = new Set([
  'GET /api/auth/me',
  'GET /api/auth/menus',
  'PUT /api/iam/profile/password',
  'POST /api/auth/logout',
])

const BEARER = /^Bearer ([\w-]{1,128})$/

/**
 * Response header with the permission version the request ran under (permVer; see docs/design-notes.md#permissions): the web
 * compares it with the one it loaded `/me` and `/menus` under and reloads them when it moved.
 */
export const PERM_VER_HEADER = 'X-Perm-Ver'

/**
 * Request header of the web console: the data tenant its page was loaded for (`/me.tenant.id`). A console
 * session working in another one by now (another tab entered or left a tenant) answers 409 `A1040`; the
 * header can only fail a request, never pick a tenant (see docs/design-notes.md#tenancy).
 */
export const TENANT_EXPECT_HEADER = 'X-Tenant-Expect'

/**
 * Global (see docs/design-notes.md#auth-sessions): every route needs a session unless `@Public()`. Bearer access token →
 * session (sliding renewal in TokenService; a session whose tenant ended is revoked, 401 `A1042`) → only
 * first-party (`console`, `mobile`) sessions, except third-party sessions on `@OAuthScope` routes →
 * permVer check (SessionCurrent: reload roles/perms/dept/tenant, or end the session if the user or its
 * tenant is gone; the version goes out as `X-Perm-Ver`) → a session inside another tenant leaves it once
 * its time passed, the switch is off or its user lost the perm to enter (each of its requests goes into
 * the API access log) → the host's tenant (multi-tenancy on: a host bound to another tenant answers 401,
 * the session stays) → CLS tenant (the session's own; the tenant a platform user entered, except on
 * `@HomeTenant()` and `@PlatformOnly()` routes; see docs/design-notes.md#tenancy) and `principal` (inside
 * another tenant the user's perms without the platform ones) → password-change gate →
 * `X-Tenant-Expect` (console).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionCurrent,
    @Inject(TENANT_LOOKUP) private readonly tenants: TenantLookup,
    @Inject(USER_LOOKUP) private readonly users: UserLookup,
    private readonly acting: TenantActing,
    private readonly cfg: AppConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true
    // sockets authenticate in their own middleware; nothing else may skip the check
    if (ctx.getType() !== 'http') return false
    const req = ctx.switchToHttp().getRequest<Request>()
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1]
    let session = token ? await this.tokens.authenticate(token) : null
    if (!session) throw new UnauthorizedException()

    if (!isFirstParty(session.clientId)) {
      const scope = this.reflector.getAllAndOverride<string | undefined>(OAUTH_SCOPE, targets)
      if (!scope) throw new UnauthorizedException()
      if (!session.scopes.includes(scope)) throw new BizError(Err.FORBIDDEN)
    }

    session = await this.sessions.current(session)
    if (!session) throw new UnauthorizedException()
    if (session.actingTenantId !== undefined) {
      // a platform user inside another tenant: every request is traced, the last one and the refused too
      if (!this.reflector.getAllAndOverride<boolean>(SKIP_HTTP_TRACE, targets)) traceHttpAlways(req)
      const why = actingEnds(session, this.cfg.get('APP_MULTI_TENANT'))
      if (why) session = await this.acting.leave(session, why, req)
      if (!session) throw new UnauthorizedException()
    }
    // a token of another tenant than the host's: only presented on the wrong domain, not revoked
    const hostTenant = req.hostname ? await this.tenants.byHost(req.hostname) : null
    if (hostTenant !== null && hostTenant !== session.tenantId) throw new UnauthorizedException()

    // a user session names its tenant once reloaded; a client's (client_credentials) is the default one
    const tenant = session.tenantId ?? DEFAULT_TENANT_ID
    // a platform user inside another tenant works on its data, except on the routes that run in the
    // user's own tenant: personal ones and the platform pages (see docs/design-notes.md#tenancy)
    const own =
      this.reflector.getAllAndOverride<boolean>(HOME_TENANT, targets) === true ||
      this.reflector.getAllAndOverride<PlatformOnlyWho>(PLATFORM_ONLY, targets) !== undefined
    clsSet('tenantId', own ? tenant : (session.actingTenantId ?? tenant))
    clsSet('actorTenantId', tenant)
    if (session.userId !== null) {
      const { perms, roles } = await this.ownPerms(session)
      // the web reloads /me + /menus when it sees another version: set before any 403 of this request
      ctx.switchToHttp().getResponse<Response>().setHeader(PERM_VER_HEADER, session.permVer)
      clsSet('principal', {
        userId: session.userId,
        username: session.username,
        deptName: session.deptName,
        sid: session.sid,
        userType: session.userType,
        clientId: session.clientId,
        deptId: session.deptId,
        deptTreePath: session.deptTreePath,
        roles,
        perms,
        root: session.root === true,
        // inside another tenant the user is none of its administrators
        tenantAdmin: session.tenantAdmin === true && session.actingTenantId === undefined,
        tenantId: tenant,
        actingTenantId: session.actingTenantId,
        features: session.features,
        locale: session.locale,
      })
    }
    // refusals from here on name their caller (an always-traced request's access log row)
    const { flags } = session
    if (
      (flags.mustChangePassword || flags.passwordExpired) &&
      !PASSWORD_CHANGE_ALLOWED.has(`${req.method} ${(req.route as { path?: string })?.path}`)
    )
      throw new BizError(Err.AUTH_PASSWORD_CHANGE_REQUIRED)
    const expected = req.get(TENANT_EXPECT_HEADER)
    if (
      expected &&
      session.clientId === CONSOLE_CLIENT &&
      expected !== String(session.actingTenantId ?? tenant)
    )
      throw new BizError(Err.AUTH_TENANT_SWITCHED)
    return true
  }

  /**
   * The perms and roles a request runs with: the session's; inside another tenant those without the
   * platform's (a perm any platform-only menu carries), root keeping `*` (see docs/design-notes.md#tenancy).
   */
  private async ownPerms(s: Session): Promise<Pick<Session, 'perms' | 'roles'>> {
    if (s.actingTenantId === undefined || s.root === true) return s
    // one menu read per such request: few users, a few hours at a time
    const platform = new Set(await this.users.platformPerms())
    const keep = (perms: string[]) => perms.filter((p) => !platform.has(p))
    return { perms: keep(s.perms), roles: s.roles.map((r) => ({ ...r, perms: keep(r.perms) })) }
  }
}
