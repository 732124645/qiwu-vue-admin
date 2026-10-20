import { Inject, Injectable } from '@nestjs/common'
import { Err, MCP_TOKEN_PREFIX, OAUTH_SCOPE_MCP, OAUTH_SCOPE_MCP_WRITE } from '@qiwu/shared'
import type { Request } from 'express'
import { PermVersion } from '../auth/perm-version.js'
import type { Principal } from '../auth/principal.js'
import { SessionCurrent } from '../auth/session-current.js'
import { TENANT_LOOKUP, type TenantLookup } from '../auth/tenant-lookup.js'
import {
  isFirstParty,
  type SessionUser,
  TenantUnavailable,
  TokenService,
} from '../auth/token.service.js'
import { withTenant } from '../context/tenant.js'
import { BizError } from '../http/biz-error.js'
import { AccessTokenService, tokenDigest } from './access-token.service.js'

/** The client name a personal access token's calls carry in the logs (`Principal.clientId`). */
export const MCP_TOKEN_CLIENT = 'mcp-token'

/** Who calls the MCP endpoint, as the verified token says. */
export interface McpCaller {
  /** `token`: a personal access token; `oauth`: an OAuth2 access token with scope `mcp` */
  kind: 'token' | 'oauth'
  /** `iam_access_token.id`, or the OAuth2 session id */
  id: string
  /** the token's user, tenant and perms (never another tenant a platform user entered) */
  principal: Principal
  tenantId: number
  /**
   * the tools the token lists; null = every tool, tools registered later included (write tools still need
   * `allowWrite`)
   */
  tools: string[] | null
  allowWrite: boolean
  /** the rate-limit bucket: unique to the token itself (a personal token's id may come again after a database reset) */
  bucket: string
}

const BEARER = /^Bearer ([\w-]{1,128})$/

/** The principal of a reloaded user, built like AuthGuard builds a session's. */
function principalOf(
  u: SessionUser & { userId: number; tenantId: number },
  extra: { clientId: string; sid?: string },
): Principal {
  return {
    userId: u.userId,
    username: u.username,
    deptName: u.deptName,
    sid: extra.sid,
    userType: u.userType,
    clientId: extra.clientId,
    deptId: u.deptId,
    deptTreePath: u.deptTreePath,
    roles: u.roles,
    perms: u.perms,
    root: u.root === true,
    tenantAdmin: u.tenantAdmin === true,
    tenantId: u.tenantId,
    features: u.features,
    locale: u.locale,
  }
}

/**
 * MCP 端点的认证（see docs/mcp.md）：身份与租户只来自校验过的令牌，绝不读请求头选租户。
 * 个人访问令牌按摘要查到行，再在该行的租户里重新加载用户（停用、删除、租户不可用都拒绝）；OAuth2
 * 令牌必须是第三方客户端的、带 `mcp` 范围的用户会话（受众即 MCP 资源；控制台会话与客户端凭据
 * 令牌都不行），并像 AuthGuard 一样重新加载。平台人员“进入租户”的状态不经 MCP 使用。
 * 返回 null 表示 401（未知、过期、吊销都一样）；明确越权的抛 403。
 */
@Injectable()
export class McpAuth {
  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionCurrent,
    private readonly permVersion: PermVersion,
    @Inject(TENANT_LOOKUP) private readonly tenants: TenantLookup,
  ) {}

  /** 解析请求的 Bearer 令牌；null = 401。 */
  async resolve(req: Request): Promise<McpCaller | null> {
    const raw = BEARER.exec(req.headers.authorization ?? '')?.[1]
    if (!raw) return null
    const caller = raw.startsWith(MCP_TOKEN_PREFIX)
      ? await this.personal(raw)
      : await this.oauth(raw)
    if (!caller) return null
    // 绑定了域名的租户：另一个租户的令牌只能在它自己的域名上用（同 AuthGuard）
    const hostTenant = req.hostname ? await this.tenants.byHost(req.hostname) : null
    if (hostTenant !== null && hostTenant !== caller.tenantId) return null
    return caller
  }

  private async personal(raw: string): Promise<McpCaller | null> {
    const t = await this.accessTokens.verify(raw)
    if (!t) return null
    // qw:cross-tenant 令牌行的租户就是它所属用户的租户，在其中重新加载用户
    const u = await withTenant(t.tenantId, () => this.permVersion.load(t.userId))
    if (!u || u.userId === null || u.tenantId !== t.tenantId) return null
    return {
      kind: 'token',
      id: String(t.id),
      principal: principalOf(
        { ...u, userId: u.userId, tenantId: t.tenantId },
        { clientId: MCP_TOKEN_CLIENT },
      ),
      tenantId: t.tenantId,
      tools: t.tools,
      allowWrite: t.allowWrite,
      bucket: `token:${tokenDigest(raw).slice(0, 32)}`,
    }
  }

  private async oauth(raw: string): Promise<McpCaller | null> {
    let s = await this.tokens.authenticate(raw).catch((e: unknown) => {
      if (e instanceof TenantUnavailable) return null
      throw e
    })
    // 受众检查：只认第三方客户端为 MCP 资源申请的令牌
    if (!s || isFirstParty(s.clientId) || !s.scopes.includes(OAUTH_SCOPE_MCP)) return null
    s = await this.sessions.current(s).catch((e: unknown) => {
      if (e instanceof TenantUnavailable) return null
      throw e
    })
    if (!s) return null
    // 客户端凭据令牌不代表任何用户
    if (s.userId === null) throw new BizError(Err.OAUTH_INSUFFICIENT_SCOPE)
    // 进入租户的状态只属于控制台会话，这里出现即拒绝
    if (s.actingTenantId !== undefined || s.tenantId === undefined)
      throw new BizError(Err.FORBIDDEN)
    return {
      kind: 'oauth',
      id: s.sid,
      principal: principalOf(
        { ...s, userId: s.userId, tenantId: s.tenantId },
        { clientId: s.clientId, sid: s.sid },
      ),
      tenantId: s.tenantId,
      tools: null,
      allowWrite: s.scopes.includes(OAUTH_SCOPE_MCP_WRITE),
      bucket: `oauth:${s.sid}`,
    }
  }
}
