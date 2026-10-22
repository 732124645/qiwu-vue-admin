import { Inject, Injectable, Optional } from '@nestjs/common'
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  AGENT2_PARAMS,
  agentAutomationPerms,
  type AgentAutomationEventVo,
  type AgentAutomationRunVo,
  type AgentAutomationSave,
  type AgentAutomationToolVo,
  type AgentAutomationVo,
  Err,
} from '@qiwu/shared'
import { I18nService } from 'nestjs-i18n'
import { type DataSource, IsNull, Not } from 'typeorm'
import type { z } from 'zod'
import { ACTION_LOG, type ActionLogOptions } from '../../audit/action-log.js'
import { AuthService } from '../../auth/auth.service.js'
import type { Principal } from '../../auth/principal.js'
import { PermVersion } from '../../auth/perm-version.js'
import { BizError } from '../../http/biz-error.js'
import { ValidationException } from '../../http/validation.pipe.js'
import { currentLocale } from '../../i18n/locale.js'
import { DictService } from '../../settings/dict.service.js'
import { ParamService } from '../../settings/param.service.js'
import {
  type AgentSkillRef,
  PROFILE_SOURCE,
  type ProfileSource,
  SKILL_SOURCE,
  type SkillSource,
} from '../agent-ports.js'
import { AgentAutomation, AgentAutomationRun, type PreApprovedTool } from './automation.entity.js'
import { cronProblem, nextFire, validTimezone } from './automation-cron.js'
import { AgentAutomationRunner, MODE, type RunError } from './automation-runner.js'
import { AgentThreadService } from '../threads/thread.service.js'
import { AutomationPreApproval } from './pre-approval.js'

type Client = Parameters<AuthService['verifyPassword']>[2]

const notFound = () => new BizError(Err.NOT_FOUND)
/** 两个技能绑定是不是同一个（都没有也算）。 */
const sameRef = (x: AgentSkillRef | null, y: AgentSkillRef | null) =>
  x === y || (!!x && !!y && x.id === y.id && x.scope === y.scope)
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null)

/** A 400 on body fields, translated like the request pipe's (`field.agent.automation.*`). */
function invalid(
  path: string,
  message = 'validation.invalid',
  input?: unknown,
): ValidationException {
  const issues = [{ code: 'custom', path: [path], message, input }] as z.core.$ZodIssue[]
  const e = new ValidationException(issues)
  e.domain = 'agent.automation'
  return e
}

export function runVo(r: AgentAutomationRun): AgentAutomationRunVo {
  return {
    id: Number(r.id),
    automationId: Number(r.automationId),
    threadId: r.threadId === null ? null : Number(r.threadId),
    trigger: r.triggerKind,
    status: r.status,
    summary: r.summary,
    error: r.errorCode,
    startedAt: new Date(r.startedAt).toISOString(),
    endedAt: iso(r.endedAt),
  }
}

/**
 * 自动化的增删改查（see docs/agent.md）：本人的自动化与本租户共享的自动化（`agent.automation.use`）。只有
 * 创建人能改、启停、立即运行、看运行历史与删除；别人的不共享的一律 404，共享的可以看、改动 403。建共享的
 * 要 `agent.automation.share`。每人的个数与每条每天的次数受平台参数限制。预先同意的工具清单只能是此刻能
 * 预先同意的写入工具，加入新工具要输入当前密码（与锁屏同一套试错计数）；撤掉工具不用密码。
 */
