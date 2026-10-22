import { Inject, Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  type AgentBatchCreate,
  type AgentBatchDetailVo,
  type AgentBatchVo,
  type AgentTurnStatus,
  Err,
} from '@qiwu/shared'
import { I18nService } from 'nestjs-i18n'
import { type DataSource, In, IsNull } from 'typeorm'
import type { Principal } from '../../auth/principal.js'
import { BizError } from '../../http/biz-error.js'
import { currentLocale } from '../../i18n/locale.js'
import { SKILL_SOURCE, type SkillSource, TURN_CONTROL, type TurnControl } from '../agent-ports.js'
import { AgentBatch, AgentItem, AgentThread, AgentTurn } from '../entities/agent-thread.entity.js'
import { ProviderRegistry } from '../provider/provider-registry.js'
import { itemVo, ItemStore } from '../runtime/item-store.js'
import { TurnQueue } from '../runtime/turn-queue.js'
import { TurnRunner } from '../runtime/turn-runner.js'
import { AgentBatchTargets } from './batch-targets.js'

const notFound = () => new BizError(Err.NOT_FOUND)
const ENDED: AgentTurnStatus[] = ['completed', 'failed', 'cancelled']

/** `demo.customer:12` → 12. */
const targetIdOf = (ref: string | null) => Number(ref?.slice(ref.lastIndexOf(':') + 1) ?? 0)

/**
 * 一个审批能不能在批次页一次确认：工具须是批量目标登记的写入工具之一（`tools`），参数里的 `id` 等于这一行
 * 的记录 id，并且有改动预览、预览目标末尾的 `(#id)` 也是它。别的工具（包括外部工具）、没有预览的、认不出
 * 目标的一律不算（留给人逐条确认）：记录内容可能带着提示注入，让模型调用别的写入工具，参数里照样填上这一行
 * 的 id。
 */
