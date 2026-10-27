import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Err } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { AuditWriter } from '../../audit/audit-writer.js'
import type { Principal } from '../../auth/principal.js'
import { tenantIdIfAny } from '../../context/tenant.js'
import { argsJson } from '../../mcp/tool-host.js'
import type { ElicitHandler, ExternalToolDescriptor, ExternalToolSource } from '../agent-ports.js'
import { AgentMcpServer, AgentMcpTool } from '../entities/agent-mcp.entity.js'
import { wrapUntrusted } from '../web/web-tools.js'
import { McpConnectFailure, McpConnector } from './mcp-connector.js'
import { MCP_DESCRIPTION_MAX, AgentMcpServerService } from './mcp-server.service.js'

/** Characters of a tool's answer handed to the model (before the untrusted wrapping). */
export const EXT_TEXT_MAX = 20_000
/** Longest part of a model-facing name taken from a server or tool name. */
const NAME_PART_MAX = 40

/** 名字的一段：只留字母、数字与 `-`（模型侧工具名的通用子集），空了用 `fallback`。 */
function part(raw: string, fallback: string): string {
  const s = raw
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, NAME_PART_MAX)
    .replace(/-$/, '')
  return s || fallback
}

/** 工具答复里的内容块转成文本：文字原样，结构化内容转 JSON，其他类型只留一个占位说明。 */
function resultText(r: CallToolResult): string {
  const parts: string[] = []
  for (const c of r.content ?? []) {
    if (c.type === 'text') parts.push(c.text)
    else if (c.type === 'resource' && 'text' in c.resource) parts.push(String(c.resource.text))
    else parts.push(`[${c.type} content omitted]`)
  }
  if (!parts.length && r.structuredContent !== undefined)
    parts.push(JSON.stringify(r.structuredContent))
  return parts.join('\n')
}

const capped = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n[... truncated]` : text

/**
 * 外部 MCP 工具给智能体运行时的来源（ExternalToolSource，see docs/agent.md）：只列出启用服务器上启用且
 * 策略不是 deny 的工具，名字是 `ext.<服务器>.<工具>`（规整后唯一）；描述来自服务器、截断后只放在工具的
 * 描述字段里，不进系统提示。调用时参数原样转发，答复按不可信外部内容包装并限长，每次调用记一条操作日志。
 */
@Injectable()
export class AgentExternalTools implements ExternalToolSource {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly servers: AgentMcpServerService,
    private readonly connector: McpConnector,
    private readonly audit: AuditWriter,
  ) {}

  /** 当前可用的外部工具与它们对应的服务器、工具行（平台表，所有租户共用）。 */
  private async entries(): Promise<
    { d: ExternalToolDescriptor; server: AgentMcpServer; tool: AgentMcpTool }[]
  > {
    const servers = await this.ds
      .getRepository(AgentMcpServer)
      .find({ where: { enabled: true }, order: { id: 'ASC' } })
    if (!servers.length) return []
    const tools = await this.ds
      .getRepository(AgentMcpTool)
      .find({ where: { enabled: true }, order: { id: 'ASC' } })
    const out: { d: ExternalToolDescriptor; server: AgentMcpServer; tool: AgentMcpTool }[] = []
    const taken = new Set<string>()
    for (const server of servers) {
      const s = part(server.name, `s${server.id}`)
      for (const tool of tools) {
        if (Number(tool.serverId) !== Number(server.id) || tool.policy === 'deny') continue
        let name = `ext.${s}.${part(tool.name, `t${tool.id}`)}`
        // 规整后撞名：加上工具 id 区分（id 不变，名字稳定）
        if (taken.has(name)) name = `${name}-${tool.id}`
        taken.add(name)
        out.push({
          server,
          tool,
          d: {
            name,
            title: (tool.title ?? tool.name).slice(0, 200),
            description: (tool.description ?? '').slice(0, MCP_DESCRIPTION_MAX),
            parameters: tool.inputSchema ?? { type: 'object' },
            // 只有 auto 按只读执行；ask 与 human 都按写入等人（ask 在自动审查模式下可先送审）
            policy: tool.policy,
            serverName: server.name,
          },
        })
      }
    }
    return out
  }

  /** 当前可用的外部工具（服务器与工具都已启用、策略不是 deny）。 */
  async list(_p: Principal): Promise<ExternalToolDescriptor[]> {
    return (await this.entries()).map((e) => e.d)
  }

  /**
   * 调用一个外部工具：工具须仍可用（否则当作不存在）；参数须是不过深过大的对象；服务器中途的
   * elicitation 交给 `onElicit`。答复（成功或工具自己报的错）按不可信内容包装并限长；连接失败只给原因码。
   * 调用方中止时原样抛出中止原因。
   */
  async call(
    p: Principal,
    name: string,
    args: unknown,
    ctx: { signal: AbortSignal; onElicit: ElicitHandler },
  ): Promise<{ ok: boolean; text: string }> {
    const started = Date.now()
    const entry = (await this.entries()).find((e) => e.d.name === name)
    if (!entry) return { ok: false, text: `Unknown or disabled tool: ${name.slice(0, 120)}` }
    const json = argsJson(args ?? {})
    if (json === null || !args || typeof args !== 'object' || Array.isArray(args)) {
      this.log(p, entry.d, args, Err.VALIDATION_FAILED.key, started)
      return { ok: false, text: 'The arguments must be a JSON object within the size limits.' }
    }
    // 取含密文的那一行（凭据只在这里解开，用于连接）
    const row = await this.servers.rowWithSecret(Number(entry.server.id))
    try {
      const r = await this.connector.callTool(
        this.servers.target(row),
        entry.tool.name,
        args as Record<string, unknown>,
        ctx,
      )
      const ok = r.isError !== true
      this.log(p, entry.d, args, ok ? undefined : Err.AGENT_MCP_SERVER_FAILED.key, started)
      return {
        ok,
        text: wrapUntrusted(
          `mcp:${entry.d.serverName}/${entry.tool.name}`,
          capped(resultText(r), EXT_TEXT_MAX),
        ),
      }
    } catch (e) {
      if (!(e instanceof McpConnectFailure)) throw e
      this.log(p, entry.d, args, Err.AGENT_MCP_SERVER_FAILED.key, started)
      return { ok: false, text: `The external MCP server failed (${e.reason}).` }
    }
  }

  /** 每次调用一条操作日志（与本系统工具同一个 `mcp.tool` / `call`），参数按密钥名遮蔽；不阻塞、不抛出。 */
  private log(
    p: Principal,
    d: ExternalToolDescriptor,
    args: unknown,
    errorKey: string | undefined,
    started: number,
  ): void {
    const tenantId = tenantIdIfAny()
    if (tenantId === undefined) return
    this.audit.action({
      domain: 'mcp.tool',
      verb: 'call',
      bizId: d.name.slice(0, 64),
      method: 'POST',
      url: '/api/agent/external-tools',
      ip: null,
      ua: '',
      params: {
        agent: true,
        channel: 'external',
        server: d.serverName,
        tool: d.name,
        ...(argsJson(args) !== null && { arguments: args }),
      },
      result: undefined,
      errorKey,
      costMs: Date.now() - started,
      context: {
        tenantId,
        actor: {
          userId: p.userId,
          username: p.username,
          userType: p.userType,
          deptName: p.deptName,
        },
      },
    })
  }
}
