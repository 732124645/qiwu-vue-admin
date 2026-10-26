import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { AGENT_LIMIT_PARAMS, AGENT_PAUSED_PARAM } from '@qiwu/shared'
import { DataSource, type EntityManager, In, IsNull, LessThan, Not } from 'typeorm'
import { allTenants, withTenant } from '../../context/tenant.js'
import { RedisLock } from '../../guard/redis-lock.js'
import { QueueService } from '../../queue/queue.service.js'
import { redisKey } from '../../redis/cache-namespaces.js'
import { ParamService } from '../../settings/param.service.js'
import { AgentItem, AgentThread, AgentTurn } from '../entities/agent-thread.entity.js'
import { ItemStore } from './item-store.js'

/** The tenant queue running turns (one job per run of a turn: start, and each resume after a decision). */
export const AGENT_TURN_QUEUE = 'agent-turn'
/** The platform queue of the agent's housekeeping (temporary threads, orphaned turns). */
export const AGENT_CLEANUP_QUEUE = 'agent-cleanup'
/** Temporary threads idle this long are deleted. */
export const TEMP_THREAD_IDLE_MS = 24 * 3600_000
/** How long a decision about a user's turn slots waits for another one of the same user. */
const SLOT_WAIT_MS = 5_000

/** 一轮“进行中”的状态：运行或等人。 */
export const ACTIVE_TURN = In(['running', 'waiting'])

/** 一轮里还在等人的卡片（审批或提问）。 */
export const openCards = (turnId: number) => [
  { turnId, kind: 'approval' as const, status: 'pending' as const },
  { turnId, kind: 'question' as const, status: 'pending' as const },
]

/**
 * 轮次的排队与接续：开一轮或续跑一轮就是往队列里加一个任务（任务在会话所属租户里执行）；一轮结束时
 * 把排队等候的下一条用户消息变成新的一轮。开始与续跑都受发起人的并发上限约束（{@link busy}）：没有空名额
 * 时，续跑的一轮停在 waiting（卡片都已处理，等名额），排队的消息留在队里；名额空出来时（{@link release}）
 * 按先后补上。
 */
