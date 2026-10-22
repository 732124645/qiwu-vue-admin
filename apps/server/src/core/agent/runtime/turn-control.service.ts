import { Inject, Injectable, Optional } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  AGENT_TRUST_MODE_PARAM,
  type AgentApprovalDecide,
  type AgentItemPayloads,
  type AgentAttachment,
  type AgentMessageSend,
  type AgentQuestionAnswer,
  Err,
} from '@qiwu/shared'
import { I18nService } from 'nestjs-i18n'
import { type DataSource, IsNull, MoreThan } from 'typeorm'
import type { Principal } from '../../auth/principal.js'
import { BizError } from '../../http/biz-error.js'
import { currentLocale } from '../../i18n/locale.js'
import { ProviderRegistry } from '../provider/provider-registry.js'
import { ParamService } from '../../settings/param.service.js'
import { trustModeOn } from '../threads/thread-vo.js'
import {
  ATTACHMENT_SOURCE,
  type AttachmentSource,
  SKILL_SOURCE,
  type SkillSource,
  type TurnControl,
} from '../agent-ports.js'
import { AgentItem, AgentThread, AgentTurn } from '../entities/agent-thread.entity.js'
import { type ItemInternal, ItemStore, type ItemWriter, StaleItem } from './item-store.js'
import { ACTIVE_TURN, TurnQueue } from './turn-queue.js'
import { TurnRunner } from './turn-runner.js'
import { isTrusted, trustEntry } from './turn-tools.js'
import { HumanConfirmation } from './human-confirmation.js'

const notFound = () => new BizError(Err.NOT_FOUND)

/**
 * 对话页的操作（会话接口与批量任务共用，see docs/agent.md）：发消息开一轮或追加 / 排队、中断、手动压缩、
 * 确认审批、回答提问。全部只对会话所有人本人生效：别人的会话、条目与跨租户的一律 404（ORM 的租户条件
 * 加上所有人比对）；判断与写入都在会话行锁里，和运行中的轮次互斥。
 */
