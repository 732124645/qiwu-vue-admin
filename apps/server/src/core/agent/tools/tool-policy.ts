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
  agentToolRestrictionUpdate,
  type AgentToolRestrictionPolicy,
  type AgentToolRestrictionVo,
  agentToolRestrictionVo,
  type AgentToolVo,
  agentToolVo,
  Err,
  type MCP_TOOL_KINDS,
} from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { z } from 'zod'
import { ActionLog } from '../../audit/action-log.js'
import { RequirePerm } from '../../auth/decorators.js'
import { PlatformOnly } from '../../auth/platform-only.js'
import type { Principal } from '../../auth/principal.js'
import { clsGet } from '../../context/cls.js'
import { tenantId } from '../../context/tenant.js'
import { ApiEnvelope } from '../../http/api-envelope.decorator.js'
import { BizError } from '../../http/biz-error.js'
import { McpRegistry } from '../../mcp/mcp-registry.js'
import { McpToolSwitch } from '../../mcp/mcp.entity.js'
import { ToolHost } from '../../mcp/tool-host.js'
import { EXTERNAL_TOOL_SOURCE, type ExternalToolSource } from '../agent-ports.js'
import { AgentMcpTool, AgentToolRestriction } from '../entities/agent-mcp.entity.js'
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

/** 策略从宽到严。 */
const STRICTNESS: readonly AgentToolPolicy[] = ['auto', 'ask', 'human', 'deny']

/**
 * 平台策略叠加租户收紧后的生效策略：取两者中更严的一方。租户行只能收紧（不会放宽平台的 deny / human），平台
 * 之后放宽了也放不宽租户行。读取工具被租户设成 human 时生效值就是 human（每次都由人确认，不能本会话放行）。
 */
export const tighten = (
  platform: AgentToolPolicy,
  tenant: AgentToolRestrictionPolicy | null | undefined,
): AgentToolPolicy =>
  tenant && STRICTNESS.indexOf(tenant) > STRICTNESS.indexOf(platform) ? tenant : platform

/** 外部 MCP 工具在租户收紧表里的键：面向模型的名字不稳定（改名、撞名、重建服务器），按工具行 id。 */
export const externalKey = (toolId: number): string => `mcp:${toolId}`

/**
 * 当前租户对工具的收紧，按工具名（外部工具为 {@link externalKey}）。显式按 `tenantId()` 取：不在单一租户里
 * （`allTenants` 或没有租户上下文）时抛出，不会把各租户的行混在一起，也不会悄悄当作“没有收紧”。
 */
export async function tenantRestrictions(
  m: EntityManager,
): Promise<Map<string, AgentToolRestrictionPolicy>> {
  const rows = await m.getRepository(AgentToolRestriction).find({
    where: { tenantId: tenantId() },
    select: { id: true, tool: true, policy: true },
  })
  return new Map(rows.map((r) => [r.tool, r.policy]))
}

/** 一个工具此刻的策略：平台层、本租户的收紧（没有为 null）与两者叠加后的生效值。 */
export interface ToolPolicyLayers {
  platform: AgentToolPolicy
  tenant: AgentToolRestrictionPolicy | null
  policy: AgentToolPolicy
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

  /**
   * 全部本系统工具此刻的策略分层，按工具名：平台层（humanOnly 内置工具除 deny 外按 human，与平台页一致）、
   * 当前租户的收紧与叠加后的生效值。须在单一租户里调用（见 {@link tenantRestrictions}）。
   */
  async layers(): Promise<Map<string, ToolPolicyLayers>> {
    const stored = await this.stored()
    const tenant = await tenantRestrictions(this.txHost.tx)
    return new Map(
      this.known().map((t) => {
        const raw = effectivePolicy(t.kind, stored.get(t.name) ?? null, t.highRisk)
        const platform = t.humanOnly && raw !== 'deny' ? 'human' : raw
        const restricted = tenant.get(t.name) ?? null
        return [t.name, { platform, tenant: restricted, policy: tighten(platform, restricted) }]
      }),
    )
  }

