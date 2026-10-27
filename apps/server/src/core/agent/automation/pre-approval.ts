import { createHash } from 'node:crypto'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { agentAutomationPerms, agentPerms, type AgentAutomationToolVo } from '@qiwu/shared'
import { I18nService } from 'nestjs-i18n'
import type { DataSource } from 'typeorm'
import { PermVersion } from '../../auth/perm-version.js'
import type { Principal } from '../../auth/principal.js'
import { tenantId } from '../../context/tenant.js'
import { McpRegistry } from '../../mcp/mcp-registry.js'
import { ToolHost } from '../../mcp/tool-host.js'
import {
  type AgentReviewCall,
  type AgentReviewVerdict,
  type AgentRunContext,
  type AgentSkillRef,
  AgentApprovalReviewer,
  PROFILE_SOURCE,
  type ProfileSource,
  SKILL_SOURCE,
  type SkillSource,
} from '../agent-ports.js'
import { McpToolSwitch } from '../../mcp/mcp.entity.js'
import { AgentTurn } from '../entities/agent-thread.entity.js'
import { AgentToolPolicies, effectivePolicy } from '../tools/tool-policy.js'
import { AgentAutomation, AgentAutomationRun, type PreApprovedTool } from './automation.entity.js'

/**
 * 按用户 id 重新加载身份（与运行时一样）：用户被停用、删除或不在当前租户时为 null。自动化在没有请求的
 * 时候运行，身份每次都现取，不用保存时的快照。
 */
