import { Body, Controller, Get, Inject, Injectable, Param, Put } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  agentPerms,
  type AgentMyToolVo,
  agentToolEnabledUpdate,
  type AgentToolPolicy,
  agentToolPolicyUpdate,
  type AgentToolVo,
  agentToolVo,
  Err,
  type MCP_TOOL_KINDS,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../audit/action-log.js'
import { RequirePerm } from '../../auth/decorators.js'
import { PlatformOnly } from '../../auth/platform-only.js'
import type { Principal } from '../../auth/principal.js'
import { clsGet } from '../../context/cls.js'
import { ApiEnvelope } from '../../http/api-envelope.decorator.js'
import { BizError } from '../../http/biz-error.js'
import { McpRegistry } from '../../mcp/mcp-registry.js'
import { McpToolSwitch } from '../../mcp/mcp.entity.js'
import { ToolHost } from '../../mcp/tool-host.js'
import { EXTERNAL_TOOL_SOURCE, type ExternalToolSource } from '../agent-ports.js'
import { AgentExtensions } from '../runtime/agent-extensions.js'
import { WEB_TOOLS } from '../web/web-tools.js'
import { AgentRootOnly } from './root-only.js'

type Kind = (typeof MCP_TOOL_KINDS)[number]

/** 默认的审批策略：只读直接执行；写入需确认（高风险的写入只能由人确认）。 */
export const defaultPolicy = (kind: Kind, highRisk = false): AgentToolPolicy =>
  kind === 'write' ? (highRisk ? 'human' : 'ask') : 'auto'

/** 每类工具接口允许设的策略：只读只有 auto、ask 与 deny，写入只有 ask、human 与 deny。 */
export const allowedPolicy = (kind: Kind, policy: AgentToolPolicy): boolean =>
  kind === 'write' ? policy !== 'auto' : policy !== 'human'

/**
 * 实际生效的策略：deny 总是生效；只读工具只有 root 显式设了 ask（如花钱的生成图片）才停下问人，其余一律
 * auto；写入工具取显式的 ask 或 human，否则按默认——库里被直接写成 auto 的写入也按默认（写入从不自动
 * 执行，高风险的不因此放宽成 ask）。
 */
export const effectivePolicy = (
  kind: Kind,
  stored: AgentToolPolicy | null,
  highRisk = false,
): AgentToolPolicy => {
  if (stored === 'deny') return 'deny'
  if (kind !== 'write') return stored === 'ask' ? 'ask' : 'auto'
  return stored === 'ask' || stored === 'human' ? stored : defaultPolicy(kind, highRisk)
}

type Source = 'local' | 'web' | 'builtin'

/**
 * 本系统工具（`@McpTool` 注册的本地工具、内置的 web.search / web.fetch 与运行时的内置工具）在智能体里的
 * 审批策略（see docs/agent.md）：存在 `cfg_mcp_tool.agent_policy`（平台表，按工具名一行；null 为按类型默认）。
 * 运行时用 {@link policies} 取全部工具此刻生效的策略；内置工具的启停也存在同一行的 `enabled`。
 */
@Injectable()
export class AgentToolPolicies {
  constructor(
    private readonly registry: McpRegistry,
    private readonly ext: AgentExtensions,
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly host: ToolHost,
    @Inject(EXTERNAL_TOOL_SOURCE) private readonly external: ExternalToolSource,
  ) {}

  /** 全部本系统工具：名称、标题、类型、来源与权限点。 */
  private known(): {
    name: string
    title: string
    kind: Kind
    source: Source
    perm: string | null
    highRisk: boolean
    humanOnly?: true
  }[] {
    return [
      ...this.registry.list().map((t) => ({
        name: t.name,
        title: t.title,
        kind: t.kind,
        source: 'local' as const,
        perm: t.perm,
        highRisk: t.highRisk === true,
      })),
      ...WEB_TOOLS.map((t) => ({
        name: t.name,
        title: t.title,
        kind: t.kind,
        source: 'web' as const,
        perm: null,
        highRisk: false,
      })),
      // 内置工具按发起人本人的身份办事，自己做权限检查，没有统一的权限点；只能由人确认的按高风险
      ...this.ext.allBuiltins().map((t) => ({
        name: t.meta.name,
        title: t.meta.title,
        kind: t.meta.kind,
        source: 'builtin' as const,
        perm: null,
        highRisk: t.meta.humanOnly === true,
        ...(t.meta.humanOnly && { humanOnly: true as const }),
      })),
    ]
  }