@Injectable()
export class TurnQueue implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(TurnQueue.name)
  private readonly released: ((userId: number) => Promise<void>)[] = []
  /** 急停开关变动后的补名额，依次做（关闭时等最后一个做完） */
  private refilling: Promise<void> = Promise.resolve()

  constructor(
    private readonly queues: QueueService,
    private readonly store: ItemStore,
    @InjectDataSource() private readonly ds: DataSource,
    private readonly params: ParamService,
    private readonly lock: RedisLock,
  ) {}

  /** 急停开关一变就看一眼：解除了就主动补名额（急停期间排队的消息与等名额的续跑不必等下一次让出名额）。 */
  onModuleInit(): void {
    this.params.onInvalidate((keys) => {
      if (!keys.includes(AGENT_PAUSED_PARAM)) return
      this.refilling = this.refilling
        .then(() => this.refillAll())
        .catch((e: unknown) => this.logger.error(e, 'agent turn slots not refilled after resume'))
    })
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.refilling
  }

  /**
   * 急停解除后：各租户里有等名额的续跑（waiting 的轮次）或排队消息（还没开始的用户消息）的用户，逐个在其
   * 租户里补名额（{@link fill}）。仍在急停时什么也不做。
   */
  async refillAll(): Promise<void> {
    if (await this.paused()) return
    // qw:cross-tenant lists only who has queued work per tenant; each user is refilled inside their own tenant
    const users = await allTenants(async () => {
      const waiting = await this.ds.getRepository(AgentTurn).find({
        where: { status: 'waiting' },
        select: { id: true, userId: true, tenantId: true },
      })
      const queued = await this.ds
        .getRepository(AgentThread)
        .createQueryBuilder('t')
        .innerJoin(AgentItem, 'i', 'i.threadId = t.id')
        .select(['t.id', 't.userId', 't.tenantId'])
        .where("i.kind = 'user' AND i.status = 'pending' AND i.turnId IS NULL")
        .getMany()
      const out = new Map<string, { userId: number; tenantId: number }>()
      for (const r of [...waiting, ...queued])
        out.set(`${r.tenantId}:${r.userId}`, {
          userId: Number(r.userId),
          tenantId: Number(r.tenantId),
        })
      return [...out.values()]
    })
    for (const u of users)
      try {
        // qw:cross-tenant each user's slots are refilled in the tenant the user belongs to
        await withTenant(u.tenantId, () => this.fill(u.userId))
      } catch (e) {
        this.logger.error(e, 'agent turn slots not refilled')
      }
  }

  /** 让一轮（开始或继续）跑起来；任务失败（多为另一个实例还握着这一轮）时稍后重试。 */
  async kick(turnId: number): Promise<void> {
    await this.queues.add(
      AGENT_TURN_QUEUE,
      'run',
      { turnId },
      { attempts: 5, backoff: { type: 'fixed', delay: 2000 } },
    )
  }

  /** 队列里还没跑完的任务对应的轮次（孤儿轮次清理据此跳过已经有任务的）。 */
  async pendingTurnIds(): Promise<Set<number>> {
    const q = this.queues.queues().get(AGENT_TURN_QUEUE)
    // 上限：最多读 5000 个排队任务；积压更多时，清理只会把少数轮次多排一次（由轮次锁串行化，无害）
    const jobs = q
      ? await q.getJobs(
          ['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'],
          0,
          4999,
        )
      : []
    return new Set(
      jobs.flatMap((j) => {
        const data = j?.data as { payload?: { turnId?: unknown } } | undefined
        const id = Number(data?.payload?.turnId)
        return Number.isSafeInteger(id) ? [id] : []
      }),
    )
  }

  /** 智能体急停开关（系统参数 `agent.paused`，去空白、不分大小写恰好是 `true` 才算急停）。 */
  async paused(): Promise<boolean> {
    return (await this.params.get(AGENT_PAUSED_PARAM))?.trim().toLowerCase() === 'true'
  }

  /** 本人同时运行的轮次上限（系统参数 `agent.limit.user_concurrent_turns`）。 */
  limit(): Promise<number> {
    return this.params.int(AGENT_LIMIT_PARAMS.userConcurrentTurns, 1, 1e12, 2)
  }

  /**
   * 占着本人并发名额的轮次数：running 的，加上在一次工具调用里等外部服务器表单的 waiting（那个任务仍在
   * 执行，调用标为 running）；等审批、等反问回答的不占名额，子智能体的轮次也不占（父轮占着）。
   */
  async busy(userId: number, m: EntityManager = this.ds.manager): Promise<number> {
    const active = await m.getRepository(AgentTurn).find({
      where: { userId, status: ACTIVE_TURN },
      select: { id: true, status: true, threadId: true },
    })
    // 子智能体的轮次不另占名额：它们在父轮的调用里推进，父轮已经占着一个
    const children = active.length
      ? new Set(
          (
            await m.getRepository(AgentThread).find({
              where: {
                id: In([...new Set(active.map((t) => Number(t.threadId)))]),
                parentThreadId: Not(IsNull()),
              },
              select: { id: true },
            })
          ).map((t) => Number(t.id)),
        )
      : new Set<number>()
    const turns = active.filter((t) => !children.has(Number(t.threadId)))
    const waiting = turns.filter((t) => t.status === 'waiting').map((t) => Number(t.id))
    const inCall = waiting.length
      ? await m.getRepository(AgentItem).find({
          where: { turnId: In(waiting), kind: 'tool_call', status: 'running' },
          select: { id: true, turnId: true },
        })
      : []
    return (
      turns.filter((t) => t.status === 'running').length +
      new Set(inCall.map((i) => Number(i.turnId))).size
    )
  }

  /**
   * 同一用户的名额判断串行执行（Redis 锁）：几个审批同时确认时，计数与把轮次置为 running 不会交错，
   * 不会多开。锁等不到（Redis 慢）时照常执行：并发数本来就是软限制，宁可多开一轮也不卡住续跑。
   */
  private async serial<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const key = redisKey('lock', `agent-slots-${userId}`)
    const until = Date.now() + SLOT_WAIT_MS
    let lease = await this.lock.acquire(key, 10_000)
    while (!lease && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50))
      lease = await this.lock.acquire(key, 10_000)
    }
    try {
      return await fn()
    } finally {
      await lease?.release()
    }
  }

  /**
   * 续跑一轮（审批、回答之后，或名额空出来时）：在会话行锁里确认它仍在 waiting、卡片都已处理、不在调用
   * 里，有空名额才置为 running 并入队；没有名额就留在 waiting，等 {@link release} 再来。`full` 表示名额
   * 已满（补名额的循环据此停下），`skip` 表示这一轮不在等名额。
   *
   * 会话 id 在事务之外先查，事务的第一条语句就是会话行锁：MySQL 可重复读隔离下快照在第一次普通读时建立，
   * 先普通读再加锁的话，锁内读到的仍是旧快照——确认与中断同时到时，已中断的一轮会被改回 running，
   * 刚同意的写入在中断之后照样执行。置为 running 也是条件更新（仍是 waiting 才改），作为第二道保险。
   */
  async resume(turnId: number, userId: number): Promise<'started' | 'full' | 'skip'> {
    const head = await this.ds
      .getRepository(AgentTurn)
      .findOne({ where: { id: turnId }, select: { id: true, threadId: true } })
    if (!head) return 'skip'
    const threadId = Number(head.threadId)
    const out = await this.serial(userId, async () => {
      const limit = await this.limit()
      return this.store.tx(async (w) => {
        if (!(await w.thread(threadId))) return 'skip' as const
        const turn = await w.m.getRepository(AgentTurn).findOneBy({ id: turnId })
        if (turn?.status !== 'waiting') return 'skip' as const
        const items = w.m.getRepository(AgentItem)
        if (await items.existsBy(openCards(turnId))) return 'skip' as const
        if (await items.existsBy({ turnId, kind: 'tool_call', status: 'running' }))
          return 'skip' as const
        if ((await this.busy(userId, w.m)) >= limit) return 'full' as const
        const set = await w.m
          .getRepository(AgentTurn)
          .update({ id: turnId, status: 'waiting' }, { status: 'running' })
        if (!set.affected) return 'skip' as const
        await w.patchTurn(turn, {})
        return 'started' as const
      })
    })
    if (out === 'started') await this.kick(turnId)
    return out
  }

  /**
   * 一轮不再占用发起人的并发名额（结束，或停下等人）时调用的回调；批量执行借此补开排队的行。回调自己
   * 处理错误。
   */
  onReleased(fn: (userId: number) => Promise<void>): void {
    this.released.push(fn)
  }

  /** 通知名额已让出：先补上本人等名额的续跑与排队消息（{@link fill}），再通知各回调。 */
  async release(userId: number): Promise<void> {
    try {
      await this.fill(userId)
    } catch (e) {
      this.logger.error(e, 'agent turn slots not refilled')
    }
    for (const fn of this.released) await fn(userId)
  }

  /**
   * 补名额：先按先后续跑等名额的轮次（waiting、卡片都已处理、不在调用里），再开本人各会话里排队的消息，
   * 直到名额用完。急停时什么也不做（急停解除时由 {@link refillAll} 补上）。
   */
  async fill(userId: number): Promise<void> {
    if (await this.paused()) return
    const waiting = (
      await this.ds.getRepository(AgentTurn).find({
        where: { userId, status: 'waiting' },
        select: { id: true },
        order: { id: 'ASC' },
      })
    ).map((t) => Number(t.id))
    // 还有卡片在等人、或在调用里等表单的不是在等名额：一次查出来跳过（批量时等审批的行可能很多）
    const blocked = waiting.length
      ? new Set(
          (
            await this.ds.getRepository(AgentItem).find({
              where: [
                { turnId: In(waiting), kind: 'approval', status: 'pending' },
                { turnId: In(waiting), kind: 'question', status: 'pending' },
                { turnId: In(waiting), kind: 'tool_call', status: 'running' },
              ],
              select: { id: true, turnId: true },
            })
          ).map((i) => Number(i.turnId)),
        )
      : new Set<number>()
    for (const id of waiting)
      if (!blocked.has(id) && (await this.resume(id, userId)) === 'full') return
    const threads = (
      await this.ds.getRepository(AgentThread).find({ where: { userId }, select: { id: true } })
    ).map((t) => Number(t.id))
    if (!threads.length) return
    const queued = await this.ds.getRepository(AgentItem).find({
      where: { threadId: In(threads), kind: 'user', status: 'pending', turnId: IsNull() },
      select: { id: true, threadId: true, seq: true },
      order: { seq: 'ASC' },
    })
    for (const threadId of new Set(queued.map((q) => Number(q.threadId))))
      if ((await this.begin(threadId, userId)) === 'full') return
  }

  /**
   * 一轮结束后：开始会话里排队的下一条（{@link begin}），再通知 `userId`（这一轮的发起人）的名额已让出。
   * 会话已被删掉时照样通知：这一轮占的名额要让给本人别的会话与批量的下一行。
   */
  async startNext(threadId: number, userId: number): Promise<void> {
    try {
      await this.begin(threadId, userId)
    } finally {
      await this.release(userId)
    }
  }

  /**
   * 会话没有进行中的轮次、本人还有空名额时，把最早排队的用户消息（status pending）挪到末尾、开成新的一轮
   * 并启动；在会话行锁里判断，和发送消息互斥，不会同时开出两轮。返回 {@link begin} 的结果（会话不存在时
   * `skip`），批量补位据此在名额满时停下。
   */
  async startQueued(threadId: number): Promise<'started' | 'full' | 'skip'> {
    const owner = await this.ds
      .getRepository(AgentThread)
      .findOne({ where: { id: threadId }, select: { id: true, userId: true } })
    return owner ? this.begin(threadId, Number(owner.userId)) : 'skip'
  }

  /** {@link startQueued} 的主体：名额判断与本人的其他名额判断串行；急停时不开新的一轮。 */
  private async begin(threadId: number, userId: number): Promise<'started' | 'full' | 'skip'> {
    if (await this.paused()) return 'skip'
    const out = await this.serial(userId, async () => {
      const limit = await this.limit()
      return this.store.tx(async (w) => {
        const thread = await w.thread(threadId)
        if (!thread) return null
        if (await w.m.getRepository(AgentTurn).existsBy({ threadId, status: ACTIVE_TURN }))
          return null
        const next = await w.m.getRepository(AgentItem).findOne({
          where: { threadId, kind: 'user', status: 'pending', turnId: IsNull() },
          order: { seq: 'ASC' },
        })
        if (!next) return null
        if ((await this.busy(userId, w.m)) >= limit) return 'full' as const
        const turn = await w.createTurn(threadId, Number(thread.userId))
        await w.move(next, Number(turn.id))
        return Number(turn.id)
      })
    })
    if (typeof out === 'number') {
      await this.kick(out)
      return 'started'
    }
    return out ?? 'skip'
  }

  /** 用户开始新对话时：删掉他的其他临时会话（连同条目与轮次），进行中的不动。 */
  async dropTemporary(userId: number, keepThreadId: number): Promise<void> {
    const ids = (
      await this.ds.getRepository(AgentThread).find({
        where: { userId, temporary: true, id: Not(keepThreadId) },
        select: { id: true },
      })
    ).map((t) => Number(t.id))
    await this.purge(ids)
  }

  /** 定时清理：所有租户里空闲超过 24 小时的临时会话。 */
  async sweepTemporary(): Promise<number> {
    // qw:cross-tenant housekeeping over every tenant's temporary threads; rows are only deleted, never read out
    return allTenants(async () => {
      const cutoff = new Date(Date.now() - TEMP_THREAD_IDLE_MS)
      const before = LessThan(cutoff)
      const ids = (
        await this.ds.getRepository(AgentThread).find({
          where: [
            { temporary: true, lastActiveAt: before },
            { temporary: true, lastActiveAt: IsNull(), createdAt: before },
          ],
          select: { id: true },
        })
      ).map((t) => Number(t.id))
      return this.purge(ids, cutoff)
    })
  }

  /**
   * 物理删除临时会话及其条目与轮次（不留痕）。每个会话先锁住行（与发消息、运行中的轮次同一把锁），在锁内
   * 确认没有进行中的轮次、（定时清理时）也仍然空闲，才删：查询之后刚发来的消息不会连同会话被删掉。
   * 返回删掉的数目。
   */
  private async purge(ids: number[], idleBefore?: Date): Promise<number> {
    let n = 0
    for (const id of ids)
      n += await this.store.tx(async (w) => {
        const t = await w.thread(id)
        if (!t?.temporary || t.recoveryRequired) return 0
        const active = t.lastActiveAt ?? t.createdAt
        if (idleBefore && active && new Date(active) >= idleBefore) return 0
        if (await w.m.getRepository(AgentTurn).existsBy({ threadId: id, status: ACTIVE_TURN }))
          return 0
        await w.m.getRepository(AgentItem).delete({ threadId: id })
        await w.m.getRepository(AgentTurn).delete({ threadId: id })
        if (t.clientDraftId) {
          // 保留客户端永久去重键的薄墓碑，重试创建不能把已清理的临时会话复活。
          await w.m.getRepository(AgentThread).update(
            { id },
            {
              title: '',
              context: null,
              summary: null,
              summarySeq: 0,
              trusted: null,
              targetRef: null,
              profileId: null,
              forkedFromId: null,
              parentThreadId: null,
              batchId: null,
              automationRunId: null,
              clientDraftHash: null,
              shareToken: null,
              providerId: null,
              model: null,
              reasoning: null,
            },
          )
          await w.m.getRepository(AgentThread).softDelete({ id })
        } else await w.m.getRepository(AgentThread).delete({ id })
        return 1
      })
    return n
  }
}
