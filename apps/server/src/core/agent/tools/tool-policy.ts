import { Body, Controller, Get, Injectable, Param, Put } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  agentPerms,
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
import { clsGet } from '../../context/cls.js'
import { ApiEnvelope } from '../../http/api-envelope.decorator.js'
import { BizError } from '../../http/biz-error.js'
import { McpRegistry } from '../../mcp/mcp-registry.js'
import { McpToolSwitch } from '../../mcp/mcp.entity.js'
import { AgentExtensions } from '../runtime/agent-extensions.js'
import { WEB_TOOLS } from '../web/web-tools.js'
import { AgentRootOnly } from './root-only.js'

type Kind = (typeof MCP_TOOL_KINDS)[number]

/** 类型默认的审批策略：只读直接执行，写入停下等人确认。 */
export const defaultPolicy = (kind: Kind): AgentToolPolicy => (kind === 'write' ? 'ask' : 'auto')

/**
 * 实际生效的策略：显式设置优先，否则按类型默认；写入工具即使库里被写成 auto 也按 ask（写入从不自动执行），
 * 只读工具被写成 review 也按 ask（自动审查只为写入工具设计，接口不允许这样设，库里被直接改了也不放宽）。
 */
export const effectivePolicy = (kind: Kind, stored: AgentToolPolicy | null): AgentToolPolicy => {
  const p = stored ?? defaultPolicy(kind)
  if (kind === 'write' && p === 'auto') return 'ask'
  if (kind !== 'write' && p === 'review') return 'ask'
  return p
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
  ) {}

  /** 全部本系统工具：名称、标题、类型、来源与权限点。 */
  private known(): {
    name: string
    title: string
    kind: Kind
    source: Source
    perm: string | null
  }[] {
    return [
      ...this.registry.list().map((t) => ({
        name: t.name,
        title: t.title,
        kind: t.kind,
        source: 'local' as const,
        perm: t.perm,
      })),
      ...WEB_TOOLS.map((t) => ({
        name: t.name,
        title: t.title,
        kind: t.kind,
        source: 'web' as const,
        perm: null,
      })),
      // 内置工具按发起人本人的身份办事，自己做权限检查，没有统一的权限点
      ...this.ext.allBuiltins().map((t) => ({
        name: t.meta.name,
        title: t.meta.title,
        kind: t.meta.kind,
        source: 'builtin' as const,
        perm: null,
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

  /** 平台页的工具列表：每个工具此刻生效的策略、是否是类型默认，以及平台开关（没有行的为启用）。 */
  async list(): Promise<AgentToolVo[]> {
    const rows = new Map((await this.rows()).map((r) => [r.name, r]))
    return this.known()
      .map((t) => {
        const row = rows.get(t.name)
        const stored = row?.agentPolicy ?? null
        return {
          ...t,
          policy: effectivePolicy(t.kind, stored),
          defaulted: stored === null,
          enabled: row?.enabled ?? true,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 运行时用：全部本系统工具此刻生效的策略，按工具名。 */
  async policies(): Promise<Map<string, AgentToolPolicy>> {
    const stored = await this.stored()
    return new Map(
      this.known().map((t) => [t.name, effectivePolicy(t.kind, stored.get(t.name) ?? null)]),
    )
  }

  /**
   * 设一个工具的策略（null 回到类型默认）；未知工具 404，写入工具设 auto、只读工具设 review 回 400。
   */
  async set(name: string, policy: AgentToolPolicy | null, by: number): Promise<null> {
    const tool = this.known().find((t) => t.name === name)
    if (!tool) throw new BizError(Err.NOT_FOUND)
    // 写入工具从不自动执行：只能 ask、review 或 deny；自动审查只用于写入工具
    if (tool.kind === 'write' && policy === 'auto') throw new BizError(Err.VALIDATION_FAILED)
    if (tool.kind !== 'write' && policy === 'review') throw new BizError(Err.VALIDATION_FAILED)
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
      'Set a tool policy; null resets to the default (read auto, write ask); write never auto, review only for write',
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
