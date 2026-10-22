import { ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  AGENT_APPROVAL_MODES,
  AGENT_PAUSED_PARAM,
  AGENT_TRUST_MODE_PARAM,
  AGENT2_PARAMS,
  AGENT_WEB_MODE_PARAM,
  type AgentOptionsVo,
  type AgentPromptSave,
  type AgentPromptVo,
  type AgentUsageQuery,
  type AgentUsageRowVo,
  agentPerms,
  Err,
} from '@qiwu/shared'
import { I18nService } from 'nestjs-i18n'
import { In, Not } from 'typeorm'
import {
  EXTERNAL_TOOL_SOURCE,
  type ExternalToolSource,
  SKILL_SOURCE,
  type SkillSource,
} from '../agent-ports.js'
import type { Principal } from '../../auth/principal.js'
import { tenantId } from '../../context/tenant.js'
import { BizError } from '../../http/biz-error.js'
import { currentLocale } from '../../i18n/locale.js'
import { ParamService } from '../../settings/param.service.js'
import { AgentInstruction, AgentPrompt } from '../entities/agent-skill.entity.js'
import { AgentUsage } from '../entities/agent-usage.entity.js'
import { ProviderSearchConfig } from '../provider/provider-registry.js'
import { parseReviewModel } from '../runtime/auto-reviewer.js'
import { num, trustModeOn } from './thread-vo.js'
import { AgentThreadService } from './thread.service.js'

/** 空状态里的开场建议条数（`agent.thread.starter.s1` …）。 */
const STARTERS = 4
/** 来源页面专属的开场建议最多几条（`agent.thread.starterFor.<路由名>.s1` …）。 */
const PAGE_STARTERS = 3

/** 用量页的分组列（固定表达式，不来自请求）。 */
const USAGE_KEY = {
  day: "DATE_FORMAT(u.day, '%Y-%m-%d')",
  user: 'u.userId',
  model: 'u.model',
} as const

/**
 * 对话页的选项、提示词模板与用量（see docs/agent.md）。提示词模板分个人（本人可改）与全租户共用
 * （改动需 `agent.skill.modify`）；用量只看当前租户。
 */
