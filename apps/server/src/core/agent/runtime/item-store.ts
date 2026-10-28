import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  type AGENT_ITEM_STATUSES,
  type AgentEvent,
  type AgentItemKind,
  type AgentItemPayloads,
  type AgentItemVo,
  type AgentTurnVo,
  RT,
} from '@qiwu/shared'
import { type DataSource, type EntityManager, LessThan } from 'typeorm'
import { RealtimeService } from '../../realtime/realtime.service.js'
import type { AgentSkillRef } from '../agent-ports.js'
import { AgentItem, AgentThread, AgentTurn } from '../entities/agent-thread.entity.js'

/** The thread was deleted while something still wrote to it (a running turn stops quietly). */
export class ThreadGone extends Error {
  override name = 'ThreadGone'
}

/** A conditional item write found the item no longer in the expected status (someone else decided it). */
export class StaleItem extends Error {
  override name = 'StaleItem'
}

export type AgentItemStatus = (typeof AGENT_ITEM_STATUSES)[number]

/**
 * What the runtime keeps in an item's payload for itself (the model's full tool output, the sources and
 * readable URLs a web call brought, an elicitation's form values): stripped by
 * {@link itemVo}, never sent to the page.
 */
export interface ItemInternal {
  /** the full (capped) tool output the model got; `preview` is what the page shows */
  content?: string
  /** 该调用结果不明已持久登记，避免重复提高核对版本。 */
  uncertain?: boolean
  sources?: { title: string; url: string }[]
  /**
   * URLs a `web.search` returned (or a subagent read or found): readable by `web.fetch` for the rest of the
   * turn; on a subagent's task message, the parent turn's readable URLs, the only ones its thread starts with
   */
  urls?: string[]
  /** 本次预览绑定及单次消耗标记，只留在服务端，不进入模型或公开条目。 */
  confirmation?: {
    digest: string
    token: string
    rawArgs: unknown
    args: unknown
    schema: string
    revision: string
    consumedAt?: string
  }
  /** the raw arguments text the model wrote, when it was no valid JSON */
  raw?: string
  /** an elicitation form's values, or that the owner declined */
  form?: Record<string, unknown>
  declined?: boolean
  /** the sources are pages the agent read (`web.fetch`), not search hits */
  read?: boolean
  /**
   * the reasoning text the provider streamed in this step, kept on the step's answer (or, for a step
   * without text, its first tool call): reasoning models that need it sent back get it again
   */
  reasoning?: string
  /** the model that produced `reasoning`: it is sent back only to that same model */
  reasoningModel?: string
  /** the input tokens the provider reported for this step (on the same item as `reasoning`) */
  promptTokens?: number
  /**
   * `<callId>#<n>`: the n-th item a built-in tool call added; a repeated call (restart, lost lock) replaces it
   * instead of adding another
   */
  byCall?: string
  /** a subagent's task message: the tools its thread may use (the parent's at the delegation) */
  tools?: string[]
  /**
   * an automation run's message under a pre-approval: the skill it was saved with, by id and scope (the turn
   * loads that one, never another of the same name)
   */
  skillRef?: AgentSkillRef
  /**
   * an event automation's message: where the event line (domain, verb, record id) starts in its text; the
   * line is data about the event, not the owner's words (the automatic review leaves it out)
   */
  eventFrom?: number
}

/**
 * 这条用户消息是不是原样照抄了它之前最近一条完整回答里的某个后续建议（点了建议发出的）：建议是模型写的，
 * 可能被网页等外部内容带偏，里面的话与链接都不能当成用户本人给的。
 */
export async function copiesSuggestion(
  m: EntityManager,
  threadId: number,
  u: Pick<AgentItem, 'seq' | 'payload'>,
): Promise<boolean> {
  const before = await m.getRepository(AgentItem).findOne({
    where: { threadId, kind: 'assistant', status: 'done', seq: LessThan(u.seq) },
    order: { seq: 'DESC' },
  })
  const text = String((u.payload as { text?: unknown } | null)?.text ?? '').trim()
  return (
    !!before &&
    ((before.payload as AgentItemPayloads['assistant']).suggestions ?? []).some(
      (s) => s.trim() === text,
    )
  )
}

/** The page's view of an item: the internal part left out. */
export function itemVo(i: AgentItem): AgentItemVo {
  const { internal: _, ...payload } = (i.payload ?? {}) as Record<string, unknown>
  return {
    id: Number(i.id),
    revision: i.revision ?? 0,
    seq: i.seq,
    turnId: i.turnId === null ? null : Number(i.turnId),
    kind: i.kind,
    status: i.status,
    payload,
    createdAt: new Date(i.createdAt).toISOString(),
  } as AgentItemVo
}

