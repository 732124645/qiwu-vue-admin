import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  type AccessTokenCreate,
  accessTokenCreate,
  accessTokenCreatedVo,
  accessTokenAdminVo,
  type AccessTokenQuery,
  accessTokenQuery,
  accessTokenVo,
  type EnabledBody,
  enabledBody,
  Err,
  mcpPerms,
  type McpToolVo,
  mcpToolVo,
  pageVo,
} from '@qiwu/shared'
import type { Request } from 'express'
import { z } from 'zod'
import { ActionLog } from '../audit/action-log.js'
import { clientOf } from '../auth/auth.controller.js'
import { AuthService } from '../auth/auth.service.js'
import { TokenService } from '../auth/token.service.js'
import { RequirePerm } from '../auth/decorators.js'
import { PlatformOnly } from '../auth/platform-only.js'
import { HomeTenant } from '../auth/tenant-scope.js'
import { clsGet } from '../context/cls.js'
import { Idempotent } from '../guard/idempotent.js'
import { RateLimit } from '../guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../http/api-envelope.decorator.js'
import { BizError } from '../http/biz-error.js'
import { AccessTokenService } from './access-token.service.js'
import { McpRegistry } from './mcp-registry.js'
import { McpToolSwitch } from './mcp.entity.js'
import { McpService } from './mcp.service.js'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'

/** The signed-in caller (these routes are behind AuthGuard: a principal is always there). */
function me() {
  const p = clsGet('principal')
  if (!p) throw new BizError(Err.UNAUTHENTICATED)
  return p
}

/**
 * 平台页“MCP 工具”：列出已注册工具与启用状态，整体停用 / 启用某个工具（see docs/mcp.md）。
 * 工具对所有租户生效，所以是平台页（`@PlatformOnly()`）。
 */
@ApiTags('mcp')
@Controller('mcp/tools')
export class McpToolController {
  constructor(
    private readonly registry: McpRegistry,
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly mcp: McpService,
  ) {}

  @Get()
  @RequirePerm(mcpPerms.tool.browse)
  @PlatformOnly()
  @ApiOperation({ summary: 'Registered tools with their kind, permission and switch' })
  @ApiEnvelope(z.array(mcpToolVo))
  async list(): Promise<McpToolVo[]> {
    const off = new Set(
      (await this.txHost.tx.getRepository(McpToolSwitch).findBy({ enabled: false })).map(
        (r) => r.name,
      ),
    )
    return this.registry.list().map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      kind: t.kind,
      perm: t.perm,
      enabled: !off.has(t.name),
    }))
  }

  @Put(':name/enabled')
  @RequirePerm(mcpPerms.tool.modify)
  @PlatformOnly()
  @ActionLog({ domain: 'mcp.tool', verb: 'modify', bizId: (req) => req.params.name })
  @ApiOperation({ summary: 'Switch a tool on or off for every token and tenant' })
  @ApiEnvelope()
  async setEnabled(
    @Param('name') name: string,
    @Body({ schema: enabledBody }) { enabled }: EnabledBody,
  ): Promise<null> {
    if (!this.registry.get(name)) throw new BizError(Err.NOT_FOUND)
    // 平台表：一个工具名一行（唯一键 name + alive），没有行时新建
    const by = me().userId
    await this.txHost.tx.query(
      `INSERT INTO cfg_mcp_tool (name, enabled, created_by, updated_by) VALUES (?, ?, ?, ?) AS n
        ON DUPLICATE KEY UPDATE enabled = n.enabled, updated_by = n.updated_by`,
      [name, enabled ? 1 : 0, by, by],
    )
    this.mcp.forgetSwitches()
    return null
  }
}

/**
 * 个人中心建令牌时可选的工具：调用者本人此刻能用的（启用、持有权限点、套餐含其功能），不需要权限点，
 * 在本人的租户里（`@HomeTenant()`）。
 */
@ApiTags('mcp')
@Controller('mcp/my-tools')
@HomeTenant()
export class McpMyToolController {
  constructor(private readonly mcp: McpService) {}

  @Get()
  @ApiOperation({
    summary: 'The tools the caller could use (switched on, perm held), for a new token',
  })
  @ApiEnvelope(z.array(mcpToolVo))
  async list(): Promise<McpToolVo[]> {
    return (await this.mcp.usable(me())).map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      kind: t.kind,
      perm: t.perm,
      enabled: true,
    }))
  }
}

/**
 * 个人中心“访问令牌”：只操作调用者本人的令牌，在本人的租户里（`@HomeTenant()`），不需要权限点。
 * 新建要再输一次当前密码：仅凭一个登录会话不能签发长期凭据。
 */
@ApiTags('mcp')
@Controller('mcp/my-tokens')
@HomeTenant()
export class McpMyTokenController {
  constructor(
    private readonly tokens: AccessTokenService,
    private readonly auth: AuthService,
    private readonly sessions: TokenService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Own access tokens (revoked and expired ones too), newest first' })
  @ApiEnvelope(z.array(accessTokenVo))
  list() {
    return this.tokens.mine(me().userId)
  }

  @Post()
  @RateLimit(20, 60_000)
  @Idempotent()
  @ActionLog({
    domain: 'mcp.token',
    verb: 'create',
    bizId: (_req, r) => (r as { id?: number })?.id,
  })
  @ApiOperation({
    summary: 'New access token (current password required); the token is answered this once only',
  })
  @ApiEnvelope(accessTokenCreatedVo)
  async create(@Body({ schema: accessTokenCreate }) dto: AccessTokenCreate, @Req() req: Request) {
    const p = me()
    // 凭据版本在验密之前读：验密之后若改密、重置或停用，新建的令牌随即作废（409）
    const credVer = await this.sessions.credVersion(p.userId)
    // 试错计数与锁定同锁屏校验：连续输错会结束该用户的全部会话
    await this.auth.verifyPassword(p, dto.currentPassword, clientOf(req))
    return this.tokens.create(p.userId, dto, credVer)
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @ActionLog({ domain: 'mcp.token', verb: 'revoke' })
  @ApiOperation({ summary: 'Revoke an own token (at once, for good)' })
  @ApiEnvelope()
  async revoke(@Param('id', ParseIntPipe) id: number): Promise<null> {
    await this.tokens.revokeMine(me().userId, id)
    return null
  }
}

/** 租户管理员：查看与吊销本租户全部用户的访问令牌（别的租户的令牌 404）。 */
@ApiTags('mcp')
@Controller('mcp/tokens')
export class McpTokenController {
  constructor(private readonly tokens: AccessTokenService) {}

  @Get()
  @RequirePerm(mcpPerms.token.browse)
  @ApiOperation({ summary: 'Page of the tenant’s access tokens with their owners' })
  @ApiEnvelope(pageVo(accessTokenAdminVo))
  page(@Query({ schema: accessTokenQuery }) query: AccessTokenQuery) {
    return this.tokens.page(query)
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @RequirePerm(mcpPerms.token.revoke)
  @ActionLog({ domain: 'mcp.token', verb: 'revoke' })
  @ApiOperation({ summary: 'Revoke a token of the tenant (at once, for good)' })
  @ApiEnvelope()
  async revoke(@Param('id', ParseIntPipe) id: number): Promise<null> {
    await this.tokens.revoke(id)
    return null
  }
}
