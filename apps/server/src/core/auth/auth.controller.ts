import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  Err,
  type FirstPartyClient,
  type LoginBody,
  loginBody,
  type MenuNode,
  type MePayload,
  type RefreshBody,
  refreshBody,
  type TokenPayload,
  type VerifyPasswordBody,
  verifyPasswordBody,
} from '@qiwu/shared'
import type { CookieOptions, Request, Response } from 'express'
import { z } from 'zod'
import { SkipActionLog } from '../audit/action-log.js'
import { AppConfigService } from '../config/config.module.js'
import { clsGet } from '../context/cls.js'
import { RateLimit } from '../guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../http/api-envelope.decorator.js'
import { BizError } from '../http/biz-error.js'
import { originAllowed } from '../http/origin.js'
import { timezoneOf } from '../i18n/locale.js'
import { plainIp } from './auth-params.js'
import { AuthService, type Client } from './auth.service.js'
import { Public } from './decorators.js'
import type { Principal } from './principal.js'
import { CONSOLE_CLIENT, type IssuedTokens, MOBILE_CLIENT } from './token.service.js'

/** HttpOnly refresh-token cookie, sent only to /api/auth/* (see docs/design-notes.md#auth-sessions). */
export const REFRESH_COOKIE = 'qw_rt'

/** Swagger shape of every sign-in answer (TokenPayload). */
export const tokenPayload = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int(),
  refreshToken: z.string().optional().describe('mobile sessions only'),
  refreshExpiresIn: z.number().int().optional().describe('mobile sessions only'),
})

export const clientOf = (req: Request): Client => ({
  ip: plainIp(req.ip),
  ua: (req.get('user-agent') ?? '').slice(0, 512),
})

const cookieOptions = (cfg: AppConfigService): CookieOptions => ({
  httpOnly: true,
  secure: cfg.get('NODE_ENV') === 'production',
  sameSite: 'strict',
  path: '/api/auth',
})

/**
 * Every sign-in route's answer (password, refresh, SMS): sets the refresh cookie and returns the access
 * token. `keepSignedIn` → persistent cookie (Max-Age = the refresh token's life); otherwise a session
 * cookie, gone with the browser. A `mobile` session (no cookies in mini programs/apps) gets no cookie:
 * the refresh token and its lifetime are in the body instead.
 */
export function answerWithTokens(
  res: Response,
  cfg: AppConfigService,
  tokens: IssuedTokens,
  keepSignedIn: boolean,
  clientId: string = CONSOLE_CLIENT,
): TokenPayload {
  if (clientId === MOBILE_CLIENT)
    return {
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
      refreshToken: tokens.refreshToken,
      refreshExpiresIn: tokens.refreshExpiresIn,
    }
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...cookieOptions(cfg),
    ...(keepSignedIn ? { maxAge: tokens.refreshExpiresIn * 1000 } : {}),
  })
  return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn }
}

/** The well-formed refresh token of the request's cookie, else null. */
const refreshCookie = (req: Request): string | null => {
  const rt: unknown = req.cookies?.[REFRESH_COOKIE]
  return typeof rt === 'string' && /^[\w-]{1,128}$/.test(rt) ? rt : null
}

/** The signed-in caller (AuthGuard put it in CLS; every non-@Public route has one). */
const principal = (): Principal => {
  const p = clsGet('principal')
  if (!p) throw new BizError(Err.UNAUTHENTICATED)
  return p
}

/**
 * Session endpoints (see docs/design-notes.md#auth-sessions). A console session's refresh token only ever travels in the cookie; a
 * `mobile` session's only in request/response bodies.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cfg: AppConfigService,
  ) {}

  @Public()
  // sign-ins have their own log (aud_signin_log `password`/`locked`)
  @SkipActionLog()
  @RateLimit(20, 60_000)
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Password sign-in; captchaTicket (scene signin) required by captcha.mode or cross-IP failures (403 A1021); sets the refresh cookie (clientId mobile: returns the refresh token instead)',
  })
  @ApiEnvelope(tokenPayload)
  async login(
    @Body({ schema: loginBody }) body: LoginBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenPayload> {
    const t = await this.auth.login(body, clientOf(req), timezoneOf(req.get('x-timezone')))
    return answerWithTokens(res, this.cfg, t, body.keepSignedIn ?? false, body.clientId)
  }

  @Public()
  // routine token rotation; a replayed token is in the sign-in log (`refresh_reuse`)
  @SkipActionLog()
  @RateLimit(60, 60_000)
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Rotate the refresh cookie for a new access token (checks Origin; no bearer needed); mobile sessions send body.refreshToken instead',
  })
  @ApiEnvelope(tokenPayload)
  async refresh(
    @Body({ schema: refreshBody }) body: RefreshBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenPayload> {
    // A body token is no ambient credential (no CSRF, so no Origin check; mini programs send none),
    // and only a mobile session's is taken: a console token must keep to its HttpOnly cookie.
    const viaBody = body?.refreshToken !== undefined
    if (!viaBody) this.assertOrigin(req)
    const rt = viaBody ? body.refreshToken! : refreshCookie(req)
    const clientId: FirstPartyClient = viaBody ? MOBILE_CLIENT : CONSOLE_CLIENT
    const out = rt ? await this.auth.refresh(rt, clientOf(req), clientId) : null
    if (out?.kind !== 'rotated') {
      if (!viaBody) res.clearCookie(REFRESH_COOKIE, cookieOptions(this.cfg))
      throw new BizError(Err.AUTH_REFRESH_REJECTED)
    }
    // the cookie kind chosen at sign-in survives every rotation
    return answerWithTokens(res, this.cfg, out.tokens, out.session.keepSignedIn, clientId)
  }

  // the sign-in log records it (`signout`)
  @SkipActionLog()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'End the current session and clear the refresh cookie' })
  @ApiEnvelope()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<null> {
    await this.auth.logout(principal(), clientOf(req), refreshCookie(req))
    res.clearCookie(REFRESH_COOKIE, cookieOptions(this.cfg))
    return null
  }

  // a lock-screen check changes nothing; the lockout it can cause is in the sign-in log (`locked`)
  @SkipActionLog()
  @Post('verify-password')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Lock screen: check the password; too many failures end the session (401)',
  })
  @ApiEnvelope()
  async verifyPassword(
    @Body({ schema: verifyPasswordBody }) body: VerifyPasswordBody,
    @Req() req: Request,
  ): Promise<null> {
    await this.auth.verifyPassword(principal(), body.password, clientOf(req))
    return null
  }

  @Get('me')
  @ApiOperation({
    summary:
      'Current user: profile (dept and role names), role codes, perms, password flags, password policy',
  })
  me(): Promise<MePayload> {
    return this.auth.me(principal())
  }

  @Get('menus')
  @ApiOperation({
    summary: 'Granted group/page tree with every ancestor; actions are in /me perms',
  })
  menus(): Promise<MenuNode[]> {
    return this.auth.menus(principal())
  }

  /**
   * CSRF defence for the cookie-authenticated refresh (with SameSite=Strict; see docs/design-notes.md#security): `Origin`
   * must be this server's own origin (`req.protocol`/`req.host` honour `trust proxy`) or one of
   * `CORS_ORIGIN` (comma-separated). Browsers always send it on POST; no Origin → rejected.
   */
  private assertOrigin(req: Request): void {
    const origin = req.get('origin')
    if (!origin || !originAllowed(origin, req, this.cfg.get('CORS_ORIGIN')))
      throw new BizError(Err.AUTH_ORIGIN_REJECTED)
  }
}
