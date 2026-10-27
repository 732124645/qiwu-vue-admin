import { createHash } from 'node:crypto'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  AGENT2_PARAMS,
  type AgentApprovalDecide,
  type AgentItemPayloads,
  type AgentAttachment,
  type AgentMessageSend,
  type AgentPlanDecide,
  type AgentPlanProposal,
  type AgentQuestionAnswer,
  Err,
} from '@qiwu/shared'
import { I18nService } from 'nestjs-i18n'
import { type DataSource, In, IsNull, MoreThan } from 'typeorm'
import type { Principal } from '../../auth/principal.js'
import { BizError } from '../../http/biz-error.js'
import { canonicalJson } from '../../guard/idempotent.js'
import { currentLocale } from '../../i18n/locale.js'
import { ParamService } from '../../settings/param.service.js'
import { ProviderRegistry } from '../provider/provider-registry.js'
import {
  ATTACHMENT_SOURCE,
  type AttachmentSource,
  SKILL_SOURCE,
  type SkillSource,
  type TurnControl,
} from '../agent-ports.js'
import {
  AgentItem,
  AgentMessageReceipt,
  AgentThread,
  AgentTurn,
} from '../entities/agent-thread.entity.js'
import { type ItemInternal, ItemStore, type ItemWriter, StaleItem } from './item-store.js'
import { ACTIVE_TURN, TurnQueue } from './turn-queue.js'
import { TurnRunner } from './turn-runner.js'
import { allowEntry, isAllowed } from './turn-tools.js'
import { HumanConfirmation } from './human-confirmation.js'
import { parseReviewModel } from './auto-reviewer.js'

const notFound = () => new BizError(Err.NOT_FOUND)
type AcceptedMessage = { turnId: number; first: boolean; start: boolean; resume?: boolean }
type QuestionPayload = AgentItemPayloads['question'] & { internal?: ItemInternal }

/**
 * 批准后开始执行的那一轮的第一条消息（运行时写的用户角色消息）：方案原文是模型自己早先写的，标明是“已批准
 * 的方案”，并说明此刻的模式，让模型按它执行、用 plan.update 报告进度。
 */