/** The page's view of a turn. */
export function turnVo(t: AgentTurn): AgentTurnVo {
  return {
    id: Number(t.id),
    threadId: Number(t.threadId),
    status: t.status,
    steps: t.steps,
    promptTokens: Number(t.promptTokens),
    completionTokens: Number(t.completionTokens),
    credits: t.credits ?? '0',
    unpricedCalls: t.unpricedCalls ?? 0,
    unreportedCalls: t.unreportedCalls ?? 0,
    legacyUsage: t.legacyUsage ?? false,
    error: t.errorCode ? { code: t.errorCode, message: t.errorMsg ?? '' } : null,
    startedAt: new Date(t.startedAt).toISOString(),
    endedAt: t.endedAt ? new Date(t.endedAt).toISOString() : null,
  }
}

/** The searchable text of an item: user and assistant messages only. */
const textOf = (kind: AgentItemKind, payload: unknown): string | null =>
  kind === 'user' || kind === 'assistant' ? ((payload as { text?: string }).text ?? '') : null

interface Pending {
  userId: number
  event: AgentEvent
}

/**
 * 一个事务里的条目写入：追加时锁住会话行，在锁内取下一个顺序号（同一会话的并发追加因此排队，
 * 顺序号不重复也不倒退）；事件先攒着，由 {@link ItemStore.tx} 在提交之后推给会话所有人。
 */
export class ItemWriter {
  private readonly owners = new Map<number, number>()

  constructor(
    readonly m: EntityManager,
    private readonly events: Pending[],
  ) {}

  /** 锁住并读出会话行（同一会话的写入因此串行）；会话不存在或已删除时为 null。 */
  async thread(threadId: number): Promise<AgentThread | null> {
    const t = await this.m
      .getRepository(AgentThread)
      .createQueryBuilder('t')
      .setLock('pessimistic_write')
      .where('t.id = :threadId', { threadId })
      .getOne()
    if (t) this.owners.set(Number(t.id), Number(t.userId))
    return t
  }

  /** 本会话的下一个顺序号：已有最大值（含已删除的，撤回后也不重用）加一；调用方须已锁住会话。 */
  private async nextSeq(threadId: number): Promise<number> {
    const max = await this.m
      .getRepository(AgentItem)
      .createQueryBuilder('i')
      .withDeleted()
      .select('MAX(i.seq)', 'max')
      .where('i.threadId = :threadId', { threadId })
      .getRawOne<{ max: number | null }>()
    return Number(max?.max ?? 0) + 1
  }

  /** 先锁住会话（本事务里还没锁过时）；会话已不存在时抛错。 */
  private async locked(threadId: number): Promise<void> {
    if (!this.owners.has(threadId) && !(await this.thread(threadId)))
      throw new ThreadGone(`agent thread ${threadId} is gone`)
  }

  /** 追加一个条目（取下一个顺序号），同时刷新会话的最近活动时间。 */
  async append<K extends AgentItemKind>(
    threadId: number,
    turnId: number | null,
    kind: K,
    payload: AgentItemPayloads[K] & { internal?: ItemInternal },
    status: AgentItemStatus | null = null,
  ): Promise<AgentItem> {
    await this.locked(threadId)
    const repo = this.m.getRepository(AgentItem)
    const item = await repo.save(
      repo.create({
        threadId,
        turnId,
        seq: await this.nextSeq(threadId),
        kind,
        status,
        payload,
        text: textOf(kind, payload),
      }),
    )
    await this.m.getRepository(AgentThread).update({ id: threadId }, { lastActiveAt: new Date() })
    this.push(threadId, { threadId, type: 'item', item: itemVo(item) })
    return item
  }

  /**
   * 把排队的用户消息挪到会话末尾并归入新的一轮：它发出时上一轮还在进行，原来的顺序号排在上一轮的回答
   * 之前，不挪的话模型看到的先后就错了。
   */
  async move(item: AgentItem, turnId: number): Promise<AgentItem> {
    const threadId = Number(item.threadId)
    await this.locked(threadId)
    const seq = await this.nextSeq(threadId)
    const revision = item.revision ?? 0
    const moved = await this.m
      .getRepository(AgentItem)
      .update(
        { id: item.id, revision },
        { seq, turnId, status: null, revision: () => 'revision + 1' },
      )
    if (!moved.affected) throw new StaleItem(`agent item ${item.id} changed`)
    Object.assign(item, { seq, turnId, status: null, revision: revision + 1 })
    this.push(threadId, { threadId, type: 'item', item: itemVo(item) })
    return item
  }

