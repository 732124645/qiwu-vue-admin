import {
  applyDecorators,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common'
import {
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import {
  type AuthorizeBody,
  authorizeBody,
  type AuthorizeQuery,
  authorizeQuery,
  authorizeRedirectVo,
  authorizeVo,
  Err,
  OAUTH_SCOPE_USER_READ,
  userinfoVo,
} from '@qiwu/shared'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { ActionLog, SkipActionLog } from '../../../../core/audit/action-log.js'
import { clientOf } from '../../../../core/auth/auth.controller.js'
import { OAuthScope, Public } from '../../../../core/auth/decorators.js'
import { clsGet } from '../../../../core/context/cls.js'
import { RateLimit } from '../../../../core/guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { Sensitive } from '../../../../core/redact.js'
import { myId } from '../../iam/profile/profile.controller.js'
import { OAuthProvider, tokenAuthForm, tokenForm } from './provider.service.js'

const FORM = 'application/x-www-form-urlencoded'
const json = (s: z.ZodType) =>
  z.toJSONSchema(s, { target: 'openapi-3.0', unrepresentable: 'any' }) as object

// Swagger shapes of the raw RFC answers (no {code,msg,data} envelope on these three)
const tokenAnswer = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().describe('the client’s access token lifetime (s); never renewed'),
  refresh_token: z
    .string()
    .optional()
    .describe('clients with the refresh_token grant; never for client_credentials'),
  scope: z.string().describe('space-separated'),
})
const rfcError = z.object({
  error: z
    .string()
    .describe(
      'invalid_request | invalid_client | invalid_grant | unauthorized_client | unsupported_grant_type | invalid_scope',
    ),
  error_description: z.string().optional(),
})
const introspection = z.object({
  active: z.boolean().describe('false for unknown, expired, revoked or another client’s tokens'),
  client_id: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.literal('Bearer').optional().describe('access tokens'),
  exp: z.number().int().optional().describe('epoch seconds'),
  sub: z.string().optional().describe('user id; absent for client_credentials tokens'),
  username: z.string().optional(),
})
const RfcErrors = () =>
  applyDecorators(
    ApiResponse({ status: 400, description: 'RFC 6749 §5.2 error', schema: json(rfcError) }),
    ApiResponse({
      status: 401,
      description: '`invalid_client` (`WWW-Authenticate: Basic`)',
      schema: json(rfcError),
    }),
  )

/**
 * OAuth2 provider. The consent page's `/authorize` (a first-party session; third-party
 * tokens get 401 there, so no client approves for itself) and `/userinfo` (`user.read` tokens) answer
 * envelopes. The endpoints for third-party back ends: RFC 6749 token, RFC 7662
 * introspection, RFC 7009 revocation. Form bodies, raw RFC JSON answers, confidential clients only
 * (client secret by HTTP Basic or form fields). Public machine traffic: rate-limited per IP, no action
 * log (no user, no business action; the request log masks secrets, codes and tokens by key name).
 */
@ApiTags('oauth2')
@Controller('oauth2')
export class ProviderController {
  constructor(private readonly provider: OAuthProvider) {}

  @Get('authorize')
  @RateLimit(120, 60_000)
  @ApiOperation({
    summary:
      'Authorization request check (consent page): the client, scopes, scopes needing consent',
  })
  @ApiEnvelope(authorizeVo)
  preview(@Query({ schema: authorizeQuery }) q: AuthorizeQuery) {
    return this.provider.preview(myId(), q)
  }

  @Post('authorize')
  @RateLimit(120, 60_000)
  @HttpCode(200)
  @ActionLog({ domain: 'oauth.consent', verb: 'grant', bizId: (req) => req.query.client_id })
  // the answer carries the authorization code: never into the action log
  @Sensitive('redirectTo')
  @ApiOperation({
    summary: 'Approve (code) or deny (error=access_denied) the request in the query string',
  })
  @ApiEnvelope(authorizeRedirectVo)
  decide(
    @Query({ schema: authorizeQuery }) q: AuthorizeQuery,
    @Body({ schema: authorizeBody }) body: AuthorizeBody,
  ) {
    return this.provider.decide(myId(), q, body.approve)
  }

  @Get('userinfo')
  @OAuthScope(OAUTH_SCOPE_USER_READ)
  @ApiOperation({ summary: 'The token’s user: id, username, display name, avatar, locale' })
  @ApiEnvelope(userinfoVo)
  @ApiResponse({ status: 403, description: '`user.read` missing, or a client_credentials token' })
  userinfo() {
    // client_credentials sessions act for no user: AuthGuard sets no principal
    const p = clsGet('principal')
    if (!p) throw new BizError(Err.OAUTH_INSUFFICIENT_SCOPE)
    return this.provider.userinfo(p.userId)
  }

  @Post('token')
  @Public()
  @SkipActionLog()
  @RateLimit(600, 60_000)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Token endpoint: authorization_code (PKCE S256), refresh_token, client_credentials',
  })
  @ApiConsumes(FORM)
  @ApiBody({ schema: json(tokenForm) })
  @ApiOkResponse({
    description: 'RFC 6749 §5.1 (`Cache-Control: no-store`)',
    schema: json(tokenAnswer),
  })
  @RfcErrors()
  token(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.provider.token(req, res, clientOf(req))
  }

  @Post('introspect')
  @Public()
  @SkipActionLog()
  @RateLimit(1200, 60_000)
  @HttpCode(200)
  @ApiOperation({ summary: 'Token introspection (RFC 7662): the calling client’s own tokens only' })
  @ApiConsumes(FORM)
  @ApiBody({ schema: json(tokenAuthForm) })
  @ApiOkResponse({ description: 'RFC 7662 §2.2', schema: json(introspection) })
  @RfcErrors()
  introspect(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.provider.introspect(req, res)
  }

  @Post('revoke')
  @Public()
  @SkipActionLog()
  @RateLimit(1200, 60_000)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Token revocation (RFC 7009): an access or refresh token ends its whole session',
  })
  @ApiConsumes(FORM)
  @ApiBody({ schema: json(tokenAuthForm) })
  @ApiOkResponse({ description: 'Empty body, also for unknown or another client’s tokens' })
  @RfcErrors()
  revoke(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.provider.revoke(req, res)
  }
}
