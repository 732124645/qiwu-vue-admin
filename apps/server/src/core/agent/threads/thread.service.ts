import { randomBytes } from 'node:crypto'
import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  AGENT_LIMIT_PARAMS,
  AGENT_TRUST_MODE_PARAM,
  type AgentFeedbackSave,
  type AgentModelVo,
  type AgentProviderVo,
  type AgentStatusVo,
  type AgentThreadCreate,
  type AgentThreadDetailVo,
  type AgentThreadQuery,
  type AgentThreadUpdate,
  type AgentThreadVo,
  Err,
  type Page,
} from '@qiwu/shared'
import { I18nService } from 'nestjs-i18n'
import { In, LessThanOrEqual, MoreThan, type ObjectLiteral, type Repository } from 'typeorm'
import type { Principal } from '../../auth/principal.js'
import { clsGet } from '../../context/cls.js'
import { contains, paginate } from '../../db/page.js'
import { BizError } from '../../http/biz-error.js'
import { currentLocale } from '../../i18n/locale.js'
import { ParamService } from '../../settings/param.service.js'
import {
  AgentFeedback,
  AgentItem,
  AgentThread,
  AgentTurn,
} from '../entities/agent-thread.entity.js'
import { AgentUsage } from '../entities/agent-usage.entity.js'
import { ProviderSettingsService } from '../provider/provider-settings.service.js'
import { parseTrust } from '../runtime/turn-tools.js'
import {
  fulltextTerms,
  itemVo,
  num,
  sharedItems,
  sharedTurn,
  threadMarkdown,
  threadVo,
  trustModeOn,
  turnVo,
} from './thread-vo.js'

/** 估算上下文 token：每 token 约 3.5 个字符（中英文混合的粗略值，只用于输入框旁的用量环）。 */
const CHARS_PER_TOKEN = 3.5
/** 日限额参数缺失或无效时的默认值（与系统参数种子一致）。 */
const USER_DAILY_DEFAULT = 1_000_000
const TENANT_DAILY_DEFAULT = 10_000_000
/** 复制进分叉会话时仍“待处理 / 运行中”的条目：分叉里没有对应的轮次，标为已失效，不再可操作。 */
const OPEN_STATUSES = new Set(['pending', 'running'])

/**
 * 分叉时复制的条目：用户消息只要真正跑过的（排队没跑的是 pending，分叉过来的副本是 expired；跑过的
 * 状态为空），回答与推理只要完成（done 或没有状态）且有文字的（运行中、失败、作废的不要），其余（工具、
 * 审批、计划、压缩、错误）照抄，仍待处理的再标为已失效。
 */
export const forkable = (i: Pick<AgentItem, 'kind' | 'status' | 'payload'>): boolean => {
  if (i.kind === 'user') return i.status === null
  if (i.kind === 'assistant' || i.kind === 'reasoning')
    return (
      (i.status === 'done' || i.status === null) &&
      !!String((i.payload as { text?: unknown } | null)?.text ?? '').trim()
    )
  return true
}

/** 会话选定的提供方与模型（已对照启用的提供方校验）。 */
interface ModelChoice {
  providerId: number
  model: AgentModelVo
}

/**
 * 智能助手的会话管理（see docs/agent.md）：列表、建、改、删、分叉、已读、撤回、导出、状态、分享与反馈。
 * 每个会话只属于发起人：别人的（含别的租户的）一律 404，不泄露是否存在。轮次的执行与条目的追加在运行时
 * （runtime），这里只读它们，分叉与撤回例外：在一个事务里直接写条目行。
 */