@Injectable()
export class AgentAutomationService {
  private events?: { domain: string; verb: string }[]

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly runner: AgentAutomationRunner,
    private readonly preApproval: AutomationPreApproval,
    private readonly threads: AgentThreadService,
    private readonly auth: AuthService,
    private readonly permVersion: PermVersion,
    private readonly params: ParamService,
    private readonly dicts: DictService,
    private readonly i18n: I18nService,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    @Optional() @Inject(SKILL_SOURCE) private readonly skills?: SkillSource,
    @Optional() @Inject(PROFILE_SOURCE) private readonly profiles?: ProfileSource,
  ) {}

  private repo() {
    return this.ds.getRepository(AgentAutomation)
  }

  /** 每人最多几条自动化（平台参数，缺失或不合法时 20）。 */
  private perUser(): Promise<number> {
    return this.params.int(AGENT2_PARAMS.automationsPerUser, 1, 1e6, 20)
  }

  /** 列表：本人的与本租户共享的（共享的按创建人显示名字）；预先同意只列此刻仍有效的。 */
  async list(p: Principal): Promise<AgentAutomationVo[]> {
    const rows = await this.repo().find({
      where: [{ userId: p.userId }, { shared: true }],
      order: { id: 'ASC' },
    })
    const names = new Map<number, string>()
    const out: AgentAutomationVo[] = []
    for (const a of rows) {
      const owner = Number(a.userId)
      if (!names.has(owner))
        names.set(owner, (await this.permVersion.load(owner))?.username ?? `#${owner}`)
      out.push(await this.vo(a, p, names.get(owner)!))
    }
    return out
  }

  /** 一行的 VO。 */
  private async vo(
    a: AgentAutomation,
    p: Principal,
    ownerName: string,
  ): Promise<AgentAutomationVo> {
    const valid = await this.preApproval.validTools(a)
    return {
      id: Number(a.id),
      name: a.name,
      enabled: a.enabled,
      shared: a.shared,
      ownerName,
      trigger: a.triggerKind,
      cron: a.cron,
      timezone: a.timezone,
      event: a.event,
      skill: a.skill,
      prompt: a.prompt,
      profileId: a.profileId === null ? null : Number(a.profileId),
      writeMode: a.writeMode,
      preApproved: (a.preApproved ?? []).map((x) => x.tool).filter((t) => valid.has(t)),
      stalePreApproved:
        a.writeMode === 'pre_approved'
          ? (a.preApproved ?? []).map((x) => x.tool).filter((t) => !valid.has(t))
          : [],
      notify: a.notify ?? { inbox: true, mail: false },
      lastRunAt: iso(a.lastRunAt),
      nextRunAt: a.enabled && a.triggerKind === 'schedule' ? iso(a.nextRunAt) : null,
      editable: Number(a.userId) === p.userId,
    }
  }

  /** 本人的自动化；共享的别人的 403（看得到、改不了），其余 404。 */
  private async own(p: Principal, id: number): Promise<AgentAutomation> {
    const a = await this.repo().findOneBy({ id })
    if (!a || (Number(a.userId) !== p.userId && !a.shared)) throw notFound()
    if (Number(a.userId) !== p.userId) throw new BizError(Err.FORBIDDEN)
    return a
  }

  /** 新建：个数上限、共享权限、各字段的校验（含预先同意的密码），然后登记定时。 */
  async create(p: Principal, dto: AgentAutomationSave, client: Client): Promise<AgentAutomationVo> {
    if (dto.shared && !this.mayShare(p)) throw new BizError(Err.FORBIDDEN)
    const count = await this.repo().countBy({ userId: p.userId })
    if (count >= (await this.perUser())) throw this.limit('count')
    const fields = await this.checked(p, dto, [], client)
    const repo = this.repo()
    const a = await repo.save(repo.create({ userId: p.userId, lastRunAt: null, ...fields }))
    await this.runner.reschedule(a)
    return this.vo(a, p, p.username ?? '')
  }

  /** 修改本人的一条（取消共享不需要权限，设为共享需要）。 */
  async update(
    p: Principal,
    id: number,
    dto: AgentAutomationSave,
    client: Client,
  ): Promise<AgentAutomationVo> {
    const a = await this.own(p, id)
    if (dto.shared && !a.shared && !this.mayShare(p)) throw new BizError(Err.FORBIDDEN)
    // 已有的同意只在凭据与这次保存后重算的一致时沿用（作废的、技能或方案换了的，重新勾上也要密码）
    const fields = await this.checked(p, dto, a.preApproved ?? [], client)
    const wasOn = a.enabled
    Object.assign(a, fields)
    await this.repo().save(a)
    await this.runner.reschedule(a)
    if (wasOn && !a.enabled) await this.runner.stopRuns(a, p)
    return this.vo(a, p, p.username ?? '')
  }

  /** 启用 / 停用：同步定时任务；停用时停掉还没结束的运行。 */
  async setEnabled(p: Principal, id: number, enabled: boolean): Promise<AgentAutomationVo> {
    const a = await this.own(p, id)
    a.enabled = enabled
    if (enabled && a.triggerKind === 'schedule' && a.cron && a.timezone)
      a.nextRunAt = nextFire(a.cron, a.timezone)
    await this.repo().save(a)
    await this.runner.reschedule(a)
    if (!enabled) await this.runner.stopRuns(a, p)
    return this.vo(a, p, p.username ?? '')
  }

  /**
   * 删除（软删）并移除定时任务，停掉还没结束的运行，再把各次运行开的隐藏会话（连同轮次、条目、子会话与
   * 生成的图片）一起删掉；运行记录留着（随自动化一起不再列出）。
   */
  async remove(p: Principal, id: number): Promise<null> {
    const a = await this.own(p, id)
    await this.repo().softDelete({ id: a.id })
    await this.runner.reschedule(a, true)
    await this.runner.stopRuns(a, p)
    const runs = await this.ds.getRepository(AgentAutomationRun).find({
      where: { automationId: a.id, threadId: Not(IsNull()) },
      select: { id: true, threadId: true },
    })
    await this.threads.dropHidden(runs.map((r) => Number(r.threadId)))
    return null
  }

  /**
   * 立即运行：急停 503、上一次运行还没结束 409、今天次数已满 429、没有可用的模型 422；创建人就是调用者，
   * 权限已由路由检查。
   */
  async runNow(p: Principal, id: number): Promise<AgentAutomationRunVo> {
    const a = await this.own(p, id)
    const { reason } = await this.runner.check(a)
    if (reason) throw this.refusal(reason)
    const { run, reason: late } = await this.runner.start(a, 'manual')
    if (!run || late) throw this.refusal(late ?? 'owner_inactive')
    return runVo(run)
  }

  /** 运行历史（只给创建人）：先同步还没结束的，再按开始时间倒序分页。 */
  async runs(
    p: Principal,
    id: number,
    q: { page: number; pageSize: number },
  ): Promise<{ items: AgentAutomationRunVo[]; total: number }> {
    const a = await this.repo().findOneBy({ id })
    if (!a || Number(a.userId) !== p.userId) throw notFound()
    await this.runner.syncAutomation(Number(a.id))
    const [rows, total] = await this.ds.getRepository(AgentAutomationRun).findAndCount({
      where: { automationId: a.id },
      order: { startedAt: 'DESC', id: 'DESC' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    })
    return { items: rows.map(runVo), total }
  }

  /** 此刻能预先同意的写入工具（编辑弹窗的勾选清单）。 */
  tools(p: Principal): Promise<AgentAutomationToolVo[]> {
    return this.preApproval.offerable(p)
  }

  /**
   * 可以监听的业务事件：各接口上 `@ActionLog` 声明的领域与动作（智能体与 MCP 自身的除外），只列调用者能
   * 听的资源（见 AgentAutomationRunner.mayHear：有浏览权限，有数据权限却没登记批量目标的还要数据范围全为
   * 全部）；名称是“领域 · 动作”，动作按字典 `audit.verb` 翻译。
   */
  async eventList(p: Principal): Promise<AgentAutomationEventVo[]> {
    const lang = currentLocale()
    const verbs = new Map(
      ((await this.dicts.entries('audit.verb'))?.entries ?? []).map((e) => [
        e.value,
        e.labelI18n?.[lang as 'zh-CN'] ?? e.label,
      ]),
    )
    return this.catalog()
      .filter((e) => this.runner.mayHear(p, e.domain))
      .map((e) => ({ ...e, label: `${e.domain} · ${verbs.get(e.verb) ?? e.verb}` }))
  }

  /** 全部 `@ActionLog` 动作（启动后第一次用时扫描一次，按领域、动作排序、去重）。 */
  private catalog(): { domain: string; verb: string }[] {
    if (this.events) return this.events
    const seen = new Map<string, { domain: string; verb: string }>()
    for (const { instance } of this.discovery.getControllers()) {
      if (!instance || typeof instance !== 'object') continue
      const proto = Object.getPrototypeOf(instance) as object
      for (const m of this.scanner.getAllMethodNames(proto)) {
        const fn = (proto as Record<string, unknown>)[m]
        if (typeof fn !== 'function') continue
        const o = this.reflector.get<ActionLogOptions | undefined>(ACTION_LOG, fn)
        if (!o || o.domain.startsWith('agent.') || o.domain.startsWith('mcp.')) continue
        if (o.domain.length > 40 || o.verb.length > 40) continue
        seen.set(`${o.domain} ${o.verb}`, { domain: o.domain, verb: o.verb })
      }
    }
    this.events = [...seen.values()].sort(
      (x, y) => x.domain.localeCompare(y.domain) || x.verb.localeCompare(y.verb),
    )
    return this.events
  }

  private mayShare(p: Principal): boolean {
    return p.root || p.perms.includes(agentAutomationPerms.share)
  }

  /** 个数或次数上限的 429（原因按调用者的语言）。 */
  private limit(which: 'count' | 'runs'): BizError {
    const reason = String(
      this.i18n.translate(`agent.automation.limit.${which}`, { lang: currentLocale() }),
    )
    return new BizError(Err.AGENT_LIMIT, { reason })
  }

  /** 立即运行没能开始时的错误。 */
  private refusal(reason: RunError): BizError {
    if (reason === 'paused') return new BizError(Err.AGENT_PAUSED)
    if (reason === 'not_configured') return new BizError(Err.AGENT_NOT_CONFIGURED)
    if (reason === 'mode_unavailable') return new BizError(Err.VALIDATION_FAILED)
    if (reason === 'daily_limit') return this.limit('runs')
    if (reason === 'overlap') return new BizError(Err.CONFLICT)
    return new BizError(Err.FORBIDDEN)
  }

  /**
   * 校验一次保存并给出要写的列：定时须有合格的 5 段 cron 与 IANA 时区、最短 5 分钟一次；事件须是调用者能
   * 监听的动作；技能须对本人可用；技能与提示词至少有一个。预先同意只在 `pre_approved` 模式下保存，每个工具
   * 都须此刻能预先同意；每个工具按这次保存的技能与方案重算凭据，`before` 里凭据相同的条目沿用，其余算新同意，
   * 有新同意时须带当前密码并通过校验。配置方案须是本人此刻能用的（否则 400）。预先同意时模型拿到的指令只能
   * 来自创建人本人或平台：技能须是本人的个人技能或平台技能（全租户技能别人能改，400），方案须是本人的个人
   * 方案（400）；技能按 id 与范围记进每个条目，运行时按它取。
   */
  private async checked(
    p: Principal,
    dto: AgentAutomationSave,
    before: PreApprovedTool[],
    client: Client,
  ): Promise<Partial<AgentAutomation>> {
    let cron: string | null = null
    let timezone: string | null = null
    if (dto.trigger === 'schedule') {
      if (!dto.timezone || !validTimezone(dto.timezone))
        throw invalid('timezone', 'validation.invalid', dto.timezone)
      if (!dto.cron) throw invalid('cron', 'validation.required')
      const problem = cronProblem(dto.cron, dto.timezone)
      if (problem === 'too_often') throw invalid('cron', 'validation.agentCronTooOften', dto.cron)
      if (problem) throw invalid('cron', 'validation.invalid', dto.cron)
      cron = dto.cron.trim().split(/\s+/).join(' ')
      timezone = dto.timezone
    }
    let event: AgentAutomation['event'] = null
    if (dto.trigger === 'event') {
      const e = dto.event
      if (!e) throw invalid('event', 'validation.required')
      const known = (await this.eventList(p)).some(
        (x) => x.domain === e.domain && x.verb === e.verb,
      )
      if (!known) throw invalid('event', 'validation.invalid')
      event = { domain: e.domain, verb: e.verb }
    }
    // 配置方案须是创建人此刻能用的（别人的个人方案、别的租户的、已删除的都 400）
    const pre = dto.writeMode === 'pre_approved'
    const profile = dto.profileId === null ? null : await this.profiles?.find(p, dto.profileId)
    if (dto.profileId !== null && !profile)
      throw invalid('profileId', 'validation.invalid', dto.profileId)
    if (pre && profile && profile.scope !== 'user')
      throw invalid('profileId', 'validation.agentPreApprovedSource', dto.profileId)
    const prompt = dto.prompt?.trim() || null
    if (!dto.skill && !prompt) throw invalid('prompt', 'validation.required')
    const skill = dto.skill ? await this.skills?.load(p, dto.skill) : null
    if (dto.skill && !skill) throw invalid('skill', 'validation.invalid', dto.skill)
    if (pre && skill?.scope === 'tenant')
      throw invalid('skill', 'validation.agentPreApprovedSource', dto.skill)
    // 写入模式对应的会话审批模式此刻须可用（与新建会话同一套校验）
    try {
      await this.threads.assertMode(MODE[dto.writeMode])
    } catch (e) {
      if (e instanceof BizError) throw invalid('writeMode', 'validation.invalid', dto.writeMode)
      throw e
    }
    let preApproved: PreApprovedTool[] | null = null
    if (dto.writeMode === 'pre_approved' && dto.preApproved.length) {
      const offer = new Set((await this.preApproval.offerable(p)).map((t) => t.name))
      const wanted = [...new Set(dto.preApproved)]
      if (wanted.some((t) => !offer.has(t))) throw invalid('preApproved', 'validation.invalid')
      const ref = skill && skill.scope !== 'tenant' ? { id: skill.id, scope: skill.scope } : null
      const binding = { skill: ref, profileId: dto.profileId }
      // 每个工具按这次保存的绑定算凭据：原有条目的凭据与之相同（同一技能、同样的正文与方案说明、事实没变）才
      // 沿用，其余都是新的同意
      const now = new Date().toISOString()
      preApproved = []
      let fresh = false
      for (const tool of wanted) {
        const cred = await this.preApproval.credential(p.userId, tool, binding)
        if (!cred) throw new BizError(Err.FORBIDDEN)
        const kept = before.find(
          (x) =>
            x.tool === tool &&
            x.facts === cred.facts &&
            x.switch === cred.switch &&
            sameRef(x.skill ?? null, ref),
        )
        if (!kept) fresh = true
        preApproved.push(kept ?? { tool, at: now, ...cred, skill: ref })
      }
      if (fresh) {
        if (!dto.currentPassword) throw invalid('currentPassword', 'validation.required')
        await this.auth.verifyPassword(p, dto.currentPassword, client)
      }
    }
    return {
      name: dto.name,
      enabled: dto.enabled,
      shared: dto.shared,
      triggerKind: dto.trigger,
      cron,
      timezone,
      event,
      skill: dto.skill,
      prompt,
      profileId: dto.profileId,
      writeMode: dto.writeMode,
      preApproved,
      notify: dto.notify,
      nextRunAt: dto.enabled && cron && timezone ? nextFire(cron, timezone) : null,
    }
  }
}