export function onOwnRecord(payload: unknown, targetId: number, tools: readonly string[]): boolean {
  if (!targetId || !payload || typeof payload !== 'object') return false
  const a = payload as { tool?: unknown; args?: unknown; changes?: { target?: unknown } }
  if (typeof a.tool !== 'string' || !tools.includes(a.tool)) return false
  const argId = a.args && typeof a.args === 'object' ? (a.args as { id?: unknown }).id : undefined
  if (argId !== targetId || !a.changes) return false
  const m = /\(#(\d+)\)\s*$/.exec(String(a.changes.target ?? ''))
  return m !== null && Number(m[1]) === targetId
}

export function batchVo(b: AgentBatch): AgentBatchVo {
  return {
    id: Number(b.id),
    skill: b.skillName,
    target: b.target,
    status: b.status,
    total: b.total,
    finished: b.finished,
    failed: b.failed,
    createdAt: new Date(b.createdAt).toISOString(),
  }
}

/**
 * 批量执行（see docs/agent.md）：对列表里选中的记录逐条跑同一个技能，每条一个会话、一轮。
 *
 * 并发：建批次时每个会话只放一条“排队”的用户消息（status pending、没有轮次，和对话页的 queue 消息同一
 * 形状），由 {@link pump} 按发起人的并发上限（`agent.limit.user_concurrent_turns`，只数 running 的轮次）
 * 把它们逐个变成轮次（`TurnQueue.startQueued`，在会话行锁里判断，同一行不会开两轮）。发起人的任何一轮
 * 结束或停下等人时（`TurnQueue.onReleased`），再补上空出来的名额，直到整批都开始。等审批的行不占名额，
 * 所以整批会逐条停在审批上，在批次页一次确认。
 */
@Injectable()
export class AgentBatchService implements OnModuleInit {
  private readonly logger = new Logger(AgentBatchService.name)

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly store: ItemStore,
    private readonly queue: TurnQueue,
    private readonly runner: TurnRunner,
    private readonly providers: ProviderRegistry,
    private readonly targets: AgentBatchTargets,
    private readonly i18n: I18nService,
    @Inject(TURN_CONTROL) private readonly control: TurnControl,
    @Optional() @Inject(SKILL_SOURCE) private readonly skills?: SkillSource,
  ) {}

  /** 发起人的一轮让出名额时补开排队的行。 */
  onModuleInit(): void {
    this.queue.onReleased((userId) => this.pump(userId))
  }

  /**
   * 建批次：目标类型须已登记（否则 422），本人须有读这些记录的权限点（否则 403），技能须对本人可用、
   * 每个 id 都须在本人的数据范围内（否则 404，不泄露是否存在）；每条记录一个会话（标题“技能: 记录名”），放入一条带技能的排队消息，然后按并发上限
   * 开始。急停时 503，进入其他租户的平台人员 403（同发消息）。
   */
  async create(p: Principal, dto: AgentBatchCreate): Promise<AgentBatchVo> {
    if (p.actingTenantId !== undefined && p.actingTenantId !== p.tenantId)
      throw new BizError(Err.FORBIDDEN)
    if (await this.runner.paused()) throw new BizError(Err.AGENT_PAUSED)
    const target = this.targets.get(dto.target)
    if (!target) throw new BizError(Err.UNPROCESSABLE)
    // 读不了这些记录的人不能建批次（否则能按 id 试出记录名）
    if (p.root !== true && !p.perms.includes(target.perm)) throw new BizError(Err.FORBIDDEN)
    if (!(await this.skills?.load(p, dto.skill))) throw notFound()
    const ids = [...new Set(dto.ids)]
    const labels = await this.targets.labels(target, ids)
    if (ids.some((id) => !labels.has(id))) throw notFound()
    const model = await this.providers.resolve()
    const lang = currentLocale()
    const batch = await this.store.tx(async (w) => {
      const repo = w.m.getRepository(AgentBatch)
      const b = await repo.save(
        repo.create({
          userId: p.userId,
          skillName: dto.skill,
          target: dto.target,
          status: 'running',
          total: ids.length,
          finished: 0,
          failed: 0,
        }),
      )
      const threads = w.m.getRepository(AgentThread)
      for (const id of ids) {
        const label = labels.get(id)!
        const t = await threads.save(
          threads.create({
            userId: p.userId,
            title: `${dto.skill}: ${label}`.slice(0, 200),
            status: 'active',
            providerId: model.providerId,
            model: model.model.id,
            reasoning: null,
            approvalMode: 'ask',
            planMode: false,
            pinned: false,
            temporary: false,
            readSeq: 0,
            trusted: null,
            forkedFromId: null,
            batchId: Number(b.id),
            targetRef: `${dto.target}:${id}`,
            context: null,
            summary: null,
            summarySeq: 0,
            lastActiveAt: new Date(),
          }),
        )
        const text = String(
          this.i18n.translate('agent.thread.batchMessage', {
            lang,
            args: { label, target: dto.target, id },
          }),
        )
        await w.append(Number(t.id), null, 'user', { text, skill: dto.skill }, 'pending')
      }
      return b
    })
    await this.pump(p.userId)
    return batchVo(await this.ds.getRepository(AgentBatch).findOneByOrFail({ id: batch.id }))
  }

  /** 本人的批次；别人的、别的租户的、不存在的 404。 */
  private async own(p: Principal, id: number): Promise<AgentBatch> {
    const b = await this.ds.getRepository(AgentBatch).findOneBy({ id, userId: p.userId })
    if (!b) throw notFound()
    return b
  }

  /** 批次的会话（按记录顺序）。 */
  private rowsOf(b: AgentBatch): Promise<AgentThread[]> {
    return this.ds
      .getRepository(AgentThread)
      .find({ where: { batchId: b.id, userId: b.userId }, order: { id: 'ASC' } })
  }

  /** 每个会话最新一轮的状态。 */
  private async latestTurns(threadIds: number[]): Promise<Map<number, AgentTurnStatus>> {
    const out = new Map<number, AgentTurnStatus>()
    if (!threadIds.length) return out
    const turns = await this.ds.getRepository(AgentTurn).find({
      where: { threadId: In(threadIds) },
      order: { id: 'ASC' },
      select: { id: true, threadId: true, status: true },
    })
    for (const t of turns) out.set(Number(t.threadId), t.status)
    return out
  }

  /**
   * 按各行最新一轮重算计数：完成的计 finished，失败与中断的计 failed，会话已被删掉的也算 failed；
   * 全部结束时批次置为 completed。有变化才写库。
   */
  private async refresh(
    b: AgentBatch,
    rows: AgentThread[],
    status: Map<number, AgentTurnStatus>,
  ): Promise<void> {
    if (b.status !== 'running') return
    let finished = 0
    let failed = b.total - rows.length
    for (const r of rows) {
      const s = status.get(Number(r.id))
      if (s === 'completed') finished++
      else if (s && ENDED.includes(s)) failed++
    }
    const next = {
      finished,
      failed,
      status: finished + failed >= b.total ? ('completed' as const) : b.status,
    }
    if (next.finished === b.finished && next.failed === b.failed && next.status === b.status) return
    await this.ds.getRepository(AgentBatch).update({ id: b.id }, next)
    Object.assign(b, next)
  }

  /**
   * 批次页：每行的记录名、会话、最新一轮的状态与等待中的审批。记录名此刻从目标登记处现取（同样的数据
   * 权限）：记录已删除或已不在本人的数据范围内时只显示 `#id`，不再露出名字。
   */
  async detail(p: Principal, id: number): Promise<AgentBatchDetailVo> {
    const b = await this.own(p, id)
    const rows = await this.rowsOf(b)
    const ids = rows.map((r) => Number(r.id))
    const status = await this.latestTurns(ids)
    await this.refresh(b, rows, status)
    const pending = ids.length
      ? await this.ds.getRepository(AgentItem).find({
          where: { threadId: In(ids), kind: 'approval', status: 'pending' },
          order: { seq: 'ASC' },
        })
      : []
    const target = this.targets.get(b.target)
    const labels =
      target && rows.length
        ? await this.targets.labels(
            target,
            rows.map((r) => targetIdOf(r.targetRef)),
          )
        : new Map<number, string>()
    return {
      batch: batchVo(b),
      rows: rows.map((r) => ({
        targetId: targetIdOf(r.targetRef),
        label: labels.get(targetIdOf(r.targetRef)) ?? `#${targetIdOf(r.targetRef)}`,
        threadId: Number(r.id),
        turnStatus: status.get(Number(r.id)) ?? null,
        pending: pending
          .filter((i) => Number(i.threadId) === Number(r.id))
          .map((i) => itemVo(i) as AgentBatchDetailVo['rows'][number]['pending'][number]),
      })),
    }
  }

  /**
   * 一次确认或拒绝批次里所有等待中的审批：每个都经 `TurnControl.decideApproval`（同对话页的审批卡，
   * 只有本人；被拦下的与刚被别处处理掉的跳过）。只批量处理批量目标登记的工具、写的正是这一行自己那条
   * 记录的审批（{@link onOwnRecord}）：记录内容可能带着提示注入，让模型在 A 的行里去改 B，或者调用别的
   * 写入工具，这样的审批留着等人逐条看，计入 `skipped`。返回实际处理与留下的个数。
   */
  async decide(
    p: Principal,
    id: number,
    decision: 'approve' | 'reject',
  ): Promise<{ decided: number; skipped: number }> {
    const b = await this.own(p, id)
    const rows = await this.rowsOf(b)
    if (!rows.length) return { decided: 0, skipped: 0 }
    const targetOf = new Map(rows.map((r) => [Number(r.id), targetIdOf(r.targetRef)]))
    const tools = this.targets.get(b.target)?.tools ?? []
    const pending = await this.ds.getRepository(AgentItem).find({
      where: { threadId: In([...targetOf.keys()]), kind: 'approval', status: 'pending' },
      order: { id: 'ASC' },
      select: { id: true, threadId: true, payload: true },
    })
    let decided = 0
    let skipped = 0
    for (const item of pending) {
      if (
        (item.payload as { perCallConfirmation?: boolean }).perCallConfirmation ||
        !onOwnRecord(item.payload, targetOf.get(Number(item.threadId)) ?? 0, tools)
      ) {
        skipped++
        continue
      }
      try {
        await this.control.decideApproval(p, Number(item.id), { decision }, 'batch')
        decided++
      } catch (e) {
        if (!(e instanceof BizError && e.err === Err.AGENT_APPROVAL_CLOSED)) throw e
      }
    }
    return { decided, skipped }
  }

  /**
   * 按并发上限开始本人进行中批次里还在排队的行（名额判断在 TurnQueue 里按用户串行，第一次报名额已满就
   * 停下），并刷新这些批次的计数。
   */
  async pump(userId: number): Promise<void> {
    try {
      const batches = await this.ds
        .getRepository(AgentBatch)
        .find({ where: { userId, status: 'running' }, order: { id: 'ASC' } })
      if (!batches.length) return
      for (const b of batches) {
        const rows = await this.rowsOf(b)
        const ids = rows.map((r) => Number(r.id))
        const queued = ids.length
          ? await this.ds.getRepository(AgentItem).find({
              where: {
                threadId: In(ids),
                kind: 'user',
                status: 'pending',
                turnId: IsNull(),
              },
              order: { threadId: 'ASC' },
              select: { id: true, threadId: true },
            })
          : []
        for (const q of queued)
          if ((await this.queue.startQueued(Number(q.threadId))) === 'full') return
        await this.refresh(b, rows, await this.latestTurns(ids))
      }
    } catch (e) {
      this.logger.error(e, 'agent batch pump failed')
    }
  }
}