  /**
   * 改一个条目的载荷或状态（载荷整体替换），并推送新的条目。给了 `from` 时只在库里的状态仍是它时才改
   * （条件更新），否则抛 {@link StaleItem}、什么也不改：两个同时到的决定不会一个覆盖另一个。
   */
  async update(
    item: AgentItem,
    patch: { payload?: unknown; status?: AgentItemStatus | null },
    from?: AgentItemStatus,
    emit = true,
  ): Promise<AgentItem> {
    const payload = patch.payload !== undefined ? patch.payload : item.payload
    const text = patch.payload !== undefined ? textOf(item.kind, patch.payload) : item.text
    const status = patch.status !== undefined ? patch.status : item.status
    const res = await this.m.getRepository(AgentItem).update(
      { id: item.id, revision: item.revision ?? 0, ...(from !== undefined && { status: from }) },
      {
        payload: payload as object,
        text,
        status,
        revision: () => 'revision + 1',
      },
    )
    if (!res.affected) throw new StaleItem(`agent item ${item.id} changed`)
    Object.assign(item, { payload, text, status, revision: (item.revision ?? 0) + 1 })
    await this.ensureOwner(Number(item.threadId))
    if (emit)
      this.push(Number(item.threadId), {
        threadId: Number(item.threadId),
        type: 'item',
        item: itemVo(item),
      })
    return item
  }

  /** 新的一轮（状态 running），推送它。 */
  async createTurn(threadId: number, userId: number): Promise<AgentTurn> {
    const repo = this.m.getRepository(AgentTurn)
    const turn = await repo.save(repo.create({ threadId, userId, status: 'running' }))
    // 取回库里的默认值（开始时间、计数）
    return this.patchTurn(await repo.findOneByOrFail({ id: turn.id }), {})
  }

  /**
   * 只改给出的列（不整行保存：别的请求可能刚改过状态，例如中断），再读回库里的整行合并进 `turn` 并推送它：
   * 推送的总是库里的状态，运行中的一轮在被中断之后更新计数，也不会把页面上的状态推回 running。
   */
  async patchTurn(turn: AgentTurn, patch: Partial<AgentTurn>): Promise<AgentTurn> {
    const repo = this.m.getRepository(AgentTurn)
    if (Object.keys(patch).length) await repo.update({ id: turn.id }, patch)
    Object.assign(turn, patch, (await repo.findOneBy({ id: turn.id })) ?? {})
    await this.ensureOwner(Number(turn.threadId))
    this.push(Number(turn.threadId), {
      threadId: Number(turn.threadId),
      type: 'turn',
      turn: turnVo(turn),
    })
    return turn
  }

  private async ensureOwner(threadId: number): Promise<void> {
    if (this.owners.has(threadId)) return
    const t = await this.m.getRepository(AgentThread).findOne({
      where: { id: threadId },
      select: { id: true, userId: true },
    })
    if (t) this.owners.set(threadId, Number(t.userId))
  }

  private push(threadId: number, event: AgentEvent): void {
    const userId = this.owners.get(threadId)
    if (userId !== undefined) this.events.push({ userId, event })
  }
}

/**
 * 会话条目的唯一写入口（运行时、会话接口、批量任务共用）：每次写入在一个事务里完成，提交之后才把
 * `agent:event` 推给会话所有人本人（回滚的写入不会出现在页面上）。
 */
@Injectable()
export class ItemStore {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly realtime: RealtimeService,
  ) {}

  /** 在一个事务里执行 `fn`；其中追加、修改的条目与轮次在提交后推送。 */
  async tx<T>(fn: (w: ItemWriter) => Promise<T>): Promise<T> {
    const events: Pending[] = []
    const out = await this.ds.transaction((m) => fn(new ItemWriter(m, events)))
    for (const e of events)
      this.realtime.toUser(e.userId, { type: RT.agentEvent, payload: e.event })
    return out
  }

  /** 单独追加一个条目（自带事务）。 */
  append<K extends AgentItemKind>(
    threadId: number,
    turnId: number | null,
    kind: K,
    payload: AgentItemPayloads[K] & { internal?: ItemInternal },
    status: AgentItemStatus | null = null,
  ): Promise<AgentItem> {
    return this.tx((w) => w.append(threadId, turnId, kind, payload, status))
  }

  /** 单独修改一个条目（自带事务）。 */
  update(
    item: AgentItem,
    patch: { payload?: unknown; status?: AgentItemStatus | null },
  ): Promise<AgentItem> {
    return this.tx((w) => w.update(item, patch))
  }

  /** 有界流式快照先提交再广播，页面看到的前缀在进程被强杀后也可补拉。 */
  async checkpoint(
    userId: number,
    item: AgentItem,
    text: string,
    signal?: AbortSignal,
    fence?: (m: EntityManager) => Promise<void>,
  ): Promise<void> {
    signal?.throwIfAborted()
    const before = String((item.payload as { text?: string }).text ?? '')
    if (before === text) return
    await this.tx(async (w) => {
      await fence?.(w.m)
      return w.update(item, { payload: { ...(item.payload as object), text } }, undefined, false)
    })
    signal?.throwIfAborted()
    this.realtime.toUser(userId, {
      type: RT.agentEvent,
      payload: {
        threadId: Number(item.threadId),
        type: 'delta',
        itemId: Number(item.id),
        revision: item.revision,
        offset: before.length,
        delta: text.slice(before.length),
      },
    })
  }
}