@Injectable()
export class TurnControlService implements TurnControl {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly store: ItemStore,
    private readonly confirmation: HumanConfirmation,
    private readonly queue: TurnQueue,
    private readonly runner: TurnRunner,
    private readonly providers: ProviderRegistry,
    private readonly params: ParamService,
    private readonly i18n: I18nService,
    @Optional() @Inject(SKILL_SOURCE) private readonly skills?: SkillSource,
    @Optional() @Inject(ATTACHMENT_SOURCE) private readonly attachments?: AttachmentSource,
  ) {}

  /** 锁住本人的会话；别人的或不存在的 404。 */
  private async own(w: ItemWriter, p: Principal, threadId: number): Promise<AgentThread> {
    const thread = await w.thread(threadId)
    if (!thread || Number(thread.userId) !== p.userId) throw notFound()
    return thread
  }

  /**
   * 发一条消息：没有进行中的轮次就开新一轮并入队（急停时拒绝，本人同时运行的轮次有上限）；有就按
   * `mode` 追加到当前轮（下一步起模型就能看到）或排队到下一轮。会话的第一轮开始时，本人的其他临时
   * 会话被删掉（“开始新对话”）。
   */
  async send(p: Principal, threadId: number, msg: AgentMessageSend): Promise<{ turnId: number }> {
    // 进入其他租户的平台人员不经智能体操作那个租户：轮次以会话所有人的身份在会话的租户里执行
    if (p.actingTenantId !== undefined && p.actingTenantId !== p.tenantId)
      throw new BizError(Err.FORBIDDEN)
    if (await this.runner.paused()) throw new BizError(Err.AGENT_PAUSED)
    if (msg.skill && !(await this.skills?.load(p, msg.skill))) throw notFound()
    const attachments = msg.fileIds?.length
      ? await this.attach(p, threadId, msg.fileIds)
      : undefined
    const files = attachments && { attachments }
    const limits = await this.runner.limits()
    const res = await this.store.tx(async (w) => {
      const thread = await this.own(w, p, threadId)
      // 自动化开的会话只跑这次运行的那一轮、子智能体的会话只跑分派时的那一轮：不能再发消息（新的一轮、
      // 追加、排队都不行），审批与提问照常
      if (thread.automationRunId !== null || thread.parentThreadId !== null)
        throw new BizError(Err.CONFLICT)
      const turns = w.m.getRepository(AgentTurn)
      const active = await turns.findOne({ where: { threadId, status: ACTIVE_TURN } })
      if (active) {
        if (msg.mode === 'queue')
          await w.append(
            threadId,
            null,
            'user',
            { text: msg.text, ...(msg.skill && { skill: msg.skill }), ...files, mode: 'queue' },
            'pending',
          )
        else
          await w.append(threadId, Number(active.id), 'user', {
            text: msg.text,
            ...files,
            mode: 'steer',
          })
        return { turnId: Number(active.id), first: false, start: false }
      }
      // 上限：并发数是软限制（两个同时到的请求都可能通过），够用；续跑与排队的开始在 TurnQueue 里按用户串行
      if ((await this.queue.busy(p.userId, w.m)) >= limits.userConcurrentTurns)
        throw new BizError(Err.AGENT_LIMIT, {
          reason: String(
            this.i18n.translate('agent.runtime.limit.concurrency', { lang: currentLocale() }),
          ),
        })
      const first = !(await turns.existsBy({ threadId }))
      const turn = await w.createTurn(threadId, p.userId)
      await w.append(threadId, Number(turn.id), 'user', {
        text: msg.text,
        ...(msg.skill && { skill: msg.skill }),
        ...files,
        ...(first && thread.context && { context: thread.context }),
      })
      return { turnId: Number(turn.id), first, start: true }
    })
    if (res.start) await this.queue.kick(res.turnId)
    if (res.first) await this.queue.dropTemporary(p.userId, threadId)
    return { turnId: res.turnId }
  }

  /**
   * 发送前检查附件：会话须是本人的（否则 404），文件须本人可读（否则 404，见 AttachmentSource）；
   * 带图片而会话的模型不识图时 422（页面本已阻止）。只返回元数据存进条目，文件内容在轮次运行时
   * 才按当时的权限读取，不落库。
   */
  private async attach(
    p: Principal,
    threadId: number,
    fileIds: number[],
  ): Promise<AgentAttachment[]> {
    const thread = await this.ds.getRepository(AgentThread).findOneBy({ id: threadId })
    if (!thread || Number(thread.userId) !== p.userId) throw notFound()
    if (!this.attachments) throw notFound()
    const files = await this.attachments.resolve(p, fileIds)
    if (files.some((f) => f.kind === 'image')) {
      const model = await this.providers.resolve(
        thread.providerId === null ? undefined : Number(thread.providerId),
        thread.model ?? undefined,
      )
      if (!model.model.vision) throw new BizError(Err.UNPROCESSABLE)
    }
    return files.map((f) => f.meta)
  }

  /** 中断进行中的轮次：状态置为 cancelled（运行中的模型流随后被中止），未决的审批与提问作废。 */
  async cancel(p: Principal, threadId: number): Promise<void> {
    const ended = await this.store.tx(async (w) => {
      await this.own(w, p, threadId)
      const turn = await w.m
        .getRepository(AgentTurn)
        .findOne({ where: { threadId, status: ACTIVE_TURN } })
      if (!turn) return false
      await w.patchTurn(turn, { status: 'cancelled', endedAt: new Date() })
      await this.runner.expireOpen(w.m, turn, (i, s) => w.update(i, { status: s }))
      return true
    })
    if (ended) await this.queue.startNext(threadId, p.userId)
  }

  /**
   * 手动 `/compact`：把到目前为止的对话压成摘要（用量照常计入）；有进行中的轮次时 409，急停时 503，本人或
   * 本租户今日 token 已用完时 429。上次摘要之后没有新的对话（用户消息或完整回答）时什么也不做：压缩自己
   * 加的条目不算新内容，连按也不会一次次花钱重写同一份摘要。
   */
  async compact(p: Principal, threadId: number): Promise<void> {
    if (await this.runner.paused()) throw new BizError(Err.AGENT_PAUSED)
    const thread = await this.store.tx(async (w) => {
      const t = await this.own(w, p, threadId)
      if (await w.m.getRepository(AgentTurn).existsBy({ threadId, status: ACTIVE_TURN }))
        throw new BizError(Err.CONFLICT)
      return t
    })
    const over = await this.runner.overDaily(p.userId)
    if (over)
      throw new BizError(Err.AGENT_LIMIT, {
        reason: String(
          this.i18n.translate(`agent.runtime.limit.${over}`, { lang: currentLocale() }),
        ),
      })
    const items = this.ds.getRepository(AgentItem)
    const after = MoreThan(thread.summarySeq)
    const fresh = await items.existsBy([
      { threadId, seq: after, kind: 'user', status: IsNull() },
      { threadId, seq: after, kind: 'assistant', status: 'done' },
    ])
    if (!fresh) return
    const last = await items.findOne({
      where: { threadId },
      order: { seq: 'DESC' },
      select: { id: true, seq: true },
    })
    if (!last) return
    const model = await this.providers.resolve(
      thread.providerId === null ? undefined : Number(thread.providerId),
      thread.model ?? undefined,
    )
    await this.runner.compact(thread, last.seq, false, model, null)
  }

  /**
   * 本人确认一个审批：同意（只这一次）、本会话内同意（记住工具 + 目标，“信任本会话”模式下普通同意也
   * 记住）、拒绝（连同备注告诉模型）、取消（结束这一轮）。已处理、被拦或已作废的 409。系统参数
   * `agent.trust_mode` 为 `false` 时什么信任都不记：“本会话内同意”只当这一次同意。记住的目标见
   * `trustKey`；每条信任连同记下它的轮次一起存（撤回那一轮时一并去掉）。
   */
  async decideApproval(
    p: Principal,
    itemId: number,
    body: AgentApprovalDecide,
    source?: 'interactive' | 'batch',
  ): Promise<void> {
    const trustMode = trustModeOn(await this.params.get(AGENT_TRUST_MODE_PARAM))
    const out = await this.decide(p, itemId, 'approval', async (w, item, thread, turn) => {
      const a = item.payload as AgentItemPayloads['approval'] & { internal?: ItemInternal }
      if (a.blocked) throw new BizError(Err.AGENT_APPROVAL_CLOSED)
      const perCall = this.confirmation.required(a)
      if (perCall) {
        // 服务端调用来源与当前预览 token 缺一不可；批量确认和会话信任不代表逐次人工同意。
        if (source !== 'interactive') throw new BizError(Err.AGENT_APPROVAL_CLOSED)
        if (body.decision === 'approve_session') throw new BizError(Err.VALIDATION_FAILED)
        const ref = { threadId: Number(thread.id), turnId: Number(turn.id), callId: a.callId }
        if (!a.perCallConfirmation || !a.internal?.confirmation) {
          const fresh = await this.confirmation.prepare(p, ref, a.tool, a.args)
          await w.update(item, { payload: this.confirmation.renew(a, fresh) }, 'pending')
          return 'stale'
        }
        if (!this.confirmation.currentToken(a, body.confirmationToken))
          throw new BizError(Err.CONFLICT)
        if (body.decision === 'approve') {
          const fresh = await this.confirmation.prepare(
            p,
            ref,
            a.tool,
            a.internal.confirmation.rawArgs,
            a.internal.confirmation,
          )
          if (fresh.digest !== a.internal.confirmation.digest) {
            await w.update(item, { payload: this.confirmation.renew(a, fresh) }, 'pending')
            return 'stale'
          }
        }
      }
      const ok = body.decision === 'approve' || body.decision === 'approve_session'
      await w.update(
        item,
        {
          status: ok ? 'approved' : 'rejected',
          payload: {
            ...a,
            decision: body.decision,
            decidedBy: p.userId,
            decidedAt: new Date().toISOString(),
            ...(body.note && { note: body.note }),
          },
        },
        'pending',
      )
      const remember =
        !perCall &&
        trustMode &&
        (body.decision === 'approve_session' ||
          (body.decision === 'approve' && thread.approvalMode === 'trust'))
      const key = a.internal?.key
      if (remember && key && !isTrusted(thread.trusted, key))
        await w.m
          .getRepository(AgentThread)
          .update(
            { id: thread.id },
            { trusted: [...(thread.trusted ?? []), trustEntry(Number(turn.id), key)].slice(-200) },
          )
      if (body.decision === 'cancel') {
        await w.patchTurn(turn, { status: 'cancelled', endedAt: new Date() })
        await this.runner.expireOpen(w.m, turn, (i, s) => w.update(i, { status: s }))
        return 'ended'
      }
      return 'resume'
    })
    if (out.action === 'stale') throw new BizError(Err.CONFLICT)
    await this.after(out, p.userId)
  }

  /** 本人回答一个提问（选项与补充文字、表单值，或不回答）；已回答或已作废的 409。 */
  async answerQuestion(p: Principal, itemId: number, body: AgentQuestionAnswer): Promise<void> {
    const out = await this.decide(p, itemId, 'question', async (w, item) => {
      const q = item.payload as { form?: unknown; internal?: ItemInternal }
      const internal: ItemInternal = {
        ...q.internal,
        ...(body.decline && { declined: true }),
        ...(body.form && { form: body.form }),
      }
      await w.update(
        item,
        {
          status: 'answered',
          payload: { ...q, answers: body.decline ? [] : body.answers, internal },
        },
        'pending',
      )
      // 外部服务器的表单由仍在执行的那次调用等着取，不另起任务（那次运行若已中断，重启后表单已作废，回答 409）
      return q.form ? 'none' : 'resume'
    })
    await this.after(out, p.userId)
  }

  /**
   * 审批与提问的共同部分：在会话行锁里取本人会话的、仍在等待的那个条目（轮次也须在等），交给 `apply`
   * 记下决定；没有别的待处理卡片时返回要续跑的轮次（续跑受并发上限约束，见 {@link after}）。
   *
   * 会话 id 在事务之外先查出来，事务的第一条语句就是会话行锁：MySQL 可重复读隔离下，事务的快照在第一次
   * 普通读时建立，先普通读再加锁的话，锁内“重读”看到的仍是加锁前的旧快照，两个同时到的决定会互相覆盖。
   * 写决定时还要求条目仍是 pending（{@link StaleItem}），作为第二道保险。
   */
  private async decide(
    p: Principal,
    itemId: number,
    kind: 'approval' | 'question',
    apply: (
      w: ItemWriter,
      item: AgentItem,
      thread: AgentThread,
      turn: AgentTurn,
    ) => Promise<'resume' | 'ended' | 'none' | 'stale'>,
  ): Promise<{ action: 'resume' | 'ended' | 'none' | 'stale'; turnId: number; threadId: number }> {
    const found = await this.ds
      .getRepository(AgentItem)
      .findOne({ where: { id: itemId }, select: { id: true, threadId: true, kind: true } })
    if (!found || found.kind !== kind) throw notFound()
    const threadId = Number(found.threadId)
    return this.store.tx(async (w) => {
      const thread = await this.own(w, p, threadId)
      // 锁住会话之后才读条目：别的请求可能刚处理过
      const item = await w.m.getRepository(AgentItem).findOneBy({ id: itemId })
      if (!item || Number(item.threadId) !== threadId) throw notFound()
      const turn =
        item.turnId === null
          ? null
          : await w.m.getRepository(AgentTurn).findOneBy({ id: item.turnId })
      if (item.status !== 'pending' || !turn || turn.status !== 'waiting')
        throw new BizError(Err.AGENT_APPROVAL_CLOSED)
      const action = await apply(w, item, thread, turn).catch((e: unknown) => {
        throw e instanceof StaleItem ? new BizError(Err.AGENT_APPROVAL_CLOSED) : e
      })
      if (action === 'resume') {
        const open = await w.m.getRepository(AgentItem).find({
          where: [
            { turnId: turn.id, kind: 'approval', status: 'pending' },
            { turnId: turn.id, kind: 'question', status: 'pending' },
          ],
          select: { id: true },
        })
        if (open.length) return { action: 'none' as const, turnId: Number(turn.id), threadId }
      }
      return { action, turnId: Number(turn.id), threadId }
    })
  }

  /**
   * 决定之后：续跑这一轮（本人有空名额才置为 running 并入队，否则等名额空出来，见 TurnQueue.resume），
   * 或在它结束时开始排队的下一条。
   */
  private async after(
    out: { action: 'resume' | 'ended' | 'none' | 'stale'; turnId: number; threadId: number },
    userId: number,
  ) {
    if (out.action === 'resume') await this.queue.resume(out.turnId, userId)
    else if (out.action === 'ended') await this.queue.startNext(out.threadId, userId)
  }
}
