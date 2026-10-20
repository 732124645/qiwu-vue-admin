import { z } from 'zod'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'

/**
 * Agent access over MCP (see docs/mcp.md), only while the server runs with `APP_MCP=true` (otherwise
 * every route below answers 404 and the menus are hidden). Field labels `field.mcp.<resource>.<prop>`.
 *
 * - `POST /api/mcp`: the MCP Streamable HTTP endpoint (JSON-RPC `initialize`, `tools/list`,
 *   `tools/call`), authenticated by a personal access token or an OAuth2 access token with scope `mcp`.
 * - `GET /api/mcp/tools` (`mcp.tool.browse`, platform page) → `McpToolVo[]`;
 *   `PUT /api/mcp/tools/:name/enabled` (`mcp.tool.modify`) `enabledBody` → null.
 * - The caller's own usable tools (personal center, no perm): `GET /api/mcp/my-tools` → `McpToolVo[]`
 *   (switched on, perm held; what a new token may pick from).
 * - Own tokens (personal center, no perm): `GET /api/mcp/my-tokens` → `AccessTokenVo[]`;
 *   `POST /api/mcp/my-tokens` `accessTokenCreate` → `AccessTokenCreatedVo` (the token, this once);
 *   `POST /api/mcp/my-tokens/:id/revoke` → null.
 * - The tenant's tokens (tenant administrators): `GET /api/mcp/tokens?<accessTokenQuery>`
 *   (`mcp.token.browse`) → `{ items: AccessTokenAdminVo[], total }`; `POST /api/mcp/tokens/:id/revoke`
 *   (`mcp.token.revoke`) → null.
 */

export const mcpPerms = {
  tool: { browse: 'mcp.tool.browse', modify: 'mcp.tool.modify' },
  token: { browse: 'mcp.token.browse', revoke: 'mcp.token.revoke' },
} as const

/** What a tool does: `read` tools are open to every token, `write` tools only to tokens allowing them. */
export const MCP_TOOL_KINDS = ['read', 'write'] as const
export type McpToolKind = (typeof MCP_TOOL_KINDS)[number]

/** A tool name: `<domain>.<resource>.<verb>` like a permission code (`iam.user.search`). */
export const MCP_TOOL_NAME = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2}$/

/** Every personal access token starts with this; the rest is random (shown once, stored as a digest). */
export const MCP_TOKEN_PREFIX = 'qwmcp_'
/** The longest lifetime a token may be given; no expiry at all is allowed too. */
export const MCP_TOKEN_TTL_DAYS_MAX = 90
/** Live (not revoked, not expired) tokens one user may hold. */
export const MCP_TOKEN_MAX_PER_USER = 20

/**
 * Emergency stop (root only): `true` makes every `tools/call` answer "paused" at once (`tools/list`
 * still answers, tokens stay); back to `false` and calls work again.
 */
export const MCP_PAUSED_PARAM = 'mcp.paused'

export const mcpToolVo = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  kind: z.enum(MCP_TOOL_KINDS),
  /** the permission a caller needs; null = any signed-in user */
  perm: z.string().nullable(),
  /** false: switched off on the platform page, every call refused */
  enabled: z.boolean(),
})
export type McpToolVo = z.infer<typeof mcpToolVo>

const toolName = z.string().regex(MCP_TOOL_NAME).max(96)

/** POST /my-tokens: a new token of the caller, in the caller's own tenant. */
export const accessTokenCreate = z
  .object({
    name: z.string().trim().min(1).max(64),
    /** days until it expires (1 … 90); null or absent: it never expires */
    expiresInDays: z.number().int().min(1).max(MCP_TOKEN_TTL_DAYS_MAX).nullish(),
    /** the tools it may call (registered names); null or absent: every tool (write tools still need allowWrite) */
    tools: z.array(toolName).min(1).max(100).nullish(),
    /** write tools only with this; a listed write tool without it is refused (403 B7003) */
    allowWrite: z.boolean().default(false),
    /** the caller's password: a long-lived credential is never minted by a session alone */
    currentPassword: z.string().min(1).max(128),
  })
  .register(fieldDomains, { domain: 'mcp.token' })
export type AccessTokenCreate = z.infer<typeof accessTokenCreate>

/** A token as its owner sees it: never the token itself, only its last characters. */
export const accessTokenVo = z.object({
  id: z.number().int(),
  name: z.string(),
  /** the token's last characters, to tell tokens apart */
  tokenHint: z.string(),
  tools: z.array(z.string()).nullable(),
  allowWrite: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})
export type AccessTokenVo = z.infer<typeof accessTokenVo>

/** The answer of POST /my-tokens: the token in full, this once. */
export const accessTokenCreatedVo = accessTokenVo.extend({ token: z.string() })
export type AccessTokenCreatedVo = z.infer<typeof accessTokenCreatedVo>

/** A row of the tenant's token list: the owner named. */
export const accessTokenAdminVo = accessTokenVo.extend({
  userId: z.number().int(),
  username: z.string(),
  displayName: z.string(),
})
export type AccessTokenAdminVo = z.infer<typeof accessTokenAdminVo>

/** `active`: usable now; `revoked`; `expired`. */
export const ACCESS_TOKEN_STATES = ['active', 'revoked', 'expired'] as const

/** GET /tokens: the tenant's tokens, newest first by default. */
export const accessTokenQuery = pageQuery(['createdAt', 'lastUsedAt', 'expiresAt', 'id'])
  .extend({
    userId: z.coerce.number().int().positive().optional(),
    name: z.string().trim().max(64).optional(),
    state: z.enum(ACCESS_TOKEN_STATES).optional(),
  })
  .register(fieldDomains, { domain: 'mcp.token' })
export type AccessTokenQuery = z.output<typeof accessTokenQuery>