  /** 库里的显式策略，按工具名。 */
  private async stored(): Promise<Map<string, AgentToolPolicy>> {
    const rows = await this.rows()
    return new Map(rows.filter((r) => r.agentPolicy !== null).map((r) => [r.name, r.agentPolicy!]))
  }

  private rows(): Promise<McpToolSwitch[]> {
    return this.txHost.tx.getRepository(McpToolSwitch).find()
  }

  /**
   * 平台页的工具列表：每个工具此刻生效的策略、是否是类型默认，以及平台开关（没有行的为启用）。只能由人确认的
   * 内置工具（`humanOnly`）除停用外一律显示 human：运行时就是这样对待它的，页面不能显示一个更宽的策略。
   */
  async list(): Promise<AgentToolVo[]> {
    const rows = new Map((await this.rows()).map((r) => [r.name, r]))
    return this.known()
      .map(({ highRisk, ...t }) => {
        const row = rows.get(t.name)
        const stored = row?.agentPolicy ?? null
        const policy = effectivePolicy(t.kind, stored, highRisk)
        return {
          ...t,
          policy: t.humanOnly && policy !== 'deny' ? ('human' as const) : policy,
          defaulted: stored === null,
          enabled: row?.enabled ?? true,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 运行时用：全部本系统工具此刻生效的策略，按工具名（humanOnly 内置工具除 deny 外按 human，与列表一致）。 */
  async policies(): Promise<Map<string, AgentToolPolicy>> {
    const stored = await this.stored()
    return new Map(
      this.known().map((t) => {
        const policy = effectivePolicy(t.kind, stored.get(t.name) ?? null, t.highRisk)
        return [t.name, t.humanOnly && policy !== 'deny' ? 'human' : policy]
      }),
    )
  }

  /**
   * 调用者能放进配置方案工具清单的工具：本人此刻能触达的本系统工具（权限点、套餐功能，平台启用）、联网工具、
   * 平台启用的内置工具和已启用的外部 MCP 工具；策略为 deny 或被停用的不列（运行时也不会提供它们）。
   * 只用智能体自己的登记表与 ToolHost，不经 McpModule，所以 `APP_MCP` 关着时同样可用。
   */
  async pickable(p: Principal): Promise<AgentMyToolVo[]> {
    const reachable = new Set((await this.host.list(p)).map((t) => t.name))
    const own = (await this.list())
      .filter(
        (t) => t.policy !== 'deny' && t.enabled && (t.source !== 'local' || reachable.has(t.name)),
      )
      .map((t) => ({ name: t.name, title: t.title, kind: t.kind, origin: t.source }))
    // 外部工具的来源已去掉停用的服务器、停用的与 deny 的工具；类型与运行时一致：只有 auto 的按只读执行
    const external = (await this.external.list(p)).map((d) => ({
      name: d.name,
      title: d.title,
      kind: d.policy === 'auto' ? ('read' as const) : ('write' as const),
      origin: 'mcp' as const,
    }))
    return [...own, ...external]
  }

  /**
   * 设一个工具的策略（null 回到默认）；未知工具 404，不是这类工具可设的策略回 400。
   */
  async set(name: string, policy: AgentToolPolicy | null, by: number): Promise<null> {
    const tool = this.known().find((t) => t.name === name)
    if (!tool) throw new BizError(Err.NOT_FOUND)
    // 写入工具从不自动执行（只能 ask、human 或 deny）；读取工具不送审，也就没有 human（只能 auto、ask 或 deny）
    if (policy !== null && !allowedPolicy(tool.kind, policy))
      throw new BizError(Err.VALIDATION_FAILED)
    // 只能由人确认的内置工具只有 human 或 deny：设成 ask 运行时也不会送审或放行，存下来只会让页面显示失真
    if (tool.humanOnly && policy !== null && policy !== 'human' && policy !== 'deny')
      throw new BizError(Err.VALIDATION_FAILED)
    // 平台表：一个工具名一行（唯一键 name + alive），没有行时新建（启用状态保持默认的启用）
    await this.txHost.tx.query(
      `INSERT INTO cfg_mcp_tool (name, enabled, agent_policy, created_by, updated_by) VALUES (?, 1, ?, ?, ?) AS n
        ON DUPLICATE KEY UPDATE agent_policy = n.agent_policy, updated_by = n.updated_by`,
      [name, policy, by, by],
    )
    return null
  }

  /**
   * 启用或停用一个内置工具（停用后运行时按 deny，模型拿不到它）；未知工具 404，不是内置工具的回 400
   * （本系统其他工具的启停在 MCP 工具页，同时管着外部 MCP 访问）。
   */
  async setEnabled(name: string, enabled: boolean, by: number): Promise<null> {
    const tool = this.known().find((t) => t.name === name)
    if (!tool) throw new BizError(Err.NOT_FOUND)
    if (tool.source !== 'builtin') throw new BizError(Err.VALIDATION_FAILED)
    await this.txHost.tx.query(
      `INSERT INTO cfg_mcp_tool (name, enabled, created_by, updated_by) VALUES (?, ?, ?, ?) AS n
        ON DUPLICATE KEY UPDATE enabled = n.enabled, updated_by = n.updated_by`,
      [name, enabled ? 1 : 0, by, by],
    )
    return null
  }
}

/** 平台页“智能体设置 · 工具策略”：本系统工具的审批策略，对所有租户生效；改动只有 root。 */
@ApiTags('agent')
@Controller('agent/tools')
@AgentRootOnly()
export class AgentToolPolicyController {
  constructor(private readonly policies: AgentToolPolicies) {}

  @Get()
  @RequirePerm(agentPerms.setting.browse)
  @PlatformOnly()
  @ApiOperation({ summary: "This system's tools with their approval policy in the agent" })
  @ApiEnvelope(z.array(agentToolVo))
  list() {
    return this.policies.list()
  }

  @Put(':name/policy')
  @RequirePerm(agentPerms.setting.modify)
  @PlatformOnly('root')
  @ActionLog({ domain: 'agent.tool', verb: 'modify', bizId: (req) => req.params.name })
  @ApiOperation({
    summary:
      'Set a tool policy; null resets to the default; read takes auto, ask or deny, write ask, human or deny',
  })
  @ApiEnvelope()
  set(
    @Param('name') name: string,
    @Body({ schema: agentToolPolicyUpdate }) dto: z.infer<typeof agentToolPolicyUpdate>,
  ) {
    const p = clsGet('principal')
    if (!p) throw new BizError(Err.UNAUTHENTICATED)
    return this.policies.set(name, dto.policy, p.userId)
  }

  @Put(':name/enabled')
  @RequirePerm(agentPerms.setting.modify)
  @PlatformOnly('root')
  @ActionLog({ domain: 'agent.tool', verb: 'modify', bizId: (req) => req.params.name })
  @ApiOperation({ summary: 'Switch a built-in agent tool on or off for every tenant' })
  @ApiEnvelope()
  setEnabled(
    @Param('name') name: string,
    @Body({ schema: agentToolEnabledUpdate }) dto: z.infer<typeof agentToolEnabledUpdate>,
  ) {
    const p = clsGet('principal')
    if (!p) throw new BizError(Err.UNAUTHENTICATED)
    return this.policies.setEnabled(name, dto.enabled, p.userId)
  }
}
