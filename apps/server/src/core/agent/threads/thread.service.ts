import { createHash, randomBytes } from 'node:crypto'
import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  AGENT2_PARAMS,
  AGENT_LIMIT_PARAMS,
  type AgentFeedbackSave,
  type AgentDraftReceiptVo,
  type AgentMessageReceiptVo,
  type AgentModelVo,
  type AgentProviderVo,
  type AgentStatusVo,
  type AgentThreadCreate,
  type AgentThreadDetailVo,
  type AgentThreadQuery,
  type AgentThreadUpdate,
  type AgentThreadVo,
  DEFAULT_LOCALE,
  Err,
  type Page,
} from '@qiwu/shared'
import { I18nService } from 'nestjs-i18n'
import {
  In,
  IsNull,
  LessThanOrEqual,
  MoreThan,
  type EntityManager,
  type ObjectLiteral,
  type Repository,
} from 'typeorm'
import type { Principal } from '../../auth/principal.js'
import { clsGet } from '../../context/cls.js'
import { contains, paginate } from '../../db/page.js'
import { BizError } from '../../http/biz-error.js'
import { canonicalJson } from '../../guard/idempotent.js'
import { currentLocale } from '../../i18n/locale.js'
import { ParamService } from '../../settings/param.service.js'
import {
  AGENT_IMAGE_STORE,
  type AgentImageStore,
  type AgentRunProfile,
  PROFILE_SOURCE,
  type ProfileSource,
} from '../agent-ports.js'
import {
  AgentFeedback,
  AgentItem,
  AgentMessageReceipt,
  AgentThread,
  AgentTurn,
} from '../entities/agent-thread.entity.js'
import { UsageBook } from '../runtime/usage-book.js'
import { TurnRunner } from '../runtime/turn-runner.js'
import { ACTIVE_TURN } from '../runtime/turn-queue.js'
import { REDIS, type Redis } from '../../redis/redis.module.js'
import { copyMemoryMark } from '../memory/memory-extract.js'
import { ProviderSettingsService } from '../provider/provider-settings.service.js'
import { AgentExtensions, runThread } from '../runtime/agent-extensions.js'
import { parseReviewModel } from '../runtime/auto-reviewer.js'
import { contextMessage } from '../runtime/turn-prompt.js'
import { parseAllow, subagentCallOf } from '../runtime/turn-tools.js'
import {
  fulltextTerms,
  itemVo,
  num,
  sharedItems,
  sharedTurn,
  threadMarkdown,
  threadVo,
  turnVo,
} from './thread-vo.js'