  /**
   * 运行时用：全部本系统工具此刻生效的策略，按工具名（平台策略叠加当前租户的收紧，取更严的一方）。平台页的
   * {@link list} 只看平台层，不经这里。
   */
  async policies(): Promise<Map<string, AgentToolPolicy>> {
    return new Map([...(await this.layers())].map(([name, l]) => [name, l.policy]))
  }

  /**
   * 调用者能放进配置方案工具清单的工具：本人此刻能触达的本系统工具（权限点、套餐功能，平台启用）、联网工具、
   * 平台启用的内置工具和已启用的外部 MCP 工具；策略为 deny 或被停用的不列（运行时也不会提供它们）。
   * 只用智能体自己的登记表与 ToolHost，不经 McpModule，所以 `APP_MCP` 关着时同样可用。
   */
  async pickable(p: Principal): Promise<AgentMyToolVo[]> {
    const reachable = new Set((await this.host.list(p)).map((t) => t.name))
    // 生效策略（含本租户的收紧）为 deny 的不列：运行时不会提供它们
    const policies = await this.policies()
    const own = (await this.list())
      .filter(
        (t) =>
          policies.get(t.name) !== 'deny' &&
          t.enabled &&
          (t.source !== 'local' || reachable.has(t.name)),
      )
      .map((t) => ({ name: t.name, title: t.title, kind: t.kind, origin: t.source }))
    // 外部工具的来源已去掉停用的服务器、停用的与 deny 的工具；类型与运行时一致：按平台策略，auto 的是读取
    const external = (await this.external.list(p)).map((d) => ({
      name: d.name,
      title: d.title,
      kind: d.kind ?? (d.policy === 'auto' ? ('read' as const) : ('write' as const)),
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
   * 本租户收紧页的工具列表：平台此刻提供的每个工具（本系统工具中平台启用且不是 deny 的，与已启用的外部工具，
   * 外部工具按 `mcp:<id>` 命名），带平台策略、本租户的收紧与生效值。
   */
  async restrictions(p: Principal): Promise<AgentToolRestrictionVo[]> {
    const out: AgentToolRestrictionVo[] = []
    for (const { offered, ...vo } of await this.restrictable(p)) if (offered) out.push(vo)
    return out
  }

  /**
   * 能收紧的全部工具：本系统工具（平台停用或 deny 的也在，`offered` 为假：租户的收紧照样存下，平台之后放开时
   * 仍然有效）与平台此刻提供的外部工具。
   */
  private async restrictable(
    p: Principal,
  ): Promise<(AgentToolRestrictionVo & { offered: boolean })[]> {
    const layers = await this.layers()
    const enabled = new Map((await this.rows()).map((r) => [r.name, r.enabled]))
    const own = this.known().map((t) => {
      const l = layers.get(t.name)!
      const on = enabled.get(t.name) ?? true
      // 平台停用的按 deny 显示（运行时就是这样对待它的）
      const platform = on ? l.platform : 'deny'
      return {
        name: t.name,
        title: t.title,
        kind: t.kind,
        origin: t.source,
        platformPolicy: platform,
        tenantPolicy: l.tenant,
        effective: tighten(platform, l.tenant),
        offered: platform !== 'deny',
      }
    })
    const external = ((await this.external.offered?.(p)) ?? []).map((d) => ({
      name: externalKey(d.id),
      title: d.title,
      kind: d.platformPolicy === 'auto' ? ('read' as const) : ('write' as const),
      origin: 'mcp' as const,
      platformPolicy: d.platformPolicy,
      tenantPolicy: d.restricted ?? null,
      effective: d.policy,
      offered: true,
    }))
    return [...own, ...external].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 设本租户对一个工具的收紧（`human` 或 `deny`；null 去掉收紧）；未知工具 404。只存租户自己的一行，生效值
   * 总取平台与租户中更严的一方，所以这里无论平台此刻是什么都不会放宽。返回这个工具此刻的一行。
   */
  async restrict(
    p: Principal,
    name: string,
    policy: AgentToolRestrictionPolicy | null,
    by: number,
  ): Promise<AgentToolRestrictionVo> {
    // 外部工具按工具行 id：行须还在（停用或平台 deny 的也可以收紧，平台之后放开时仍然有效）
    const ext = /^mcp:([1-9]\d{0,18})$/.exec(name)
    const known = ext
      ? await this.txHost.tx.getRepository(AgentMcpTool).existsBy({ id: Number(ext[1]) })
      : this.known().some((t) => t.name === name)
    if (!known) throw new BizError(Err.NOT_FOUND)
    const tid = tenantId()
    if (policy === null)
      await this.txHost.tx.query(
        `UPDATE agent_tool_restriction SET deleted_at = CURRENT_TIMESTAMP(3), updated_by = ?
          WHERE tenant_id = ? AND tool = ? AND deleted_at IS NULL`,
        [by, tid, name],
      )
    // 一个租户一个工具一行（唯一键 tenant_id + tool + alive）：没有活行时新建，有则改
    else
      await this.txHost.tx.query(
        `INSERT INTO agent_tool_restriction (tenant_id, tool, policy, created_by, updated_by)
          VALUES (?, ?, ?, ?, ?) AS n
          ON DUPLICATE KEY UPDATE policy = n.policy, updated_by = n.updated_by`,
        [tid, name, policy, by, by],
      )
    const row = (await this.restrictable(p)).find((r) => r.name === name)
    // 外部工具的服务器或工具已停用、平台已 deny：不在平台提供的列表里，按存下的收紧回一行
    if (!row) {
      const tool = ext
        ? await this.txHost.tx.getRepository(AgentMcpTool).findOneBy({ id: Number(ext[1]) })
        : null
      return {
        name,
        title: tool?.title ?? tool?.name ?? name,
        kind: tool?.policy === 'auto' ? 'read' : 'write',
        origin: 'mcp',
        platformPolicy: 'deny',
        tenantPolicy: policy,
        effective: 'deny',
      }
    }
    const { offered: _, ...vo } = row
    return vo
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

/**
 * 本租户的工具收紧（租户管理员经套餐拿到权限；不是平台页）：只能把工具收紧为仅人工确认或停用，生效值总取
 * 平台与租户中更严的一方。面向个人访问令牌的 MCP 端点不读智能体策略，这里的收紧只作用于站内智能体。
 */
@ApiTags('agent')
@Controller('agent/tool-restrictions')
export class AgentToolRestrictionController {
  constructor(private readonly policies: AgentToolPolicies) {}

  @Get()
  @RequirePerm(agentPerms.restriction.browse)
  @ApiOperation({
    summary:
      "Every tool the platform offers to the agent with the platform policy, this tenant's restriction and the effective policy",
  })
  @ApiEnvelope(z.array(agentToolRestrictionVo))
  list() {
    const p = clsGet('principal')
    if (!p) throw new BizError(Err.UNAUTHENTICATED)
    return this.policies.restrictions(p)
  }

  @Put(':name')
  @RequirePerm(agentPerms.restriction.modify)
  @ActionLog({ domain: 'agent.restriction', verb: 'modify', bizId: (req) => req.params.name })
  @ApiOperation({
    summary:
      'Tighten a tool for this tenant to human or deny (null removes the restriction); the stricter of platform and tenant applies; 404 for an unknown tool',
  })
  @ApiEnvelope(agentToolRestrictionVo)
  restrict(
    @Param('name') name: string,
    @Body({ schema: agentToolRestrictionUpdate }) dto: z.infer<typeof agentToolRestrictionUpdate>,
  ) {
    const p = clsGet('principal')
    if (!p) throw new BizError(Err.UNAUTHENTICATED)
    return this.policies.restrict(p, name, dto.policy, p.userId)
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
