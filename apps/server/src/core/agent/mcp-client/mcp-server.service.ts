import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { Injectable } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import {
  type AgentExternalToolVo,
  type AgentMcpServerSave,
  type AgentMcpServerVo,
  type AGENT_TOOL_POLICIES,
  Err,
  fieldDomains,
} from '@qiwu/shared'
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js'
import { z } from 'zod'
import type { Principal } from '../../auth/principal.js'
import { AppConfigService } from '../../config/config.module.js'
import { deriveKey, open, type Sealed, seal } from '../../crypto/secret-box.js'
import { BaseCrudService } from '../../db/base-crud.service.js'
import { softDeleteRows } from '../../db/references.js'
import { canonicalJson } from '../../guard/idempotent.js'
import { BizError } from '../../http/biz-error.js'
import { parseOr400, ValidationException } from '../../http/validation.pipe.js'
import { isBlockedAddress } from '../../net/net-guard.js'
import { AgentMcpServer, AgentMcpTool } from '../entities/agent-mcp.entity.js'
import { guardedFetch } from './guarded-fetch.js'
import {
  MCP_CONNECT_TIMEOUT_MS,
  McpConnectFailure,
  McpConnector,
  type McpTarget,
} from './mcp-connector.js'

/** HKDF label of the key sealing server credentials (same APP_SECRET, its own label). */
const KEY_INFO = 'qw:agent-mcp-auth:v1'
const TABLE = 'agent_mcp_server'
/** Characters kept of a tool's description and title from a server (untrusted text). */
export const MCP_DESCRIPTION_MAX = 1024
const MCP_TITLE_MAX = 200
/** The largest input schema kept from a server (UTF-8 bytes of its JSON); a larger one becomes `{type:'object'}`. */
export const MCP_SCHEMA_MAX_BYTES = 16 * 1024
/** The largest OAuth token answer read. */
const TOKEN_MAX_BYTES = 64 * 1024
/** A token is renewed this long before it expires. */
const TOKEN_MARGIN_MS = 30_000
/** A tool name kept from a server: printable, no spaces, at most the column's length. */
const TOOL_NAME = /^[\w.\-/:]{1,128}$/

/** Headers a header credential may not set: they belong to the transport. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-type',
  'content-length',
  'accept',
  'accept-encoding',
  'connection',
  'transfer-encoding',
  'user-agent',
  'cookie',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
])

const headerAuth = z
  .object({
    name: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,64}$/)
      .refine((n) => !RESERVED_HEADERS.has(n.toLowerCase())),
    value: z.string().min(1).max(2048),
  })
  .strict()
const oauthAuth = z
  .object({
    tokenUrl: z.url({ protocol: /^https?$/ }).max(512),
    clientId: z.string().min(1).max(256),
    clientSecret: z.string().min(1).max(2048),
    scope: z.string().max(512).optional(),
  })
  .strict()
const authBody = {
  header: z.object({ auth: headerAuth }).register(fieldDomains, { domain: 'agent.mcpServer' }),
  oauth: z.object({ auth: oauthAuth }).register(fieldDomains, { domain: 'agent.mcpServer' }),
}
type HeaderAuth = z.infer<typeof headerAuth>
type OauthAuth = z.infer<typeof oauthAuth>

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null)
const capped = (text: string | null | undefined, max: number) =>
  text ? (text.length > max ? text.slice(0, max) : text) : null

export const externalToolVo = (t: AgentMcpTool): AgentExternalToolVo => ({
  id: Number(t.id),
  name: t.name,
  title: t.title,
  description: t.description,
  readOnlyHint: t.readOnlyHint,
  enabled: t.enabled,
  policy: t.policy,
})

const serverVo = (s: AgentMcpServer, tools: AgentMcpTool[]): AgentMcpServerVo => ({
  id: Number(s.id),
  name: s.name,
  url: s.url,
  authKind: s.authKind,
  hasAuth: !!s.authSecret,
  allowPrivate: s.allowPrivate,
  enabled: s.enabled,
  status: s.status,
  lastError: s.lastError,
  syncedAt: iso(s.syncedAt),
  tools: tools.map(externalToolVo),
})

/** 服务器给的参数 schema：必须是对象且不过大，否则换成空对象 schema（模型照样能调用，参数由服务器校验）。 */
function schemaOf(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { type: 'object' }
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > MCP_SCHEMA_MAX_BYTES) return { type: 'object' }
  } catch {
    return { type: 'object' }
  }
  return raw as Record<string, unknown>
}

