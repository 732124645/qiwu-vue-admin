import { Body, Controller, Get, Injectable, Param, Put } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  agentPerms,
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
import { WEB_TOOLS } from '../web/web-tools.js'
import { AgentRootOnly } from './root-only.js'

type Kind = (typeof MCP_TOOL_KINDS)[number]

/** 类型默认的审批策略：只读直接执行，写入停下等人确认。 */
export const defaultPolicy = (kind: Kind): AgentToolPolicy => (kind === 'write' ? 'ask' : 'auto')

/**
 * 实际生效的策略：显式设置优先，否则按类型默认；写入工具即使库里被写成 auto 也按 ask（写入从不自动执行）。
 */
export const effectivePolicy = (kind: Kind, stored: AgentToolPolicy | null): AgentToolPolicy => {
  const p = stored ?? defaultPolicy(kind)
  return kind === 'write' && p === 'auto' ? 'ask' : p
}

/**
 * 本系统工具（`@McpTool` 注册的本地工具与内置的 web.search / web.fetch）在智能体里的审批策略
 * （see docs/agent.md）：存在 `cfg_mcp_tool.agent_policy`（平台表，按工具名一行；null 为按类型默认）。
 * 运行时用 {@link policies} 取全部工具此刻生效的策略。
 */
@Injectable()
export class AgentToolPolicies {
  constructor(
    private readonly registry: McpRegistry,
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
  ) {}

  /** 全部本系统工具：名称、标题、类型、来源与权限点。 */
  private known(): {
    name: string
    title: string
    kind: Kind
    source: 'local' | 'web'
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
    ]
  }

  /** 库里的显式策略，按工具名。 */
  private async stored(): Promise<Map<string, AgentToolPolicy>> {
    const rows = await this.txHost.tx.getRepository(McpToolSwitch).find()
    return new Map(rows.filter((r) => r.agentPolicy !== null).map((r) => [r.name, r.agentPolicy!]))
  }

  /** 平台页的工具列表：每个工具此刻生效的策略，以及是否是类型默认。 */
  async list(): Promise<AgentToolVo[]> {
    const stored = await this.stored()
    return this.known()
      .map((t) => ({
        ...t,
        policy: effectivePolicy(t.kind, stored.get(t.name) ?? null),
        defaulted: !stored.has(t.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 运行时用：全部本系统工具此刻生效的策略，按工具名。 */
  async policies(): Promise<Map<string, AgentToolPolicy>> {
    const stored = await this.stored()
    return new Map(
      this.known().map((t) => [t.name, effectivePolicy(t.kind, stored.get(t.name) ?? null)]),
    )
  }

  /** 设一个工具的策略（null 回到类型默认）；未知工具 404，写入工具设 auto 回 400。 */
  async set(name: string, policy: AgentToolPolicy | null, by: number): Promise<null> {
    const tool = this.known().find((t) => t.name === name)
    if (!tool) throw new BizError(Err.NOT_FOUND)
    // 写入工具从不自动执行：只能 ask 或 deny
    if (tool.kind === 'write' && policy === 'auto') throw new BizError(Err.VALIDATION_FAILED)
    // 平台表：一个工具名一行（唯一键 name + alive），没有行时新建（启用状态保持默认的启用）
    await this.txHost.tx.query(
      `INSERT INTO cfg_mcp_tool (name, enabled, agent_policy, created_by, updated_by) VALUES (?, 1, ?, ?, ?) AS n
        ON DUPLICATE KEY UPDATE agent_policy = n.agent_policy, updated_by = n.updated_by`,
      [name, policy, by, by],
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
      'Set a tool policy; null resets to the default (read auto, write ask); write never auto',
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
}