export async function loadPrincipal(pv: PermVersion, userId: number): Promise<Principal | null> {
  const u = await pv.load(userId)
  if (!u || u.userId === null || u.tenantId !== tenantId()) return null
  return {
    userId: u.userId,
    username: u.username,
    deptName: u.deptName,
    userType: u.userType,
    clientId: 'agent',
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
 * 创建人此刻还能不能让这条自动化运行：须有对话与自动化权限，共享的还须有共享权限。失去任何一个，
 * 自动化就停止运行（跳过并记原因），预先同意也随之失效。
 */
export function ownerMayRun(p: Principal, a: Pick<AgentAutomation, 'shared'>): boolean {
  if (p.root) return true
  const need: string[] = [agentPerms.chat.use, agentAutomationPerms.use]
  if (a.shared) need.push(agentAutomationPerms.share)
  return need.every((perm) => p.perms.includes(perm))
}

/**
 * 自动化运行时交给模型的指令来源此刻的内容（预先同意的一部分）：绑定的技能（id、范围与正文）、配置方案
 * （id 与额外说明）。取不到的（删除、停用、改成别人能改的范围）为 null。
 */
export interface BoundFacts {
  skill: { id: number; scope: string; body: string } | null
  profile: { id: number; instructions: string | null } | null
}

/** 一条自动化在预先同意下绑定的技能（按 id 与范围）与配置方案 id。 */
export interface Binding {
  skill: AgentSkillRef | null
  profileId: number | null
}

/**
 * 一个工具此刻生效事实的摘要（预先同意的凭据）：创建人是否 root、是否持有工具所需的权限点、给出这个权限点
 * 的角色（编码、数据范围与自选部门）、本人的部门与部门路径、工具所需的套餐功能是否开通，以及运行时交给
 * 模型的指令来源（{@link BoundFacts}：技能正文、方案说明）——内容一变，同意就作废。只收与这个工具有关的
 * 事实：别的租户续期、改无关的菜单、改界面语言都不影响它。
 */
export function factsOf(
  p: Principal,
  perm: string | null,
  feature: string | undefined,
  bound: BoundFacts | null = null,
): string {
  const granting = perm
    ? p.roles
        .filter((r) => r.perms.includes(perm) || r.perms.includes('*'))
        .map((r) => ({
          code: r.code,
          scope: r.dataScope,
          depts: [...(r.deptIds ?? [])].sort((a, b) => a - b),
        }))
        .sort((a, b) => a.code.localeCompare(b.code))
    : []
  const facts = {
    root: p.root === true,
    perm,
    holds: perm === null || p.root === true || p.perms.includes(perm),
    roles: granting,
    deptId: p.deptId,
    deptTreePath: p.deptTreePath,
    feature: feature ?? null,
    hasFeature: feature === undefined ? null : (p.features?.includes(feature) ?? true),
    // 没有技能也没有方案时不写这一项（摘要与不带指令来源时算的相同）
    ...(bound && (bound.skill || bound.profile) && { bound }),
  }
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex')
}

/** 工具平台开关行此刻的值：`<enabled>:<策略>`；没有行为 `none`（之后出现任何行都算变了）。 */
const switchOf = (row: Pick<McpToolSwitch, 'enabled' | 'agentPolicy'> | null): string =>
  row ? `${row.enabled ? 1 : 0}:${row.agentPolicy ?? 'default'}` : 'none'

/**
 * 自动化的预先同意（see docs/agent.md）：创建人建或改自动化时逐个勾选、输入当前密码同意的写入工具，
 * 在它的运行里不再停下等人。每个条目同意时记下凭据：与这个工具有关的生效事实的摘要（{@link factsOf}）
 * 与工具平台开关行的值（{@link switchOf}）。此刻重算的与记下的不一致——创建人在这个工具上的权限、数据范围、
 * 部门或套餐变了，管理员动过这个工具的开关或策略——这项同意就作废，要重新输入密码同意；只有事实恢复到与同意时
 * 完全相同（摘要相同）才算仍然有效。开关行一旦出现就不会再回到“没有行”，所以动过开关的同意不会恢复。
 *
 * 也是一个审批审查者：一个写入要停下等人之前，只在下列条件此刻都成立时放行（`by: 'pre_approved'`）：会话是
 * 自动化开的、运行还没结束、调用属于这次运行开的那一轮、自动化的写入模式为 `pre_approved`、运行身份就是
 * 它的创建人、工具是本系统工具且在同意清单里，并且此刻仍然有效（{@link validTools}）。工具在清单里却已
 * 失效时交给人（escalate），卡片写明需要重新同意；其余不适用的情况返回 null。只看工具名，不看工具输出。
 * 运行时的 `entitled` 再用 {@link approves} 复核一次：别的审查者冒称 `pre_approved` 的放行不会生效。读列表
 * 与审查都只计算，不回写库。
 */
@Injectable()
@AgentApprovalReviewer({ order: 10 })
export class AutomationPreApproval implements AgentApprovalReviewer {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly host: ToolHost,
    private readonly registry: McpRegistry,
    private readonly policies: AgentToolPolicies,
    private readonly permVersion: PermVersion,
    private readonly i18n: I18nService,
    @Optional() @Inject(SKILL_SOURCE) private readonly skills?: SkillSource,
    @Optional() @Inject(PROFILE_SOURCE) private readonly profiles?: ProfileSource,
  ) {}

  /** 审查一次写入调用：满足全部条件才放行；清单里的工具已失效时交给人并说明；其余不管（null）。 */
  async review(ctx: AgentRunContext, call: AgentReviewCall): Promise<AgentReviewVerdict | null> {
    if (call.origin !== 'local') return null
    const found = await this.lookup(ctx, call.tool)
    if (!found) return null
    const reason = (key: string) => String(this.i18n.translate(key, { lang: ctx.lang }))
    if (found.valid)
      return {
        verdict: 'approve',
        by: 'pre_approved',
        reason: reason('agent.automation.preApprovedReason'),
      }
    return {
      verdict: 'escalate',
      by: 'pre_approved',
      reason: reason('agent.automation.preApprovalStale'),
    }
  }

  /** 这次调用能不能凭预先同意放行（见 {@link lookup}）。 */
  async approves(
    ctx: Pick<AgentRunContext, 'thread' | 'turnId' | 'principal'>,
    tool: string,
  ): Promise<boolean> {
    return (await this.lookup(ctx, tool))?.valid === true
  }

  /**
   * 找到这次调用对应的预先同意：自动化的会话、运行还在进行（running / waiting）、这次运行开的第一轮、
   * `pre_approved` 模式、运行身份是创建人、工具在清单里；不是这种情况为 null，是的话再给出它此刻是否有效。
   */
  private async lookup(
    ctx: Pick<AgentRunContext, 'thread' | 'turnId' | 'principal'>,
    tool: string,
  ): Promise<{ valid: boolean } | null> {
    const runId = ctx.thread.automationRunId
    if (runId === null) return null
    const run = await this.ds.getRepository(AgentAutomationRun).findOneBy({ id: runId })
    if (!run || run.threadId === null || Number(run.threadId) !== ctx.thread.id) return null
    if (run.status !== 'running' && run.status !== 'waiting') return null
    // 只认这次运行开的那一轮（隐藏会话不能再发消息，这里再守一道）
    const first = await this.ds.getRepository(AgentTurn).findOne({
      where: { threadId: ctx.thread.id },
      order: { id: 'ASC' },
      select: { id: true },
    })
    if (!first || Number(first.id) !== ctx.turnId) return null
    const a = await this.ds.getRepository(AgentAutomation).findOneBy({ id: run.automationId })
    if (!a || a.writeMode !== 'pre_approved' || Number(a.userId) !== ctx.principal.userId)
      return null
    if (!(a.preApproved ?? []).some((x) => x.tool === tool)) return null
    return { valid: (await this.validTools(a)).has(tool) }
  }

  /**
   * 自动化会话的一轮开始（与每次续跑）时：这次运行的自动化还在、运行身份是它的创建人、创建人此刻仍能运行它。
   */
  async runAllowed(p: Principal, runId: number): Promise<boolean> {
    const run = await this.ds.getRepository(AgentAutomationRun).findOneBy({ id: runId })
    if (!run) return false
    const a = await this.ds.getRepository(AgentAutomation).findOneBy({ id: run.automationId })
    return !!a && Number(a.userId) === p.userId && ownerMayRun(p, a)
  }

  /**
   * 此刻可以预先同意的写入工具（创建人能触达、平台没停用、策略为 `ask` 的本系统写入工具），按名字排序。
   * 外部 MCP 工具、内置工具与只能由人确认的（`human`）不在其中：它们的写入照常停下等人。
   */
  async offerable(p: Principal): Promise<AgentAutomationToolVo[]> {
    const policies = await this.policies.policies()
    return (await this.host.list(p))
      .filter(
        (t) =>
          t.kind === 'write' &&
          !t.perCallConfirmation &&
          (policies.get(t.name) ?? effectivePolicy('write', null)) === 'ask',
      )
      .map((t) => ({ name: t.name, title: t.title }))
      .sort((x, y) => x.name.localeCompare(y.name))
  }

  /** 一个工具此刻的同意凭据（以创建人此刻的身份、按绑定的技能与方案算）；创建人已不可用时为 null。 */
  async credential(
    userId: number,
    tool: string,
    binding: Binding,
  ): Promise<Pick<PreApprovedTool, 'facts' | 'switch'> | null> {
    const owner = await loadPrincipal(this.permVersion, userId)
    return owner ? this.credentialOf(owner, tool, await this.bound(owner, binding)) : null
  }

  /**
   * 绑定的技能与方案此刻的内容：技能按记下的 id 与范围取（不按名字，别人建的同名技能遮不住它）；方案须仍是
   * 创建人本人的个人方案（改成全租户共用后别人能改它的说明，就当作没有）。
   */
  async bound(owner: Principal, b: Binding): Promise<BoundFacts> {
    const skill = b.skill ? await this.skills?.loadRef(owner, b.skill) : null
    const profile = b.profileId === null ? null : await this.profiles?.find(owner, b.profileId)
    return {
      skill: skill ? { id: skill.id, scope: skill.scope, body: skill.body } : null,
      profile:
        profile?.scope === 'user' ? { id: profile.id, instructions: profile.instructions } : null,
    }
  }

  private async credentialOf(
    owner: Principal,
    tool: string,
    bound: BoundFacts,
  ): Promise<Pick<PreApprovedTool, 'facts' | 'switch'>> {
    const t = this.registry.get(tool)
    const row = await this.ds.getRepository(McpToolSwitch).findOne({
      where: { name: tool },
      select: { id: true, enabled: true, agentPolicy: true },
    })
    return { facts: factsOf(owner, t?.perm ?? null, t?.feature, bound), switch: switchOf(row) }
  }

  /**
   * 一条自动化的预先同意里此刻仍然有效的工具：创建人此刻仍能运行这条自动化（没被停用，仍有对话、自动化
   * 与共享权限）、工具仍可预先同意，且条目记下的凭据与此刻重算的一致（按条目记下的技能绑定与自动化的方案
   * 算；自动化有技能、条目却没记下绑定的不算）。只计算，不改库。
   */
  async validTools(a: AgentAutomation): Promise<Set<string>> {
    const listed = a.writeMode === 'pre_approved' ? (a.preApproved ?? []) : []
    if (!listed.length) return new Set()
    const owner = await loadPrincipal(this.permVersion, Number(a.userId))
    if (!owner || !ownerMayRun(owner, a)) return new Set()
    const names = new Set((await this.offerable(owner)).map((t) => t.name))
    const bounds = new Map<string, BoundFacts>()
    const out = new Set<string>()
    for (const x of listed) {
      if (!names.has(x.tool) || (a.skill && !x.skill)) continue
      const binding: Binding = {
        skill: x.skill ?? null,
        profileId: a.profileId === null ? null : Number(a.profileId),
      }
      const key = JSON.stringify(binding)
      if (!bounds.has(key)) bounds.set(key, await this.bound(owner, binding))
      const now = await this.credentialOf(owner, x.tool, bounds.get(key)!)
      if (x.facts === now.facts && x.switch === now.switch) out.add(x.tool)
    }
    return out
  }
}