/** 估算上下文 token：每 token 约 3.5 个字符（中英文混合的粗略值，只用于输入框旁的用量环）。 */
const CHARS_PER_TOKEN = 3.5
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
    private readonly ext: AgentExtensions,
    private readonly usage: UsageBook,
    private readonly runner: TurnRunner,
    @Inject(REDIS) private readonly redis: Redis,
    @Optional() @Inject(PROFILE_SOURCE) private readonly profiles?: ProfileSource,
    @Optional() @Inject(AGENT_IMAGE_STORE) private readonly images?: AgentImageStore,
  ) {}

  private readonly logger = new Logger(AgentThreadService.name)

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

  /**
   * 平台此刻是否提供这个模式：“自动审查”在平台没有指定有效的审查模型时不提供（与输入框选项里的判断相同），
   * 其余总是提供。
   */
  private async modeOffered(mode: AgentThread['approvalMode']): Promise<boolean> {
    if (mode === 'auto_review')
      return !!parseReviewModel(await this.params.get(AGENT2_PARAMS.reviewModel))
    return true
  }

  /** 新建与修改会话时选了平台此刻不提供的审批模式：400；自动化开隐藏会话与保存时也经它校验。 */
  async assertMode(mode: AgentThread['approvalMode'] | undefined): Promise<void> {
    if (mode !== undefined && !(await this.modeOffered(mode)))
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
      // 子智能体与自动化开的隐藏会话不进列表
      .andWhere('t.parentThreadId IS NULL AND t.automationRunId IS NULL')
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

  /** 本人可用的一个配置方案；不存在、别人的个人方案、别的租户的一律 404。 */
  private async profileOf(p: Principal, id: number): Promise<AgentRunProfile> {
    const found = await this.profiles?.find(p, id)
    if (!found) throw new NotFoundException()
    return found
  }

  /**
   * 新建会话时带入配置方案：给了 `profileId` 用它，null 为不用方案，不给用本人的默认方案。请求里给了的字段
   * 优先（模式也是：只有请求没给时才取方案的），方案的模式平台此刻不提供（如不再指定审查模型）就退回
   * `ask`；方案的模型已停用时退回平台默认模型，推理强度只给支持它的模型。工具清单与额外说明在运行时
   * 按方案生效。
   */
  private async withProfile(p: Principal, dto: AgentThreadCreate) {
    const profile =
      dto.profileId === null
        ? null
        : dto.profileId !== undefined
          ? await this.profileOf(p, dto.profileId)
          : ((await this.profiles?.defaultFor(p)) ?? null)
    if (!profile)
      return {
        profile,
        mode: dto.approvalMode ?? 'ask',
        choice: await this.choose(dto.providerId, dto.model),
        reasoning: dto.reasoning,
      }
    const mode =
      dto.approvalMode ??
      ((await this.modeOffered(profile.approvalMode)) ? profile.approvalMode : 'ask')
    const own = dto.providerId !== undefined || dto.model !== undefined
    const choice = own
      ? await this.choose(dto.providerId, dto.model)
      : await this.choose(profile.providerId ?? undefined, profile.model ?? undefined).catch(() =>
          this.choose(),
        )
    const reasoning =
      dto.reasoning ?? (choice?.model.reasoning ? (profile.reasoning ?? undefined) : undefined)
    return { profile, mode, choice, reasoning }
  }

  /**
   * 新建会话：提供方与模型不给取默认（或配置方案的，见 {@link withProfile}）；临时会话不进列表；页面上下文
   * 原样记下交给智能体；记忆默认开。
   */
  async create(p: Principal, dto: AgentThreadCreate): Promise<AgentThreadVo> {
    const { clientDraftId, ...input } = dto
    const hash = clientDraftId
      ? createHash('sha256')
          .update(canonicalJson({ kind: 'create', input }))
          .digest('hex')
      : null
    const replay = async () => {
      if (!clientDraftId) return null
      const saved = await this.repo(AgentThread).findOne({
        where: { userId: p.userId, clientDraftId },
        withDeleted: true,
      })
      if (!saved) return null
      if (saved.deletedAt || saved.clientDraftHash !== hash) throw new BizError(Err.CONFLICT)
      return (await this.extras([saved]))[0]!
    }
    const existing = await replay()
    if (existing) return existing
    const { profile, mode, choice, reasoning } = await this.withProfile(p, dto)
    await this.assertMode(mode)
    let row: AgentThread
    try {
      row = await this.repo(AgentThread).save(
        this.repo(AgentThread).create({
          clientDraftId: clientDraftId ?? null,
          clientDraftHash: hash,
          userId: p.userId,
          title: dto.title || this.t('untitled'),
          status: 'active',
          providerId: choice?.providerId ?? null,
          model: choice?.model.id ?? null,
          reasoning: this.reasoningFor(choice, reasoning),
          approvalMode: mode,
          profileId: profile?.id ?? null,
          memoryEnabled: dto.memoryEnabled,
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
    } catch (error) {
      // 并发唯一键或落库后响应异常都先按持久键查证，不能再建一个空会话。
      const found = await replay()
      if (found) return found
      throw error
    }
    return threadVo(row, { unread: 0, turnStatus: null })
  }

  /** 只按本人及当前租户核对创建回执，删除后的永久标识不会复活旧会话。 */
  async draftReceipt(p: Principal, clientDraftId: string): Promise<AgentDraftReceiptVo> {
    const row = await this.repo(AgentThread).findOne({
      where: { userId: p.userId, clientDraftId },
      withDeleted: true,
    })
    if (!row) throw new NotFoundException()
    return {
      clientDraftId,
      threadId: num(row.id),
      status: row.deletedAt ? 'removed' : 'accepted',
      thread: row.deletedAt ? null : (await this.extras([row]))[0]!,
    }
  }

  /** 消息接收回执独立于排队条目的后续移动；查证只读，不启动任何轮次或重放业务写入。 */
  async messageReceipt(
    p: Principal,
    id: number,
    clientMessageId: string,
  ): Promise<AgentMessageReceiptVo> {
    const thread = await this.repo(AgentThread).findOne({
      where: { id, userId: p.userId },
      withDeleted: true,
    })
    if (!thread) throw new NotFoundException()
    const receipt = await this.repo(AgentMessageReceipt).findOneBy({
      threadId: id,
      userId: p.userId,
      clientMessageId,
    })
    if (!receipt) throw new NotFoundException()
    const item = await this.repo(AgentItem).findOneBy({ id: num(receipt.itemId), threadId: id })
    const turn = await this.repo(AgentTurn).findOneBy({
      id: num(receipt.acceptedTurnId),
      threadId: id,
    })
    const removed = !!thread.deletedAt || !item || !turn
    return {
      clientMessageId,
      threadId: id,
      itemId: num(receipt.itemId),
      turnId: num(receipt.acceptedTurnId),
      status: removed ? 'removed' : 'accepted',
      turn: removed || !turn ? null : turnVo(turn),
    }
  }

  /** 本人明确核对后解除当前代风险闸；仍有原执行者时拒绝，且不续跑旧轮次或旧队列。 */
  async acknowledgeRecovery(p: Principal, id: number, revision: number): Promise<AgentThreadVo> {
    if (p.actingTenantId !== undefined && p.actingTenantId !== p.tenantId)
      throw new BizError(Err.FORBIDDEN)
    return this.txHost.withTransaction(async () => {
      const thread = await this.own(p, id, { lock: true })
      if (thread.recoveryRevision !== revision) throw new BizError(Err.CONFLICT)
      if (thread.recoveryRequired) {
        await this.runner.assertRecoveryReady(id, this.txHost.tx)
        await this.repo(AgentThread).update(id, { recoveryRequired: false })
        thread.recoveryRequired = false
      }
      return (await this.extras([thread]))[0]!
    })
  }

  /**
   * 修改会话：改提供方或模型时对照启用的提供方校验（只改提供方取它的第一个模型）；推理强度只给支持的
   * 模型，换成不支持的模型时清掉原值；换模式不动本会话已放行的工具；可逐会话关掉记忆、换用或去掉配置方案
   * （别人的方案 404）。
   */
  async update(p: Principal, id: number, dto: AgentThreadUpdate): Promise<AgentThreadVo> {
    return this.txHost.withTransaction(async () => {
      const row = await this.own(p, id, { lock: true })
      await this.assertMode(dto.approvalMode)
      const set: Partial<AgentThread> = {}
      if (dto.title !== undefined) set.title = dto.title
      if (dto.status !== undefined) set.status = dto.status
      if (dto.approvalMode !== undefined) set.approvalMode = dto.approvalMode
      if (dto.pinned !== undefined) set.pinned = dto.pinned
      if (dto.memoryEnabled !== undefined) set.memoryEnabled = dto.memoryEnabled
      // 换配置方案只换工具清单与额外说明（运行时生效）；模型与模式照旧可单独改
      if (dto.profileId !== undefined)
        set.profileId = dto.profileId === null ? null : (await this.profileOf(p, dto.profileId)).id
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

  /**
   * 撤销本会话对一个工具的放行（“本会话内不再询问”）：之后它的调用重新停下询问；运行中的轮次在下一次调用
   * 时就按撤销处理（运行时每次重新读取）。别人的或跨租户的会话 404；没放行过的工具什么也不做。
   */
  async revokeTool(p: Principal, id: number, tool: string): Promise<AgentThreadVo> {
    return this.txHost.withTransaction(async () => {
      const row = await this.own(p, id, { lock: true })
      const kept = (row.trusted ?? []).filter((e) => parseAllow(e).tool !== tool)
      if (kept.length !== (row.trusted ?? []).length)
        await this.repo(AgentThread).update(row.id, { trusted: kept.length ? kept : null })
      const [vo] = await this.extras([await this.own(p, id, { token: true })])
      return vo!
    })
  }

  /** 删除会话：会话、它的轮次与条目一起软删（分享链接随之失效），提交之后再删它生成的图片。 */
  async remove(p: Principal, id: number): Promise<null> {
    await this.txHost.withTransaction(async () => {
      const row = await this.own(p, id, { lock: true })
      await this.assertRemovable(row)
      await this.dropSubagents(id)
      await this.repo(AgentItem).softDelete({ threadId: id })
      await this.repo(AgentTurn).softDelete({ threadId: id })
      await this.repo(AgentThread).update(id, { shareToken: null })
      await this.repo(AgentThread).softDelete({ id })
    })
    await this.dropImages(id)
    return null
  }

  /**
   * 删除自动化时：它的运行开的隐藏会话连同轮次、条目、子会话一起软删，再删这些会话生成的图片。会话里还在
   * 跑的轮次（调用方已先中断）随后发现会话已删，安静地停下。
   */
  async dropHidden(
    threadIds: number[],
    beforeDelete?: (m: EntityManager) => Promise<void>,
  ): Promise<void> {
    if (!threadIds.length && !beforeDelete) return
    await this.txHost.withTransaction(async () => {
      for (const id of [...new Set(threadIds)].sort((a, b) => a - b)) {
        const row = await this.repo(AgentThread).findOne({
          where: { id },
          lock: { mode: 'pessimistic_write' },
        })
        if (row) await this.assertRemovable(row)
      }
      if (beforeDelete) await beforeDelete(this.txHost.tx)
      if (!threadIds.length) return
      for (const id of threadIds) await this.dropSubagents(id)
      await this.repo(AgentItem).softDelete({ threadId: In(threadIds) })
      await this.repo(AgentTurn).softDelete({ threadId: In(threadIds) })
      await this.repo(AgentThread).softDelete({ id: In(threadIds) })
    })
    for (const id of threadIds) await this.dropImages(id)
  }

  /** 删除不能把活写入或未核对结果的证据藏掉；停止与本人核对均由明确入口办理。 */
  private async assertRemovable(row: AgentThread): Promise<void> {
    if (row.recoveryRequired) throw new BizError(Err.AGENT_RECOVERY_REQUIRED)
    if (await this.repo(AgentTurn).existsBy({ threadId: num(row.id), status: ACTIVE_TURN }))
      throw new BizError(Err.AGENT_THREAD_BUSY)
  }

  /**
   * 删掉会话生成的图片（`callIds` 给出时只删这些调用的），在会话或那一轮已删之后调用：图片文件私有、记在
   * 本人名下，留着就成了找不到出处的文件。失败只记日志（记录已经删了，下次不会再来删，由管理员在文件页清理）。
   */
  private async dropImages(threadId: number, callIds?: string[]): Promise<void> {
    try {
      await this.images?.drop(threadId, callIds)
    } catch (e) {
      this.logger.warn(
        { threadId, err: e instanceof Error ? e.name : 'Error' },
        'agent images not removed',
      )
    }
  }

  /**
   * 软删会话分派出的子智能体的会话及其轮次与条目（`callIds` 给出时只删这些调用分派出的）：子会话只能从父会话
   * 的卡片打开，父会话或那一轮没了，它们也不该留下。还在运行的子轮次随后发现会话已删，安静地停下。
   */
  private async dropSubagents(parentId: number, callIds?: Set<string>): Promise<void> {
    const kids = await this.repo(AgentThread).find({
      where: { parentThreadId: parentId },
      select: { id: true, targetRef: true },
    })
    const ids = kids
      .filter((k) => !callIds || callIds.has(subagentCallOf(k.targetRef) ?? ''))
      .map((k) => num(k.id))
    if (!ids.length) return
    await this.repo(AgentItem).softDelete({ threadId: In(ids) })
    await this.repo(AgentTurn).softDelete({ threadId: In(ids) })
    await this.repo(AgentThread).softDelete({ id: In(ids) })
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
  async fork(
    p: Principal,
    id: number,
    seq: number,
    clientDraftId?: string,
  ): Promise<AgentThreadVo> {
    return this.txHost.withTransaction(async () => {
      const src = await this.own(p, id, { lock: true })
      const hash = clientDraftId
        ? createHash('sha256')
            .update(canonicalJson({ kind: 'fork', sourceThreadId: id, seq }))
            .digest('hex')
        : null
      if (clientDraftId) {
        const existing = await this.repo(AgentThread).findOne({
          where: { userId: p.userId, clientDraftId },
          withDeleted: true,
        })
        if (existing) {
          if (existing.deletedAt || existing.clientDraftHash !== hash)
            throw new BizError(Err.CONFLICT)
          return (await this.extras([existing]))[0]!
        }
      }
      await this.assertRemovable(src)
      // 自动化与子智能体的隐藏会话不能分叉：分叉出的是一个能继续发消息的普通会话，会带着隐藏会话里的
      // 事件数据与（预先同意的）技能绑定继续跑
      if (src.automationRunId !== null || src.parentThreadId !== null)
        throw new BizError(Err.CONFLICT)
      // 分叉（含编辑后重发）照抄模式（本会话的放行不带过去）；此刻平台不再提供的模式不借分叉带过去，降为逐次询问
      const approvalMode = (await this.modeOffered(src.approvalMode)) ? src.approvalMode : 'ask'
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
          approvalMode,
          profileId: src.profileId,
          memoryEnabled: src.memoryEnabled,
          pinned: false,
          temporary: src.temporary,
          readSeq: items.at(-1)?.seq ?? 0,
          trusted: null,
          forkedFromId: num(src.id),
          clientDraftId: clientDraftId ?? null,
          clientDraftHash: hash,
          recoveryRequired: false,
          recoveryRevision: 0,
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
      // 复制过来的条目已提炼过的部分不再提炼一次
      await copyMemoryMark(this.redis, id, num(copy.id), items.at(-1)?.seq ?? 0)
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
   * 里已经执行的写入不会回滚。这一轮记下的“本会话内不再询问”一并去掉。压缩摘要覆盖到了被撤回的条目时一并清掉
   * （否则模型还会从摘要里看到撤回的内容），下一轮需要时再重新压缩。
   */
  async revert(p: Principal, id: number): Promise<null> {
    let callIds: string[] = []
    await this.txHost.withTransaction(async () => {
      const thread = await this.own(p, id, { lock: true })
      if (thread.recoveryRequired) throw new BizError(Err.AGENT_RECOVERY_REQUIRED)
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
      // 这一轮分派出的子会话随这一轮一起撤回
      const calls = await this.repo(AgentItem).find({
        where: { turnId: turn.id, kind: 'tool_call' },
        select: { id: true, payload: true },
      })
      callIds = calls.map((c) => String((c.payload as { callId?: unknown }).callId))
      await this.dropSubagents(id, new Set(callIds))
      const kept = (thread.trusted ?? []).filter((e) => parseAllow(e).turnId !== num(turn.id))
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
    // 这一轮生成的图片随这一轮一起撤回
    await this.dropImages(id, callIds)
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
   * `/status`：下一次调用模型约占多少上下文（上下文贡献者的各段 + 摘要 + 摘要之后条目的字符数 ÷ 3.5）与
   * 模型窗口、最新一轮，以及今天（UTC）本人与本租户的原始 Token 用量及积分预算。
   */
  async status(p: Principal, id: number): Promise<AgentStatusVo> {
    const row = await this.own(p, id)
    const contributed = await this.contributedChars(p, row)
    const chars = await this.repo(AgentItem)
      .createQueryBuilder('i')
      .select('COALESCE(SUM(CHAR_LENGTH(COALESCE(i.text, CAST(i.payload AS CHAR)))), 0)', 'n')
      .where('i.threadId = :id AND i.seq > :after', { id, after: row.summarySeq })
      .getRawOne<{ n: string }>()
    const list = await this.enabledProviders()
    const prov = list.find((x) => x.id === num(row.providerId)) ?? list[0]
    const model = prov?.models.find((m) => m.id === row.model) ?? prov?.models[0]
    const turn = await this.latestTurn(id)
    const retained =
      turn && ['running', 'waiting'].includes(turn.status)
        ? await this.repo(AgentItem)
            .createQueryBuilder('u')
            .select('COALESCE(SUM(CHAR_LENGTH(u.text)), 0)', 'n')
            .where(
              'u.threadId = :id AND u.turnId = :turn AND u.kind = :kind AND u.seq <= :summary',
              {
                id,
                turn: turn.id,
                kind: 'user',
                summary: row.summarySeq,
              },
            )
            .getRawOne<{ n: string }>()
        : null
    const user = await this.usage.today(p.userId)
    const tenant = await this.usage.today()
    const tokens = (u: typeof user) =>
      u.promptTokens === null || u.completionTokens === null
        ? null
        : u.promptTokens + u.completionTokens
    return {
      threadId: id,
      model: row.model ?? model?.id ?? null,
      contextUsed: Math.ceil(
        (contributed + (row.summary?.length ?? 0) + num(chars?.n ?? 0) + num(retained?.n ?? 0)) /
          CHARS_PER_TOKEN,
      ),
      contextWindow: model?.contextWindow ?? 0,
      turn: turn && turnVo(turn),
      today: {
        userTokens: tokens(user),
        userCredits: user.credits,
        userLimit: await this.usage.limit(AGENT_LIMIT_PARAMS.userDailyCredits),
        userUnpricedCalls: user.unpricedCalls,
        userLegacyCalls: user.legacyCalls,
        tenantTokens: tokens(tenant),
        tenantCredits: tenant.credits,
        tenantLimit: await this.usage.limit(AGENT_LIMIT_PARAMS.tenantDailyCredits),
        tenantUnpricedCalls: tenant.unpricedCalls,
        tenantLegacyCalls: tenant.legacyCalls,
      },
    }
  }

  /**
   * 上下文贡献者此刻会给出的各段的字符数（与运行时拼进请求的消息同一形状）：用最新一条已发出的用户消息
   * 挑选内容，没有轮次（turnId 为 null）。没有登记贡献者时为 0、不查库。
   */
  private async contributedChars(p: Principal, row: AgentThread): Promise<number> {
    if (!this.ext.hasContributors()) return 0
    const last = await this.repo(AgentItem).findOne({
      where: { threadId: row.id, kind: 'user', status: IsNull() },
      order: { seq: 'DESC' },
    })
    const parts = await this.ext.contextParts({
      principal: p,
      thread: runThread(row),
      turnId: null,
      // 与运行时同一种取法：发起人自己的语言，没有时用默认语言（不看这次请求的语言头）
      lang: p.locale ?? DEFAULT_LOCALE,
      signal: new AbortController().signal,
      userText: last ? String((last.payload as { text?: unknown }).text ?? '') : null,
    })
    return parts.reduce((n, part) => n + String(contextMessage(part).content).length, 0)
  }

  /** 开启只读分享：随机 32 位令牌（已分享的沿用原令牌）；临时会话、自动化与子智能体的会话不能分享（409）。 */
  async share(p: Principal, id: number): Promise<{ token: string }> {
    return this.txHost.withTransaction(async () => {
      const row = await this.own(p, id, { lock: true, token: true })
      if (row.temporary || row.automationRunId !== null || row.parentThreadId !== null)
        throw new BizError(Err.CONFLICT)
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
      // 本会话放行了哪些工具是本人的设置，分享出去的只读视图不带
      thread: { ...detail.thread, unread: 0, allowedTools: [] },
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