@Injectable()
export class AgentOptionsService {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly threads: AgentThreadService,
    private readonly search: ProviderSearchConfig,
    private readonly params: ParamService,
    private readonly i18n: I18nService,
    @Optional() @Inject(SKILL_SOURCE) private readonly skills?: SkillSource,
    @Optional()
    @Inject(EXTERNAL_TOOL_SOURCE)
    private readonly external?: ExternalToolSource,
  ) {}

  private get prompts() {
    return this.txHost.tx.getRepository(AgentPrompt)
  }

  /** 布尔参数：值为 `false` 才算关闭，缺失按 `fallback`。 */
  private async on(key: string, fallback: boolean): Promise<boolean> {
    const v = (await this.params.get(key))?.trim().toLowerCase()
    return v ? v === 'true' : fallback
  }

  /**
   * 开场建议：来源页面（路由名）有专属建议（`agent.thread.starterFor.<路由名>.s1` … `s3`，有几条算几条）
   * 时排在前面，后面是平台默认的几条。路由名只认字母、数字、`-` 与 `_`，其他的当作没给。
   */
  private starters(lang: string, route: string | undefined): string[] {
    const page: string[] = []
    if (route && /^[\w-]{1,100}$/.test(route))
      for (let i = 1; i <= PAGE_STARTERS; i++) {
        const key = `agent.thread.starterFor.${route}.s${i}`
        const text = String(this.i18n.translate(key, { lang }))
        // 缺这个键时 nestjs-i18n 原样返回键名
        if (text && text !== key) page.push(text)
      }
    const defaults = Array.from({ length: STARTERS }, (_, i) =>
      String(this.i18n.translate(`agent.thread.starter.s${i + 1}`, { lang })),
    )
    return [...page, ...defaults]
  }

  /**
   * 输入框需要的一切：启用的模型（含推理、视觉、快速标记）与默认值、可用技能（技能来源未装配时为空）、
   * 审批模式（平台关闭“信任本会话”时去掉，`trustSession` 同一个判断）、能否联网搜索（有可用的搜索服务商
   * 且 `agent.web.mode` 为 live）、是否急停、按来源页面选的开场建议、本人与本租户的提示词模板、智能体
   * 此刻能用的外部 MCP 服务器（只给名字）、本人的语气。
   */
  async options(p: Principal, route?: string): Promise<AgentOptionsVo> {
    const providers = await this.threads.enabledProviders()
    const first = providers[0]
    const webMode = (await this.params.get(AGENT_WEB_MODE_PARAM))?.trim() || 'live'
    const reviewOn = !!parseReviewModel(await this.params.get(AGENT2_PARAMS.reviewModel))
    const trust = trustModeOn(await this.params.get(AGENT_TRUST_MODE_PARAM))
    const lang = currentLocale()
    // 外部工具来源只列启用服务器上启用、策略不是 deny 的工具：按服务器名去重
    const servers = this.external
      ? [...new Set((await this.external.list(p)).map((t) => t.serverName))].map((name) => ({
          name,
        }))
      : []
    const tone = await this.txHost.tx
      .getRepository(AgentInstruction)
      .findOneBy({ ownerUserId: p.userId })
    return {
      providers: providers.map(({ id, name, models }) => ({ id, name, models })),
      defaults: first ? { providerId: first.id, model: first.models[0]!.id } : null,
      skills: this.skills ? await this.skills.listFor(p) : [],
      // 自动审查要先由平台指定审查用的模型才提供
      approvalModes: AGENT_APPROVAL_MODES.filter(
        (m) => (trust || m !== 'trust') && (m !== 'auto_review' || reviewOn),
      ),
      webSearch: webMode === 'live' && (await this.search.current()) !== null,
      paused: await this.on(AGENT_PAUSED_PARAM, false),
      starters: this.starters(lang, route),
      prompts: (await this.promptRows(p)).map((r) => ({
        id: num(r.id),
        name: r.name,
        body: r.body,
      })),
      trustSession: trust,
      servers,
      tone: tone?.tone ?? 'default',
    }
  }

  /** 能否改全租户共用的模板。 */
  private tenantWide(p: Principal): boolean {
    return p.root === true || p.perms.includes(agentPerms.skill.modify)
  }

  /** 本人的与全租户共用的模板（共用的在前，再按名称）。 */
  private promptRows(p: Principal) {
    return this.prompts.find({
      where: { ownerUserId: In([p.userId, 0]) },
      order: { ownerUserId: 'ASC', name: 'ASC' },
    })
  }

  private promptVo(p: Principal, r: AgentPrompt): AgentPromptVo {
    const tenant = num(r.ownerUserId) === 0
    return {
      id: num(r.id),
      scope: tenant ? 'tenant' : 'user',
      name: r.name,
      body: r.body,
      editable: !tenant || this.tenantWide(p),
    }
  }

  async listPrompts(p: Principal): Promise<AgentPromptVo[]> {
    return (await this.promptRows(p)).map((r) => this.promptVo(p, r))
  }

  /** 同一范围（本人或全租户）内模板名唯一：重名 409。 */
  private async assertName(owner: number, name: string, excludeId?: number): Promise<void> {
    const taken = await this.prompts.exists({
      where: {
        ownerUserId: owner,
        name,
        ...(excludeId !== undefined && { id: Not(excludeId) }),
      },
    })
    if (taken) throw new BizError(Err.DUPLICATE, { name })
  }

  /** 新建模板：全租户共用的需要 `agent.skill.modify`（否则 403）。 */
  async createPrompt(p: Principal, dto: AgentPromptSave): Promise<AgentPromptVo> {
    if (dto.scope === 'tenant' && !this.tenantWide(p)) throw new ForbiddenException()
    const owner = dto.scope === 'tenant' ? 0 : p.userId
    return this.txHost.withTransaction(async () => {
      await this.assertName(owner, dto.name)
      const row = await this.prompts.save(
        this.prompts.create({ ownerUserId: owner, name: dto.name, body: dto.body }),
      )
      return this.promptVo(p, row)
    })
  }

  /**
   * 本人可见的一个模板，锁行；别人的个人模板 404。改动全租户共用的（或改成共用的）需要
   * `agent.skill.modify`（403）。
   */
  private async editable(p: Principal, id: number, toTenant = false): Promise<AgentPrompt> {
    const row = await this.prompts.findOne({
      where: { id, ownerUserId: In([p.userId, 0]) },
      lock: { mode: 'pessimistic_write' },
    })
    if (!row) throw new NotFoundException()
    if ((num(row.ownerUserId) === 0 || toTenant) && !this.tenantWide(p))
      throw new ForbiddenException()
    return row
  }

  /** 修改模板（可在个人与全租户之间改范围，规则同新建）。 */
  async updatePrompt(p: Principal, id: number, dto: AgentPromptSave): Promise<AgentPromptVo> {
    return this.txHost.withTransaction(async () => {
      await this.editable(p, id, dto.scope === 'tenant')
      const owner = dto.scope === 'tenant' ? 0 : p.userId
      await this.assertName(owner, dto.name, id)
      await this.prompts.update(id, { ownerUserId: owner, name: dto.name, body: dto.body })
      return this.promptVo(p, await this.prompts.findOneByOrFail({ id }))
    })
  }

  async removePrompt(p: Principal, id: number): Promise<null> {
    await this.txHost.withTransaction(async () => {
      await this.editable(p, id)
      await this.prompts.softDelete({ id })
    })
    return null
  }

  /**
   * 用量（`agent.usage.browse`）：当前租户在 [from, to]（UTC 日）内按日、用户或模型汇总的调用次数与
   * token。按用户分组时标签为用户名（已删除的用户也显示）。只看当前租户：跨租户汇总不在接口约定内。
   */
  async usage(q: AgentUsageQuery): Promise<AgentUsageRowVo[]> {
    const key = USAGE_KEY[q.groupBy]
    const qb = this.txHost.tx
      .getRepository(AgentUsage)
      .createQueryBuilder('u')
      .select(key, 'groupKey')
      .addSelect('SUM(u.calls)', 'calls')
      .addSelect('SUM(u.promptTokens)', 'promptTokens')
      .addSelect('SUM(u.completionTokens)', 'completionTokens')
      .where('u.day BETWEEN :from AND :to', { from: q.from, to: q.to })
      .groupBy(key)
    // 按日从早到晚，其余按总 token 从多到少
    if (q.groupBy === 'day') qb.orderBy('groupKey', 'ASC')
    else qb.orderBy('SUM(u.promptTokens + u.completionTokens)', 'DESC')
    const rows = await qb.getRawMany<{
      groupKey: string
      calls: string
      promptTokens: string
      completionTokens: string
    }>()
    const names = new Map<string, string>()
    if (q.groupBy === 'user' && rows.length) {
      const users = await this.txHost.tx.query<
        { id: string; username: string; display_name: string | null }[]
      >(
        // 只取用量行所属用户的显示名（用量按租户汇总，不按部门数据权限裁剪；已删除的用户也显示）
        // qw:include-deleted; qw:no-data-scope usage labels only
        'SELECT u.id, u.username, u.display_name FROM iam_user u WHERE u.tenant_id = ? AND u.id IN (?)',
        [tenantId(), rows.map((r) => num(r.groupKey))],
      )
      for (const u of users) names.set(String(num(u.id)), u.display_name || u.username)
    }
    return rows.map((r) => {
      const k = String(r.groupKey)
      return {
        key: k,
        label: names.get(k) ?? k,
        calls: num(r.calls),
        promptTokens: num(r.promptTokens),
        completionTokens: num(r.completionTokens),
      }
    })
  }
}