/**
 * 已有工具的行为是否变了：描述、参数 schema（按键排序后比较，MySQL 的 JSON 列不保留键序）或只读声明
 * 任一不同。标题只是显示用，不算。
 */
function behaviourChanged(
  stored: AgentMcpTool,
  next: { description: string | null; inputSchema: Record<string, unknown>; readOnlyHint: boolean },
): boolean {
  return (
    (stored.description ?? null) !== next.description ||
    canonicalJson(stored.inputSchema ?? { type: 'object' }) !== canonicalJson(next.inputSchema) ||
    !!stored.readOnlyHint !== next.readOnlyHint
  )
}

/**
 * 保存时就能判断的内网目标：内网 IP 字面量与 localhost（域名在连接时按解析结果再查，防 DNS 重绑定）。
 */
function privateLiteral(raw: string): boolean {
  const host = new URL(raw).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
  return (
    (isIP(host) !== 0 && isBlockedAddress(host)) ||
    host === 'localhost' ||
    host.endsWith('.localhost')
  )
}

/** 地址字段的 400（字段名按 `agent.mcpServer` 域翻译）。 */
function invalidUrl(path: string[]): never {
  const e = new ValidationException([
    { code: 'custom', path, message: 'validation.invalid', input: undefined },
  ])
  e.domain = 'agent.mcpServer'
  throw e
}

/**
 * 平台页“智能体设置 · 外部 MCP”（see docs/agent.md）：外部服务器的增删改、连接同步工具、逐个工具的启用
 * 与审批策略。鉴权信息（请求头令牌、OAuth 客户端凭据）用独立标签的密钥加密存库、只写不读；改了地址或
 * 鉴权方式不重填就拒绝（原凭据不能跟着发到新目标）；只有 root 能让服务器指向内网。
 */
