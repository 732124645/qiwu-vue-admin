import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Err } from '@qiwu/shared'
import type { Request, Response } from 'express'
import { clsSet } from '../context/cls.js'
import { BizError } from '../http/biz-error.js'
import { IS_PUBLIC, OAUTH_SCOPE } from './decorators.js'
import { PermVersion } from './perm-version.js'
import { SessionRevoker } from './session-revoker.js'
import { isFirstParty, type Session, TokenService } from './token.service.js'

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
 * Global (see docs/design-notes.md#auth-sessions): every route needs a session unless `@Public()`. Bearer access token →
 * session (sliding renewal in TokenService) → only first-party (`console`, `mobile`) sessions, except third-party sessions on
 * `@OAuthScope` routes → permVer check (reload roles/perms/dept, or end the session if the user is
 * gone; the version goes out as `X-Perm-Ver`) → password-change gate → CLS `principal`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly permVersion: PermVersion,
    private readonly revoker: SessionRevoker,
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

    session = await this.current(session)
    if (!session) throw new UnauthorizedException()

    const { flags } = session
    if (
      (flags.mustChangePassword || flags.passwordExpired) &&
      !PASSWORD_CHANGE_ALLOWED.has(`${req.method} ${(req.route as { path?: string })?.path}`)
    )
      throw new BizError(Err.AUTH_PASSWORD_CHANGE_REQUIRED)

    if (session.userId !== null) {
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
        roles: session.roles,
        perms: session.perms,
        root: session.root === true,
        locale: session.locale,
      })
    }
    return true
  }

  /**
   * The session with the user's current roles/perms (reloaded when permVer moved, or when it predates
   * the `root` flag: such a root session would otherwise lose root until signing in again); null = ended.
   */
  private async current(session: Session): Promise<Session | null> {
    if (session.userId === null) return session
    if (
      session.root !== undefined &&
      (await this.permVersion.current(session.userId)) === session.permVer
    )
      return session
    const user = await this.permVersion.load(session.userId)
    if (!user) {
      await this.revoker.revokeSession(session.sid, 'user_unavailable')
      return null
    }
    const next: Session = { ...session, ...user }
    return (await this.tokens.save(next)) ? next : null
  }
}
