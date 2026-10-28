import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  Err,
  OAUTH_GRANT_TYPES,
  OAUTH_SCOPE_MCP,
  OAUTH_SCOPE_MCP_WRITE,
  OAUTH_SCOPES,
} from '@qiwu/shared'
import type { Request, Response } from 'express'
import { SkipActionLog } from '../audit/action-log.js'
import { Public } from '../auth/decorators.js'
import { AppConfigService } from '../config/config.module.js'
import { clsSet } from '../context/cls.js'
import { withTenant } from '../context/tenant.js'
import { RateLimit } from '../guard/rate-limit.decorator.js'
import { BizError } from '../http/biz-error.js'
import { Sensitive } from '../redact.js'
import { foreignOrigin } from '../http/origin.js'
import { McpAuth } from './mcp-auth.js'
import { mcpResource, resourceMetadataUrl, siteOrigin } from './mcp-resource.js'
import { McpService } from './mcp.service.js'

/** The JSON-RPC answer of the methods a stateless server does not serve (GET streams, DELETE sessions). */
const notAllowed = (res: Response) =>
  void res
    .status(405)
    .set('Allow', 'POST')
    .json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST' },
      id: null,
    })

/**
 * MCP Streamable HTTP 端点 `/api/mcp`（see docs/mcp.md）。路由对 AuthGuard 公开，认证由 McpAuth 按令牌
 * 完成；之后整个请求在令牌所属的租户里运行，principal 即令牌用户。每次 tools/call 由 McpService 记操作
 * 日志，所以路由本身不记。按 IP 限流挡住令牌猜测；浏览器来源不属于本站的请求直接拒绝（防 DNS 重绑定）。
 */
@ApiTags('mcp')
@Controller('mcp')
export class McpController {
  constructor(
    private readonly auth: McpAuth,
    private readonly mcp: McpService,
    private readonly cfg: AppConfigService,
  ) {}

  // each tools/call is logged by McpService (one row per call, refusals too)
  // 工具参数可含私人业务内容；HTTP trace 在工具校验前记录，统一遮蔽整个参数对象。
  @Sensitive('arguments')
  @SkipActionLog()
  @Post()
  @Public()
  @RateLimit(600, 60_000)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'MCP JSON-RPC (initialize, tools/list, tools/call): Bearer personal access token or OAuth2 token with scope mcp',
  })
  async post(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (foreignOrigin(req, this.cfg.get('CORS_ORIGIN'))) throw new BizError(Err.FORBIDDEN)
    const caller = await this.auth.resolve(req)
    if (!caller) {
      // RFC 9728 §5.1：告诉客户端去哪里找授权服务器
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${resourceMetadataUrl(req)}", scope="${OAUTH_SCOPE_MCP}"`,
      )
      throw new UnauthorizedException()
    }
    // qw:cross-tenant 请求的租户只来自校验过的令牌（令牌行或 OAuth2 会话），不读任何请求头
    await withTenant(caller.tenantId, () => {
      clsSet('principal', caller.principal)
      return this.mcp.handle(req, res, caller)
    })
  }

  @Get()
  @Public()
  @ApiOperation({ summary: 'Not served (stateless server): 405' })
  get(@Res() res: Response): void {
    notAllowed(res)
  }

  // answers 405 without touching anything
  @SkipActionLog()
  @Delete()
  @Public()
  @ApiOperation({ summary: 'Not served (stateless server, no sessions): 405' })
  remove(@Res() res: Response): void {
    notAllowed(res)
  }
}

/**
 * 给 MCP 客户端的发现文档（RFC 9728 受保护资源元数据、RFC 8414 授权服务器元数据），在全局前缀之外的
 * `/.well-known/*`。内容只由请求的站点地址与代码常量组成，不读任何租户数据。
 */
@ApiTags('mcp')
@Controller('.well-known')
export class McpWellKnownController {
  @Get('oauth-protected-resource')
  @Public()
  @ApiOperation({ summary: 'OAuth 2.0 protected resource metadata of the MCP endpoint (RFC 9728)' })
  resource(@Req() req: Request, @Res() res: Response): void {
    res.json({
      resource: mcpResource(req),
      authorization_servers: [siteOrigin(req)],
      scopes_supported: [OAUTH_SCOPE_MCP, OAUTH_SCOPE_MCP_WRITE],
      bearer_methods_supported: ['header'],
      resource_name: 'Qiwu MCP',
    })
  }

  @Get('oauth-protected-resource/api/mcp')
  @Public()
  @ApiOperation({ summary: 'The same metadata at its RFC 9728 path-inserted location' })
  resourceAtPath(@Req() req: Request, @Res() res: Response): void {
    this.resource(req, res)
  }

  @Get('oauth-authorization-server')
  @Public()
  @ApiOperation({ summary: 'OAuth 2.0 authorization server metadata (RFC 8414)' })
  server(@Req() req: Request, @Res() res: Response): void {
    const origin = siteOrigin(req)
    res.json({
      issuer: origin,
      // 同意页是前端路由，它再调用 /api/oauth2/authorize
      authorization_endpoint: `${origin}/sso`,
      token_endpoint: `${origin}/api/oauth2/token`,
      introspection_endpoint: `${origin}/api/oauth2/introspect`,
      revocation_endpoint: `${origin}/api/oauth2/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: OAUTH_GRANT_TYPES,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      scopes_supported: OAUTH_SCOPES,
    })
  }
}