export function approvedPlanText(plan: AgentPlanProposal, mode: 'ask' | 'auto_review'): string {
  const how =
    mode === 'auto_review'
      ? 'each change is first checked by the automatic review'
      : 'each change waits for the user’s approval'
  return [
    `[The user approved the plan below and switched the conversation to execution (${how}). Carry it ` +
      'out now step by step and keep the checklist current with plan.update (one step doing at a time).]',
    '',
    'The approved plan:',
    `Title: ${plan.title}`,
    `Summary: ${plan.summary}`,
    'Steps:',
    ...plan.steps.map((st, k) => `${k + 1}. ${st}`),
    ...(plan.changes ? [`Expected changes: ${plan.changes}`] : []),
    ...(plan.assumptions?.length ? ['Assumptions:', ...plan.assumptions.map((a) => `- ${a}`)] : []),
  ].join('\n')
}

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
    private readonly i18n: I18nService,
    private readonly params: ParamService,
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
   * `mode` 追加到当前轮（下一步起模型就能看到）或排队到下一轮。本轮正停在审批卡上时，发消息等于“拒绝并
   * 附这条说明”（见 {@link rejectWaiting}）。会话的第一轮开始时，本人的其他临时会话被删掉（“开始新对话”）。
   */
  async send(p: Principal, threadId: number, msg: AgentMessageSend): Promise<{ turnId: number }> {
    // 进入其他租户的平台人员不经智能体操作那个租户：轮次以会话所有人的身份在会话的租户里执行
    if (p.actingTenantId !== undefined && p.actingTenantId !== p.tenantId)
      throw new BizError(Err.FORBIDDEN)
    const requestHash = createHash('sha256')
      .update(
        canonicalJson({
          threadId,
          text: msg.text,
          skill: msg.skill ?? null,
          fileIds: msg.fileIds ?? [],
          mode: msg.mode ?? 'steer',
        }),
      )
      .digest('hex')
    // 查证已接受的请求不重新校验附件、配置或启动轮次，权限变化也不能让同一发送变成第二次执行。
    const prior = msg.clientMessageId
      ? await this.store.tx(async (w) => {
          await this.own(w, p, threadId)
          return this.accepted(w, p, threadId, msg.clientMessageId!, requestHash)
        })
      : null
    if (prior) return { turnId: prior.turnId }
    if (await this.runner.paused()) throw new BizError(Err.AGENT_PAUSED)
    if (msg.skill && !(await this.skills?.load(p, msg.skill))) throw notFound()
    const attachments = msg.fileIds?.length
      ? await this.attach(p, threadId, msg.fileIds)
      : undefined
    const files = attachments && { attachments }
    const limits = await this.runner.limits()
    const accept = () =>
      this.store.tx(async (w): Promise<AcceptedMessage> => {
        const thread = await this.own(w, p, threadId)
        if (msg.clientMessageId) {
          const duplicate = await this.accepted(w, p, threadId, msg.clientMessageId, requestHash)
          if (duplicate) return duplicate
        }
        const record = async (item: AgentItem, turnId: number, first: boolean, start: boolean) => {
          if (msg.clientMessageId)
            await w.m.getRepository(AgentMessageReceipt).save({
              userId: p.userId,
              threadId,
              clientMessageId: msg.clientMessageId,
              requestHash,
              itemId: Number(item.id),
              acceptedTurnId: turnId,
            })
          return { turnId, first, start }
        }
        // 自动化开的会话只跑这次运行的那一轮、子智能体的会话只跑分派时的那一轮：不能再发消息（新的一轮、
        // 追加、排队都不行），审批与提问照常
        if (thread.automationRunId !== null || thread.parentThreadId !== null)
          throw new BizError(Err.CONFLICT)
        const turns = w.m.getRepository(AgentTurn)
        const active = await turns.findOne({ where: { threadId, status: ACTIVE_TURN } })
        if (active) {
          const rejected = await this.rejectWaiting(w, p, thread, active, msg.text)
          if (rejected) {
            const item = await w.append(threadId, Number(active.id), 'user', {
              text: msg.text,
              ...files,
              mode: 'steer',
            })
            const res = await record(item, Number(active.id), false, false)
            return { ...res, resume: rejected === 'resume' }
          }
          let item: AgentItem
          if (msg.mode === 'queue')
            item = await w.append(
              threadId,
              null,
              'user',
              { text: msg.text, ...(msg.skill && { skill: msg.skill }), ...files, mode: 'queue' },
              'pending',
            )
          else
            item = await w.append(threadId, Number(active.id), 'user', {
              text: msg.text,
              ...files,
              mode: 'steer',
            })
          return record(item, Number(active.id), false, false)
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
        const item = await w.append(threadId, Number(turn.id), 'user', {
          text: msg.text,
          ...(msg.skill && { skill: msg.skill }),
          ...files,
          ...(first && thread.context && { context: thread.context }),
        })
        return record(item, Number(turn.id), first, true)
      })
    let res: AcceptedMessage
    try {
      res = await accept()
    } catch (error) {
      // 同一用户误把同一 UUID 发到两个线程时，永久唯一键仍是最后防线；失败事务不留轮次或条目。
      const duplicate = msg.clientMessageId
        ? await this.store.tx(async (w) => {
            await this.own(w, p, threadId)
            return this.accepted(w, p, threadId, msg.clientMessageId!, requestHash)
          })
        : null
      if (!duplicate) throw error
      res = duplicate
    }
    if (res.start) await this.queue.kick(res.turnId)
    if (res.resume) await this.queue.resume(res.turnId, p.userId)
    if (res.first) await this.queue.dropTemporary(p.userId, threadId)
    return { turnId: res.turnId }
  }

  /**
   * 本轮停在审批卡上时用户又发了消息（追加或排队都一样）：把这一轮所有待定的审批卡——包括须本人逐次确认
   * 的——记为本人拒绝，备注就是这条消息；同一步里还没轮到出卡、要问人的调用（它们是在这句纠正之前计划的）也
   * 各记一张已拒绝的卡，不再一张张弹出来。调用方再把消息并入本轮。模型看到每个写入都被拒绝与这条消息，
   * 按新的说法继续。批量任务开的会话照旧（卡片由批量确认处理），没有待定审批卡时什么也不做
   * （null）。还有待回答的提问时不替用户作答，等它答完再续跑（`rejected`），否则立即续跑（`resume`）。
   */
  private async rejectWaiting(
    w: ItemWriter,
    p: Principal,
    thread: AgentThread,
    turn: AgentTurn,
    text: string,
  ): Promise<'resume' | 'rejected' | null> {
    if (turn.status !== 'waiting' || thread.batchId !== null) return null
    const items = w.m.getRepository(AgentItem)
    const cards = await items.findBy({ turnId: turn.id, kind: 'approval', status: 'pending' })
    const proposals = (
      await items.findBy({ turnId: turn.id, kind: 'question', status: 'pending' })
    ).filter((q) => (q.payload as QuestionPayload).proposal)
    if (!cards.length && !proposals.length) return null
    // 等方案卡时发消息等于“继续完善”并以这条消息为意见：模式不变，消息由调用方并入本轮
    for (const q of proposals)
      await w.update(
        q,
        {
          status: 'answered',
          payload: {
            ...(q.payload as QuestionPayload),
            choice: {
              decision: 'refine',
              decidedBy: p.userId,
              decidedAt: new Date().toISOString(),
              feedback: text.slice(0, 2000),
            },
          },
        },
        'pending',
      )
    const decision = {
      decision: 'reject' as const,
      decidedBy: p.userId,
      decidedAt: new Date().toISOString(),
      note: text.slice(0, 500),
    }
    for (const c of cards)
      await w.update(
        c,
        {
          status: 'rejected',
          payload: { ...(c.payload as AgentItemPayloads['approval']), ...decision },
        },
        'pending',
      )
    // 同一步里还没处理到、会停下问人的调用（写入，或 root 设成 ask 的读取）：没有结果、也还没有审批卡的
    // （只有当前这一步会有未处理的调用）
    const handled = new Set(
      (await items.find({ where: { turnId: turn.id, kind: In(['approval', 'tool_result']) } })).map(
        (i) => (i.payload as { callId?: string }).callId,
      ),
    )
    const later = await items.find({
      where: { turnId: turn.id, kind: 'tool_call', status: 'pending' },
      order: { seq: 'ASC' },
    })
    for (const c of later) {
      const call = c.payload as AgentItemPayloads['tool_call']
      if (handled.has(call.callId) || (await this.runner.runsWithoutAsking(call))) continue
      await w.append(
        Number(thread.id),
        Number(turn.id),
        'approval',
        {
          callId: call.callId,
          tool: call.tool,
          title: call.title,
          args: call.args,
          sources: [],
          ...decision,
        },
        'rejected',
      )
    }
    const asking = await items.existsBy({ turnId: turn.id, kind: 'question', status: 'pending' })
    return asking ? 'rejected' : 'resume'
  }

  /** 同一持久标识只回报原接受结果；异载荷或已撤回的消息拒绝复用，不复活业务效果。 */
  private async accepted(
    w: ItemWriter,
    p: Principal,
    threadId: number,
    clientMessageId: string,
    requestHash: string,
  ): Promise<AcceptedMessage | null> {
    const receipt = await w.m.getRepository(AgentMessageReceipt).findOne({
      where: { userId: p.userId, clientMessageId },
      withDeleted: true,
    })
    if (!receipt) return null
    if (Number(receipt.threadId) !== threadId || receipt.requestHash !== requestHash)
      throw new BizError(Err.CONFLICT)
    const item = await w.m
      .getRepository(AgentItem)
      .existsBy({ id: Number(receipt.itemId), threadId })
    const turn = await w.m
      .getRepository(AgentTurn)
      .existsBy({ id: Number(receipt.acceptedTurnId), threadId })
    if (!item || !turn) throw new BizError(Err.CONFLICT)
    return { turnId: Number(receipt.acceptedTurnId), first: false, start: false }
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
   * 本人确认一个审批：同意（只这一次）、同意并“本会话内此工具不再询问”（记住工具名）、拒绝（连同备注告诉
   * 模型）、取消（结束这一轮）。已处理、被拦或已作废的 409。只有卡片提供了放行（`sessionAllow`，运行时只给
   * 策略为 `ask`、不须本人逐次确认的本系统工具）时才能选“不再询问”，否则 400：会话放行不能代替本人对单次
   * 调用的确认。记下之前按工具此刻的策略再核对，已不可放行的只同意这一次。每条放行连同记下它的轮次一起存（撤回那一轮时一并去掉）。
   */
  async decideApproval(
    p: Principal,
    itemId: number,
    body: AgentApprovalDecide,
    source?: 'interactive' | 'batch',
  ): Promise<void> {
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
      if (body.decision === 'approve_session' && a.sessionAllow !== true)
        throw new BizError(Err.VALIDATION_FAILED)
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
      // 卡片出来之后 root 可能已改了这个工具的策略：此刻不再可放行的只同意这一次，不记放行
      if (
        body.decision === 'approve_session' &&
        !perCall &&
        !isAllowed(thread.trusted, a.tool) &&
        (await this.runner.sessionAllowableNow(a.tool))
      )
        await w.m.getRepository(AgentThread).update(
          { id: thread.id },
          {
            trusted: [...(thread.trusted ?? []), allowEntry(Number(turn.id), a.tool)].slice(-200),
          },
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

  /** 本人回答一个提问（选项与补充文字、表单值，或不回答）；已回答或已作废的 409，方案卡 400（另有接口）。 */
  async answerQuestion(p: Principal, itemId: number, body: AgentQuestionAnswer): Promise<void> {
    const out = await this.decide(p, itemId, 'question', async (w, item) => {
      const q = item.payload as QuestionPayload
      // 方案卡的“批准”会切换模式：只能走 decidePlan，不能当成普通回答续跑
      if (q.proposal) throw new BizError(Err.VALIDATION_FAILED)
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
   * 本人对方案卡的选择。继续完善：卡片记下选择与意见，意见作为一条用户消息并入本轮，本轮接着在计划模式里
   * 规划。批准：卡片记下选择，`plan.propose` 这次调用记为已批准，规划的这一轮结束（同一步里别的待定卡片与
   * 调用作废），会话切到所选模式（`auto_review` 要平台此刻提供自动审查，否则 400），再开新的一轮，第一条
   * 消息是运行时写的已批准方案（{@link approvedPlanText}）。新一轮先置为等名额，由 TurnQueue 按并发上限启动。
   * 模型自己没有任何途径做这件事：只有本人在这里（或用模式选择器）才能离开计划模式。不是方案卡的提问 404。
   */
  async decidePlan(p: Principal, itemId: number, body: AgentPlanDecide): Promise<void> {
    // 急停时与发送一样先拒绝，不改任何状态：解除后这张方案卡还能原样再批准
    if (await this.runner.paused()) throw new BizError(Err.AGENT_PAUSED)
    if (
      body.decision === 'auto_review' &&
      !parseReviewModel(await this.params.get(AGENT2_PARAMS.reviewModel))
    )
      throw new BizError(Err.VALIDATION_FAILED)
    let next = 0
    const out = await this.decide(p, itemId, 'question', async (w, item, thread, turn) => {
      const q = item.payload as QuestionPayload
      if (!q.proposal) throw notFound()
      const threadId = Number(thread.id)
      const feedback = body.feedback || undefined
      await w.update(
        item,
        {
          status: 'answered',
          payload: {
            ...q,
            choice: {
              decision: body.decision,
              decidedBy: p.userId,
              decidedAt: new Date().toISOString(),
              ...(feedback && { feedback }),
            },
          },
        },
        'pending',
      )
      if (body.decision === 'refine') {
        if (feedback)
          await w.append(threadId, Number(turn.id), 'user', { text: feedback, mode: 'steer' })
        return 'resume'
      }
      const items = w.m.getRepository(AgentItem)
      const call = (
        await items.findBy({ turnId: turn.id, kind: 'tool_call', status: 'pending' })
      ).find((c) => (c.payload as { callId?: string }).callId === q.callId)
      const content = 'The user approved this plan; it runs in a new turn.'
      await w.append(threadId, Number(turn.id), 'tool_result', {
        callId: q.callId,
        ok: true,
        preview: content,
        untrusted: false,
        internal: { content },
      })
      if (call) await w.update(call, { status: 'done' })
      await w.patchTurn(turn, { status: 'completed', endedAt: new Date() })
      await this.runner.expireOpen(w.m, turn, (i, s) => w.update(i, { status: s }))
      // 规划这一轮的第一条用户消息：方案轮不经 complete() 结束，标题按同样的规则在这里起；它选的技能
      // （及预先同意时记下的技能 id 与范围）带到执行轮的第一条消息上，技能的说明、工具清单与研究限额照旧生效
      const planFirst = await items.findOne({
        where: { turnId: turn.id, kind: 'user' },
        order: { seq: 'ASC' },
      })
      const asked = planFirst?.payload as
        | ({ text: string; skill?: string; fromPlan?: number } & { internal?: ItemInternal })
        | undefined
      if (asked && !asked.fromPlan) await this.runner.nameUntitled(w.m, thread, asked.text)
      const skillRef = asked?.internal?.skillRef
      await w.m
        .getRepository(AgentThread)
        .update({ id: thread.id }, { approvalMode: body.decision })
      const run = await w.createTurn(threadId, p.userId)
      await w.patchTurn(run, { status: 'waiting' })
      await w.append(threadId, Number(run.id), 'user', {
        text: approvedPlanText(q.proposal, body.decision),
        fromPlan: Number(item.id),
        ...(asked?.skill && { skill: asked.skill }),
        ...(skillRef && { internal: { skillRef } }),
      })
      next = Number(run.id)
      return 'none'
    })
    if (next) await this.queue.resume(next, p.userId)
    else await this.after(out, p.userId)
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