@Injectable()
export class AgentThreadService {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly providers: ProviderSettingsService,
    private readonly params: ParamService,
    private readonly i18n: I18nService,
  ) {}

  private repo<E extends ObjectLiteral>(e: new () => E): Repository<E> {
    return this.txHost.tx.getRepository(e)
  }

  /** 按调用者语言翻译服务端文字（标题、导出标签）。 */
  private t(key: string, args?: Record<string, unknown>): string {
    return String(this.i18n.translate(`agent.thread.${key}`, { lang: currentLocale(), args }))
  }

  /**
   * 调用者自己的一个会话；`lock` 时在当前事务里加行锁（分叉、撤回、删除等写操作串行化）。
   * 不存在、已删除、属于别人或别的租户（ORM 自动加租户条件）一律 404。
   */
  async own(p: Principal, id: number, opts: { lock?: boolean; token?: boolean } = {}) {
    const qb = this.repo(AgentThread)
      .createQueryBuilder('t')
      .where('t.id = :id AND t.userId = :uid', { id, uid: p.userId })
    if (opts.token) qb.addSelect('t.shareToken')
    if (opts.lock) qb.setLock('pessimistic_write')
    const row = await qb.getOne()
    if (!row) throw new NotFoundException()
    return row
  }

  /** 启用的提供方及其模型（默认在前，再按排序），选项接口与模型校验共用。 */
  async enabledProviders(): Promise<AgentProviderVo[]> {
    return (await this.providers.list()).filter((r) => r.enabled && r.models.length)
  }

  /**
   * 把请求里的提供方 / 模型对照启用的提供方校验：提供方不给取默认，模型不给取该提供方的第一个；
   * 找不到、已停用或模型不在列表里 → 422 未配置。都没给且平台还没配置任何模型时为 null（会话照建，
   * 发消息时运行时再报未配置）。
   */
  private async choose(providerId?: number, model?: string): Promise<ModelChoice | null> {
    const list = await this.enabledProviders()
    if (providerId === undefined && model === undefined && !list.length) return null
    const prov = providerId === undefined ? list[0] : list.find((x) => x.id === providerId)
    const m =
      prov && (model === undefined ? prov.models[0] : prov.models.find((x) => x.id === model))
    if (!prov || !m) throw new BizError(Err.AGENT_NOT_CONFIGURED)
    return { providerId: prov.id, model: m }
  }

  /** 推理强度只对支持它的模型有效：给了却不支持 → 400。 */
  private reasoningFor(
    choice: ModelChoice | null,
    reasoning: AgentThread['reasoning'] | undefined,
  ) {
    if (!reasoning) return null
    if (!choice?.model.reasoning) throw new BizError(Err.VALIDATION_FAILED)
    return reasoning
  }

  /** “信任本会话”模式被平台参数关闭时不能选（400）。 */
  private async assertMode(mode: AgentThread['approvalMode'] | undefined): Promise<void> {
    if (mode !== 'trust') return
    if (!trustModeOn(await this.params.get(AGENT_TRUST_MODE_PARAM)))
      throw new BizError(Err.VALIDATION_FAILED)
  }

  /** 一批会话的未读数（序号大于已读位置、不是本人发的条目）与最新一轮的状态。 */
  private async extras(rows: AgentThread[]): Promise<AgentThreadVo[]> {
    const ids = rows.map((r) => num(r.id))
    if (!ids.length) return []
    const unread = await this.repo(AgentItem)
      .createQueryBuilder('i')
      .innerJoin(AgentThread, 't', 't.id = i.threadId')
      .select('i.threadId', 'threadId')
      .addSelect('COUNT(*)', 'n')
      .where('i.threadId IN (:...ids)', { ids })
      .andWhere('i.seq > t.readSeq')
      .andWhere("i.kind <> 'user'")
      .groupBy('i.threadId')
      .getRawMany<{ threadId: string; n: string }>()
    const latest = await this.repo(AgentTurn)
      .createQueryBuilder('tu')
      .select('MAX(tu.id)', 'id')
      .where('tu.threadId IN (:...ids)', { ids })
      .groupBy('tu.threadId')
      .getRawMany<{ id: string }>()
    const turns = latest.length
      ? await this.repo(AgentTurn).findBy({ id: In(latest.map((r) => num(r.id))) })
      : []
    const counts = new Map(unread.map((r) => [num(r.threadId), num(r.n)]))
    const status = new Map(turns.map((t) => [num(t.threadId), t.status]))
    return rows.map((r) =>
      threadVo(r, {
        unread: counts.get(num(r.id)) ?? 0,
        turnStatus: status.get(num(r.id)) ?? null,
      }),
    )
  }

  /**
   * 会话列表：只列本人的、非临时的；不给 status 只列进行中的（归档的要 status=archived）。视图：
   * `active` 最新一轮在运行或等确认，`unread` 有未读条目，`pinned` 已置顶。关键词同时匹配标题（LIKE）
   * 与消息全文（agent_item.text 的 ngram 全文索引，布尔模式，参数绑定）。置顶的排在前面。
   */
  async page(p: Principal, q: AgentThreadQuery): Promise<Page<AgentThreadVo>> {
    const qb = this.repo(AgentThread)
      .createQueryBuilder('t')
      .addSelect('t.shareToken')
      .where('t.userId = :uid', { uid: p.userId })
      .andWhere('t.temporary = 0')
      .andWhere('t.status = :status', { status: q.status ?? 'active' })
    if (q.view === 'pinned') qb.andWhere('t.pinned = 1')
    if (q.view === 'active')
      qb.andWhere(
        `EXISTS (SELECT 1 FROM agent_turn tu WHERE tu.thread_id = t.id AND tu.tenant_id = t.tenant_id
          AND tu.deleted_at IS NULL AND tu.status IN ('running', 'waiting'))`,
      )
    if (q.view === 'unread')
      qb.andWhere(
        `EXISTS (SELECT 1 FROM agent_item ui WHERE ui.thread_id = t.id AND ui.tenant_id = t.tenant_id
          AND ui.deleted_at IS NULL AND ui.seq > t.read_seq AND ui.kind <> 'user')`,
      )
    if (q.keyword) {
      const terms = fulltextTerms(q.keyword)
      qb.andWhere(
        terms
          ? `(t.title LIKE :kwLike OR EXISTS (SELECT 1 FROM agent_item ki WHERE ki.thread_id = t.id
              AND ki.tenant_id = t.tenant_id AND ki.deleted_at IS NULL
              AND MATCH (ki.text) AGAINST (:kwTerms IN BOOLEAN MODE)))`
          : 't.title LIKE :kwLike',
        { kwLike: contains(q.keyword), kwTerms: terms },
      )
    }
    qb.orderBy('t.pinned', 'DESC')
    const page = await paginate(qb, {
      ...q,
      sort: q.sort ?? [{ field: 'lastActiveAt', order: 'DESC' }],
    })
    return { items: await this.extras(page.items), total: page.total }
  }

  /** 新建会话：提供方与模型不给取默认；临时会话不进列表；页面上下文原样记下交给智能体。 */
  async create(p: Principal, dto: AgentThreadCreate): Promise<AgentThreadVo> {
    await this.assertMode(dto.approvalMode)
    const choice = await this.choose(dto.providerId, dto.model)
    const row = await this.repo(AgentThread).save(
      this.repo(AgentThread).create({
        userId: p.userId,
        title: dto.title || this.t('untitled'),
        status: 'active',
        providerId: choice?.providerId ?? null,
        model: choice?.model.id ?? null,
        reasoning: this.reasoningFor(choice, dto.reasoning),
        approvalMode: dto.approvalMode,
        planMode: dto.planMode,
        pinned: false,
        temporary: dto.temporary,
        readSeq: 0,
        trusted: null,
        forkedFromId: null,
        batchId: null,
        targetRef: null,
        context: dto.context ?? null,
        summary: null,
        summarySeq: 0,
        lastActiveAt: new Date(),
      }),
    )
    return threadVo(row, { unread: 0, turnStatus: null })
  }

  /**
   * 修改会话：改提供方或模型时对照启用的提供方校验（只改提供方取它的第一个模型）；推理强度只给支持的
   * 模型，换成不支持的模型时清掉原值；从“信任本会话”换到别的模式时清掉已信任的工具与目标。
   */
  async update(p: Principal, id: number, dto: AgentThreadUpdate): Promise<AgentThreadVo> {
    return this.txHost.withTransaction(async () => {
      const row = await this.own(p, id, { lock: true })
      await this.assertMode(dto.approvalMode)
      const set: Partial<AgentThread> = {}
      if (dto.title !== undefined) set.title = dto.title
      if (dto.status !== undefined) set.status = dto.status
      if (dto.approvalMode !== undefined) set.approvalMode = dto.approvalMode
      // 离开“信任本会话”：信任期间记住的工具与目标作废，回到逐个确认
      if (row.approvalMode === 'trust' && dto.approvalMode && dto.approvalMode !== 'trust')
        set.trusted = null
      if (dto.planMode !== undefined) set.planMode = dto.planMode
      if (dto.pinned !== undefined) set.pinned = dto.pinned
      const modelChanged = dto.providerId !== undefined || dto.model !== undefined
      if (modelChanged || dto.reasoning) {
        const providerId = dto.providerId ?? row.providerId ?? undefined
        // 只换提供方不给模型：原模型属于旧提供方，改取新提供方的第一个
        const model =
          dto.model ?? (dto.providerId !== undefined ? undefined : (row.model ?? undefined))
        const choice = await this.choose(providerId === null ? undefined : providerId, model)
        set.providerId = choice?.providerId ?? null
        set.model = choice?.model.id ?? null
        const wanted = dto.reasoning === undefined ? row.reasoning : dto.reasoning
        set.reasoning =
          dto.reasoning !== undefined
            ? this.reasoningFor(choice, wanted)
            : choice?.model.reasoning
              ? wanted
              : null
      } else if (dto.reasoning === null) set.reasoning = null
      if (Object.keys(set).length) await this.repo(AgentThread).update(row.id, set)
      const [vo] = await this.extras([await this.own(p, id, { token: true })])
      return vo!
    })
  }

  /** 删除会话：会话、它的轮次与条目一起软删（分享链接随之失效）。 */
  async remove(p: Principal, id: number): Promise<null> {
    await this.txHost.withTransaction(async () => {
      await this.own(p, id, { lock: true })
      await this.repo(AgentItem).softDelete({ threadId: id })
      await this.repo(AgentTurn).softDelete({ threadId: id })
      await this.repo(AgentThread).update(id, { shareToken: null })
      await this.repo(AgentThread).softDelete({ id })
    })
    return null
  }

  /** 最新一轮（没有为 null）。 */
  private latestTurn(threadId: number): Promise<AgentTurn | null> {
    return this.repo(AgentTurn).findOne({ where: { threadId }, order: { id: 'DESC' } })
  }

  /** 会话详情：`afterSeq` 之后的条目（不给为全部，按序号），以及最新一轮。 */
  async detail(p: Principal, id: number, afterSeq?: number): Promise<AgentThreadDetailVo> {
    const row = await this.own(p, id, { token: true })
    return this.detailOf(row, afterSeq)
  }

  private async detailOf(row: AgentThread, afterSeq?: number): Promise<AgentThreadDetailVo> {
    const threadId = num(row.id)
    const items = await this.repo(AgentItem).find({
      where: { threadId, ...(afterSeq !== undefined && { seq: MoreThan(afterSeq) }) },
      order: { seq: 'ASC' },
    })
    const turn = await this.latestTurn(threadId)
    const [thread] = await this.extras([row])
    return { thread: thread!, items: items.map(itemVo), turn: turn && turnVo(turn) }
  }

  /**
   * 从某条消息分叉：新会话复制原会话序号不超过 `seq` 的条目（新 id、同序号，不属于任何轮次；仍待处理的
   * 审批与提问标为已失效），设置与上下文照抄，标题加“（分叉）”，记下来源；摘要只在完全落在复制范围内时
   * 带过去。从没跑过的排队消息、没答完或空的回答与推理不复制（{@link forkable}）。复制的条目全部算已读。
   */
  async fork(p: Principal, id: number, seq: number): Promise<AgentThreadVo> {
    return this.txHost.withTransaction(async () => {
      const src = await this.own(p, id, { lock: true })
      const items = (
        await this.repo(AgentItem).find({
          where: { threadId: id, seq: LessThanOrEqual(seq) },
          order: { seq: 'ASC' },
        })
      ).filter(forkable)
      const keepSummary = !!src.summary && src.summarySeq <= seq
      const copy = await this.repo(AgentThread).save(
        this.repo(AgentThread).create({
          userId: p.userId,
          title: this.t('forkTitle', { title: src.title }).slice(0, 200),
          status: 'active',
          providerId: src.providerId,
          model: src.model,
          reasoning: src.reasoning,
          approvalMode: src.approvalMode,
          planMode: src.planMode,
          pinned: false,
          temporary: src.temporary,
          readSeq: items.at(-1)?.seq ?? 0,
          trusted: null,
          forkedFromId: num(src.id),
          batchId: null,
          targetRef: src.targetRef,
          context: src.context,
          summary: keepSummary ? src.summary : null,
          summarySeq: keepSummary ? src.summarySeq : 0,
          lastActiveAt: new Date(),
        }),
      )
      if (items.length)
        await this.repo(AgentItem).save(
          items.map((i) =>
            this.repo(AgentItem).create({
              threadId: num(copy.id),
              turnId: null,
              seq: i.seq,
              kind: i.kind,
              status: i.status && OPEN_STATUSES.has(i.status) ? 'expired' : i.status,
              payload: i.payload,
              text: i.text,
            }),
          ),
          { chunk: 200 },
        )
      return threadVo(copy, { unread: 0, turnStatus: null })
    })
  }

  /** 标记已读到 `seq`（只前进不后退）。 */
  async read(p: Principal, id: number, seq: number): Promise<null> {
    await this.own(p, id)
    await this.repo(AgentThread)
      .createQueryBuilder()
      .update()
      .set({ readSeq: () => 'GREATEST(read_seq, :readTo)' })
      .where('id = :id', { id })
      .setParameter('readTo', seq)
      .execute()
    return null
  }

  /** 本人的全部会话标为已读：已读位置移到各自最新的条目（只前进不后退；ORM 加当前租户条件）。 */
  async readAll(p: Principal): Promise<null> {
    await this.repo(AgentThread)
      .createQueryBuilder()
      .update()
      .set({
        // 关联子查询带上同一租户，只取会话自己的未删条目
        readSeq: () =>
          `GREATEST(read_seq, COALESCE((SELECT MAX(i.seq) FROM agent_item i WHERE i.thread_id = agent_thread.id
            AND i.tenant_id = agent_thread.tenant_id AND i.deleted_at IS NULL), 0))`,
      })
      .where('user_id = :uid AND deleted_at IS NULL', { uid: p.userId })
      .execute()
    return null
  }

  /**
   * 撤回最后一轮：它与它之后的条目一起软删。轮次正在运行时 409（先停止）；轮次停在等待、却还有工具调用在
   * 执行（在调用里等外部服务器的表单）时也 409：那次外部调用撤不回来，记录不能先删掉。只删对话记录：这一轮
   * 里已经执行的写入不会回滚。这一轮记下的“本会话内信任”一并去掉。压缩摘要覆盖到了被撤回的条目时一并清掉
   * （否则模型还会从摘要里看到撤回的内容），下一轮需要时再重新压缩。
   */
  async revert(p: Principal, id: number): Promise<null> {
    await this.txHost.withTransaction(async () => {
      const thread = await this.own(p, id, { lock: true })
      const turn = await this.repo(AgentTurn).findOne({
        where: { threadId: id },
        order: { id: 'DESC' },
        lock: { mode: 'pessimistic_write' },
      })
      if (!turn) return
      if (turn.status === 'running') throw new BizError(Err.CONFLICT)
      const inCall = await this.repo(AgentItem).existsBy({
        turnId: turn.id,
        kind: 'tool_call',
        status: 'running',
      })
      if (inCall) throw new BizError(Err.CONFLICT)
      const kept = (thread.trusted ?? []).filter((e) => parseTrust(e).turnId !== num(turn.id))
      if (kept.length !== (thread.trusted ?? []).length)
        await this.repo(AgentThread).update(id, { trusted: kept.length ? kept : null })
      const first = await this.repo(AgentItem)
        .createQueryBuilder('i')
        .select('MIN(i.seq)', 'seq')
        .where('i.turnId = :turnId', { turnId: turn.id })
        .getRawOne<{ seq: number | null }>()
      // 从这一轮的第一条起全部删掉：其后的条目（排队等下一轮的消息等）也属于被撤回的部分
      if (first?.seq !== null && first?.seq !== undefined) {
        await this.repo(AgentItem).softDelete({ threadId: id, seq: MoreThan(num(first.seq) - 1) })
        if (thread.summary !== null && thread.summarySeq >= num(first.seq))
          await this.repo(AgentThread).update(id, { summary: null, summarySeq: 0 })
      }
      await this.repo(AgentTurn).softDelete({ id: num(turn.id) })
    })
    return null
  }

  /** 导出为 Markdown（文件名取标题）；工具参数按操作日志规则遮蔽，工具结果内容不导出。 */
  async export(p: Principal, id: number): Promise<{ name: string; text: string }> {
    const row = await this.own(p, id)
    const items = (
      await this.repo(AgentItem).find({ where: { threadId: id }, order: { seq: 'ASC' } })
    ).map(itemVo)
    const name = `${row.title.replace(/[\\/:*?"<>|\r\n\t]+/g, '_').slice(0, 100) || 'thread'}.md`
    return { name, text: threadMarkdown(row.title, items, (k) => this.t(`export.${k}`)) }
  }

  /**
   * `/status`：下一次调用模型约占多少上下文（摘要 + 摘要之后条目的字符数 ÷ 3.5）与模型窗口、最新一轮，
   * 以及今天（UTC）本人与本租户的 token 用量和限额。
   */
  async status(p: Principal, id: number): Promise<AgentStatusVo> {
    const row = await this.own(p, id)
    const chars = await this.repo(AgentItem)
      .createQueryBuilder('i')
      .select('COALESCE(SUM(CHAR_LENGTH(COALESCE(i.text, CAST(i.payload AS CHAR)))), 0)', 'n')
      .where('i.threadId = :id AND i.seq > :after', { id, after: row.summarySeq })
      .getRawOne<{ n: string }>()
    const list = await this.enabledProviders()
    const prov = list.find((x) => x.id === num(row.providerId)) ?? list[0]
    const model = prov?.models.find((m) => m.id === row.model) ?? prov?.models[0]
    const turn = await this.latestTurn(id)
    const day = new Date().toISOString().slice(0, 10)
    // 不给 userId 为本租户全部用户（ORM 加当前租户条件）
    const used = async (userId?: number) => {
      const qb = this.repo(AgentUsage)
        .createQueryBuilder('u')
        .select('COALESCE(SUM(u.promptTokens + u.completionTokens), 0)', 'n')
        .where('u.day = :day', { day })
      if (userId !== undefined) qb.andWhere('u.userId = :userId', { userId })
      return num((await qb.getRawOne<{ n: string }>())?.n ?? 0)
    }
    const max = Number.MAX_SAFE_INTEGER
    return {
      threadId: id,
      model: row.model ?? model?.id ?? null,
      contextUsed: Math.ceil(((row.summary?.length ?? 0) + num(chars?.n ?? 0)) / CHARS_PER_TOKEN),
      contextWindow: model?.contextWindow ?? 0,
      turn: turn && turnVo(turn),
      today: {
        userTokens: await used(p.userId),
        userLimit: await this.params.int(
          AGENT_LIMIT_PARAMS.userDailyTokens,
          0,
          max,
          USER_DAILY_DEFAULT,
        ),
        tenantTokens: await used(),
        tenantLimit: await this.params.int(
          AGENT_LIMIT_PARAMS.tenantDailyTokens,
          0,
          max,
          TENANT_DAILY_DEFAULT,
        ),
      },
    }
  }

  /** 开启只读分享：随机 32 位令牌（已分享的沿用原令牌）；临时会话不能分享（409）。 */
  async share(p: Principal, id: number): Promise<{ token: string }> {
    return this.txHost.withTransaction(async () => {
      const row = await this.own(p, id, { lock: true, token: true })
      if (row.temporary) throw new BizError(Err.CONFLICT)
      if (row.shareToken) return { token: row.shareToken }
      const token = randomBytes(16).toString('hex')
      await this.repo(AgentThread).update(id, { shareToken: token })
      return { token }
    })
  }

  /** 关闭分享：令牌作废，旧链接 404。 */
  async unshare(p: Principal, id: number): Promise<null> {
    await this.own(p, id)
    await this.repo(AgentThread).update(id, { shareToken: null })
    return null
  }

  /**
   * 按分享令牌只读查看：只在同一租户内有效（ORM 加当前租户条件，别的租户的令牌 404），临时会话不能看；
   * 查看者不是会话主人时，工具参数、输出与审批明细一律隐去（{@link sharedItems}）。
   */
  async shared(viewer: Principal, token: string): Promise<AgentThreadDetailVo> {
    if (!/^[0-9a-f]{32}$/.test(token)) throw new NotFoundException()
    const row = await this.repo(AgentThread)
      .createQueryBuilder('t')
      .addSelect('t.shareToken')
      .where('t.shareToken = :token AND t.temporary = 0', { token })
      .getOne()
    if (!row) throw new NotFoundException()
    const detail = await this.detailOf(row)
    const owner = num(row.userId) === viewer.userId
    return {
      thread: { ...detail.thread, unread: 0 },
      items: owner ? detail.items : sharedItems(detail.items),
      turn: owner || !detail.turn ? detail.turn : sharedTurn(detail.turn),
    }
  }

  /**
   * 对自己会话里的一条智能体回答点赞或点踩：每人每条一份（再提交即覆盖），记下本次请求的 traceId 便于
   * 排查。锁住会话行，使同一人的并发提交串行，不会写出两份。
   */
  async feedback(p: Principal, dto: AgentFeedbackSave): Promise<null> {
    await this.txHost.withTransaction(async () => {
      const item = await this.repo(AgentItem).findOneBy({ id: dto.itemId })
      if (!item || item.kind !== 'assistant') throw new NotFoundException()
      await this.own(p, num(item.threadId), { lock: true })
      const fields = {
        rating: dto.rating,
        comment: dto.comment || null,
        traceId: clsGet('traceId')?.slice(0, 64) ?? null,
      }
      const found = await this.repo(AgentFeedback).findOneBy({
        itemId: dto.itemId,
        userId: p.userId,
      })
      if (found) await this.repo(AgentFeedback).update(found.id, fields)
      else
        await this.repo(AgentFeedback).save(
          this.repo(AgentFeedback).create({
            threadId: num(item.threadId),
            itemId: dto.itemId,
            userId: p.userId,
            ...fields,
          }),
        )
    })
    return null
  }
}