@Injectable()
export class AgentMcpServerService extends BaseCrudService<AgentMcpServer> {
  private readonly key: Buffer
  /** ALLOW_PRIVATE_ENDPOINTS（只用于测试与开发）放开地址检查，同其他出站目标 */
  private readonly deploymentPrivate: boolean
  /** OAuth 令牌缓存（每个实例），按服务器 id；设置一改（版本变了）就不再用 */
  private readonly tokens = new Map<number, { version: string; token: string; until: number }>()

  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    cfg: AppConfigService,
    private readonly connector: McpConnector,
  ) {
    super(txHost, AgentMcpServer)
    this.key = deriveKey(cfg.get('APP_SECRET'), '', KEY_INFO)
    this.deploymentPrivate = cfg.get('ALLOW_PRIVATE_ENDPOINTS')
  }

  private get tools() {
    return this.txHost.tx.getRepository(AgentMcpTool)
  }

  /** 全部服务器（含停用）与其工具；凭据只给出 `hasAuth`。 */
  async list(): Promise<AgentMcpServerVo[]> {
    const servers = await this.repo
      .createQueryBuilder('t')
      .addSelect('t.authSecret')
      .orderBy('t.id', 'ASC')
      .getMany()
    const tools = await this.tools.find({ order: { id: 'ASC' } })
    return servers.map((s) =>
      serverVo(
        s,
        tools.filter((t) => Number(t.serverId) === Number(s.id)),
      ),
    )
  }

  /** 一个服务器（含密文，供解密；密文从不离开服务）；不存在 404。 */
  async rowWithSecret(id: number): Promise<AgentMcpServer> {
    const row = await this.repo
      .createQueryBuilder('t')
      .addSelect('t.authSecret')
      .where('t.id = :id', { id })
      .getOne()
    if (!row) throw new BizError(Err.NOT_FOUND)
    return row
  }

  /** 一个服务器的视图（含工具）。 */
  async one(id: number): Promise<AgentMcpServerVo> {
    const row = await this.rowWithSecret(id)
    return serverVo(row, await this.tools.find({ where: { serverId: id }, order: { id: 'ASC' } }))
  }

  /**
   * 新建（id 为 null）或整体修改一个服务器。内网地址只能由 root 显式勾选；鉴权方式为 none 时清掉凭据，
   * 给了新凭据就换密文，没给时：原来没有凭据、换了鉴权方式或改了地址都要求重填（AGENT_KEY_REQUIRED）。
   */
  async save(p: Principal, id: number | null, dto: AgentMcpServerSave): Promise<AgentMcpServerVo> {
    if (dto.allowPrivate && p.root !== true) throw new BizError(Err.FORBIDDEN)
    const given = dto.auth && Object.keys(dto.auth).length > 0 ? dto.auth : undefined
    const auth =
      dto.authKind !== 'none' && given
        ? parseOr400(authBody[dto.authKind], { auth: given }).auth
        : undefined
    // 内网字面量在保存时就拒绝（域名在每次连接时按解析结果检查）
    if (!dto.allowPrivate && !this.deploymentPrivate) {
      if (privateLiteral(dto.url)) invalidUrl(['url'])
      if (auth && 'tokenUrl' in auth && privateLiteral(auth.tokenUrl))
        invalidUrl(['auth', 'tokenUrl'])
    }
    const saved = await this.txHost.withTransaction(async () => {
      let stored: AgentMcpServer | undefined
      if (id !== null) {
        await this.lockScopedIds([id])
        stored = await this.rowWithSecret(id)
      }
      await this.assertUnique('name', dto.name, id ?? undefined)
      let secret: Sealed | null | undefined
      if (dto.authKind === 'none') secret = null
      else if (auth) secret = seal(this.key, JSON.stringify(auth), TABLE)
      else if (!stored?.authSecret || stored.authKind !== dto.authKind || stored.url !== dto.url)
        // 原凭据不能跟着发到新地址，也不能当成另一种鉴权方式使用
        throw new BizError(Err.AGENT_KEY_REQUIRED)
      const fields = {
        name: dto.name,
        url: dto.url,
        authKind: dto.authKind,
        allowPrivate: dto.allowPrivate,
        enabled: dto.enabled,
        ...(secret !== undefined && { authSecret: secret }),
      }
      if (id === null) return (await this.create({ ...fields, status: 'unknown' })).id
      await this.update(id, fields)
      return id
    })
    this.forget(Number(saved))
    return this.one(Number(saved))
  }

  /** 删除服务器：连同密文与它的工具一起清掉。 */
  async removeOne(id: number): Promise<null> {
    await this.txHost.withTransaction(async () => {
      await this.lockScopedIds([id])
      await this.repo.update(id, { authSecret: null })
      const ids = (await this.tools.find({ select: { id: true }, where: { serverId: id } })).map(
        (t) => Number(t.id),
      )
      await softDeleteRows(this.txHost.tx, 'agent_mcp_tool', ids)
      await this.deleteRows([id])
    })
    this.forget(id)
    return null
  }

  /**
   * 连接服务器并同步工具清单：新工具停用、策略 ask（等管理员看过再启用）；已有工具更新标题、描述、
   * 参数与只读声明，保留管理员设的启用；描述、参数或只读声明变了的，auto 策略退回 ask（管理员审过的 auto
   * 不能被服务器悄悄换掉行为；human/deny 保持不变，只收紧不放宽），这些工具名记在 `lastError`（`tools_changed: …`）里提醒复查；服务器上
   * 已经没有的工具停用。记下连接状态与时间；连接失败记原因码并回 AGENT_MCP_SERVER_FAILED。
   */
  async sync(id: number): Promise<AgentMcpServerVo> {
    const row = await this.rowWithSecret(id)
    if (!row.enabled) throw new BizError(Err.AGENT_MCP_SERVER_FAILED, { reason: 'disabled' })
    let found: Tool[]
    try {
      found = await this.connector.listTools(this.target(row))
    } catch (e) {
      const reason = e instanceof McpConnectFailure ? e.reason : 'protocol'
      await this.repo.update(id, { status: 'error', lastError: reason })
      throw new BizError(Err.AGENT_MCP_SERVER_FAILED, { reason })
    }
    await this.txHost.withTransaction(async () => {
      await this.lockScopedIds([id])
      const existing = await this.tools.findBy({ serverId: id })
      const byName = new Map(existing.map((t) => [t.name, t]))
      const seen = new Set<string>()
      const changed: string[] = []
      for (const t of found) {
        if (typeof t.name !== 'string' || !TOOL_NAME.test(t.name) || seen.has(t.name)) continue
        seen.add(t.name)
        const fields = {
          title: capped(t.title ?? t.annotations?.title, MCP_TITLE_MAX),
          description: capped(t.description, MCP_DESCRIPTION_MAX),
          inputSchema: schemaOf(t.inputSchema),
          readOnlyHint: t.annotations?.readOnlyHint === true,
        }
        const stored = byName.get(t.name)
        if (stored) {
          const reviewed = behaviourChanged(stored, fields)
          if (reviewed) changed.push(t.name)
          await this.tools.update(stored.id, {
            ...fields,
            // 行为变了只能收紧不能放宽：auto 退回 ask；human/deny 原样保留（退回 ask 反而会让写入可以送审或执行）
            ...(reviewed && stored.policy === 'auto' && { policy: 'ask' as const }),
          } as QueryDeepPartialEntity<AgentMcpTool>)
        } else
          await this.tools.save(
            this.tools.create({
              serverId: id,
              name: t.name,
              ...fields,
              enabled: false,
              policy: 'ask',
            }),
          )
      }
      for (const t of existing)
        if (!seen.has(t.name) && t.enabled) await this.tools.update(t.id, { enabled: false })
      await this.repo.update(id, {
        status: 'ok',
        lastError: changed.length ? `tools_changed: ${changed.join(', ')}`.slice(0, 512) : null,
        syncedAt: new Date(),
      })
    })
    return this.one(id)
  }

  /** 一个工具的启用与审批策略（外部工具一律当作可能写入：只有管理员显式设 auto 才直接执行）。 */
  async updateTool(
    serverId: number,
    toolId: number,
    dto: { enabled?: boolean; policy?: (typeof AGENT_TOOL_POLICIES)[number] },
  ): Promise<AgentExternalToolVo> {
    const tool = await this.tools.findOneBy({ id: toolId, serverId })
    if (!tool) throw new BizError(Err.NOT_FOUND)
    const set = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined))
    if (Object.keys(set).length) await this.tools.update(toolId, set)
    return externalToolVo({ ...tool, ...set } as AgentMcpTool)
  }

  /** 连接一个服务器所需的一切：地址、是否允许内网、设置版本与鉴权请求头。 */
  target(row: AgentMcpServer): McpTarget {
    const allowPrivate = row.allowPrivate || this.deploymentPrivate
    // 设置版本：地址、鉴权方式、内网许可与密文的摘要（同步只改状态列，不会让客户端与令牌失效）
    const version = createHash('sha256')
      .update(JSON.stringify([row.url, row.authKind, allowPrivate, row.authSecret ?? null]))
      .digest('hex')
    return {
      id: Number(row.id),
      url: row.url,
      allowPrivate,
      version,
      headers: () => this.authHeaders(row, allowPrivate, version),
    }
  }

  /** 设置改了：关掉空闲客户端、丢掉令牌缓存。 */
  private forget(id: number): void {
    this.connector.forget(id)
    this.tokens.delete(id)
  }

  /** 解出凭据；打不开（APP_SECRET 变了、被改过）按鉴权失败处理。 */
  private credentials<T>(row: AgentMcpServer): T {
    const plain = row.authSecret ? open(this.key, row.authSecret, TABLE) : null
    if (plain === null) throw new McpConnectFailure('key_unreadable')
    return JSON.parse(plain) as T
  }

  /** 每次连接带的鉴权请求头：请求头令牌原样；OAuth 用客户端凭据换令牌，缓存到过期前。 */
  private async authHeaders(
    row: AgentMcpServer,
    allowPrivate: boolean,
    version: string,
  ): Promise<Record<string, string>> {
    if (row.authKind === 'none') return {}
    if (row.authKind === 'header') {
      const h = this.credentials<HeaderAuth>(row)
      return { [h.name]: h.value }
    }
    const id = Number(row.id)
    const hit = this.tokens.get(id)
    if (hit && hit.version === version && hit.until > Date.now())
      return { authorization: `Bearer ${hit.token}` }
    const token = await this.fetchToken(this.credentials<OauthAuth>(row), allowPrivate)
    this.tokens.set(id, { version, token: token.token, until: token.until })
    return { authorization: `Bearer ${token.token}` }
  }

  /** OAuth 客户端凭据模式取令牌（同样经地址检查、超时与大小上限）；任何失败都只报 `auth`。 */
  private async fetchToken(
    a: OauthAuth,
    allowPrivate: boolean,
  ): Promise<{ token: string; until: number }> {
    const fetch = guardedFetch({ allowPrivate, maxBytes: TOKEN_MAX_BYTES })
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: a.clientId,
      client_secret: a.clientSecret,
      ...(a.scope && { scope: a.scope }),
    })
    try {
      const res = await fetch(a.tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form,
        signal: AbortSignal.timeout(MCP_CONNECT_TIMEOUT_MS),
      })
      const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown }
      const token = body.access_token
      if (!res.ok || typeof token !== 'string' || !token || token.length > 4096)
        throw new McpConnectFailure('auth')
      const ttl =
        typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600
      return { token, until: Date.now() + Math.max(ttl * 1000 - TOKEN_MARGIN_MS, 0) }
    } catch {
      throw new McpConnectFailure('auth')
    }
  }
}
