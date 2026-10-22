import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Optional,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  AGENT_AUTOMATION_RUN_ERRORS,
  AGENT_MESSAGE_MAX,
  AGENT2_PARAMS,
  type AgentApprovalMode,
  DEFAULT_LOCALE,
} from '@qiwu/shared'
import { ClsServiceManager } from 'nestjs-cls'
import { I18nService } from 'nestjs-i18n'
import { type DataSource, In, IsNull } from 'typeorm'
import { type ActionHeard, AuditWriter } from '../../audit/audit-writer.js'
import { PermVersion } from '../../auth/perm-version.js'
import type { Principal } from '../../auth/principal.js'
import { allTenants, withTenant } from '../../context/tenant.js'
import { dataScopeOf } from '../../data-scope/data-scope.js'
import { BizError } from '../../http/biz-error.js'
import {
  type AgentRunProfile,
  type AgentSkillRef,
  PROFILE_SOURCE,
  type ProfileSource,
  SKILL_SOURCE,
  type SkillSource,
  TURN_CONTROL,
  type TurnControl,
} from '../agent-ports.js'
import { type NotifyChannelCode, Notifier } from '../../notify/notify.js'
import { QueueService } from '../../queue/queue.service.js'
import type { QueuedJob } from '../../queue/tenant-job.processor.js'
import { redisKey } from '../../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../redis/redis.module.js'
import { ParamService } from '../../settings/param.service.js'
import { AgentBatchTargets } from '../batch/batch-targets.js'
import { AgentItem, AgentThread, AgentTurn } from '../entities/agent-thread.entity.js'
import { ProviderRegistry } from '../provider/provider-registry.js'
import { type ItemInternal, ItemStore } from '../runtime/item-store.js'
import { AgentNotifySettingsService } from '../runtime/notify-settings.js'
import { AgentThreadService } from '../threads/thread.service.js'
import { TurnQueue } from '../runtime/turn-queue.js'
import { AgentAutomation, AgentAutomationRun } from './automation.entity.js'
import { nextFire } from './automation-cron.js'
import { loadPrincipal, ownerMayRun } from './pre-approval.js'

/** The tenant queue of automation triggers: `schedule` (a job scheduler fire) and `event` (an action). */
export const AGENT_AUTOMATION_QUEUE = 'agent-automation'
/** Inbox and mail template of an automation's result (seeded with the agent's). */
export const AUTOMATION_NOTICE = 'agent.automation.result'
/** Inbox template: an automation was switched off because its owner can no longer run it. */
export const AUTOMATION_STOPPED = 'agent.automation.stopped'
/** How long a day's run counter is kept. */
const RUNS_KEY_MS = 2 * 24 * 3600_000
/** Events of one automation closer together than this start one run only (the rest are dropped). */
const EVENT_THROTTLE_MS = 60_000
/** How long an event is remembered so that a retried job never starts a second run for it. */
const EVENT_ONCE_MS = 24 * 3600_000
/** How long a schedule's fire is remembered so that a job processed twice starts one run only. */
const FIRE_ONCE_MS = 3600_000
/** The longest answer summary kept on a run. */
const SUMMARY_MAX = 4000

export type RunError = (typeof AGENT_AUTOMATION_RUN_ERRORS)[number]
type Trigger = AgentAutomationRun['triggerKind']
/** An action an event automation reacts to, as the queued job carries it. */
export interface HeardEvent {
  domain: string
  verb: string
  bizId: string | null
  traceId: string | null
}

const OPEN_RUN = In(['running', 'waiting'])
/** The job scheduler of an automation (automation ids are unique across tenants). */
const schedulerId = (id: number) => `agent-automation-${id}`
/**
 * 一条自动化的事件记号（去重、节流）的名字：带上它的创建时间，库被重建、id 被重新使用时旧记号不会挡住新的
 * 自动化。
 */
export const eventMark = (a: Pick<AgentAutomation, 'id' | 'createdAt'>, what: string) =>
  redisKey('lock', `agent-auto-${what}-${a.id}-${new Date(a.createdAt).getTime()}`)
/** 一条自动化今天（UTC 日，与智能体的 token 额度相同）的运行计数的键；带创建时间，id 被重新使用时不继承计数。 */
const runsKey = (a: Pick<AgentAutomation, 'id' | 'createdAt'>) =>
  redisKey(
    'agentAutoRuns',
    Number(a.id),
    new Date(a.createdAt).getTime(),
    new Date().toISOString().slice(0, 10),
  )

/** 自动化的写入模式 → 隐藏会话的审批模式（预先同意靠审批审查者放行，其余写入照常停下等人）。 */
export const MODE: Record<AgentAutomation['writeMode'], AgentApprovalMode> = {
  read_only: 'read_only',
  ask: 'ask',
  pre_approved: 'ask',
  auto_review: 'auto_review',
}

/**
 * 自动化的运行（see docs/agent.md）：定时、业务事件与手动三种触发都到 {@link start}——运行前以创建人此刻
 * 的身份检查（急停、创建人被停用或失去权限、每日次数），不能运行的记一条 skipped 并写明原因；能运行的开
 * 一个隐藏会话（`automation_run_id`，不进会话列表），放进一条带技能或提示词的排队消息，由轮次队列在创建人
 * 的并发名额内开始，按创建人的权限、数据权限与租户执行，急停、每日额度与用量记账照常适用。一轮结束或停下
 * 等人时（轮次队列的让出名额回调）把结果同步到运行记录，结束的按通知方式提醒创建人。
 *
 * 定时用队列的重复任务（每条自动化一个 job scheduler，存在 Redis 里，多实例下每次只触发一次）；启停、
 * 删除、改 cron 时同步更新或移除，启动时按库里的自动化重新登记一遍。
 */
@Injectable()
export class AgentAutomationRunner
  implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(AgentAutomationRunner.name)
  /** 操作日志监听里还没做完的入队（关闭时等它们做完，不丢事件、不在连接关掉后写 Redis） */
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly store: ItemStore,
    private readonly queue: TurnQueue,
    private readonly queues: QueueService,
    private readonly providers: ProviderRegistry,
    private readonly params: ParamService,
    private readonly permVersion: PermVersion,
    private readonly targets: AgentBatchTargets,
    private readonly audit: AuditWriter,
    private readonly i18n: I18nService,
    private readonly notifier: Notifier,
    private readonly notifySettings: AgentNotifySettingsService,
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly threads: AgentThreadService,
    @Inject(TURN_CONTROL) private readonly control: TurnControl,
    @Optional() @Inject(PROFILE_SOURCE) private readonly profiles?: ProfileSource,
    @Optional() @Inject(SKILL_SOURCE) private readonly skills?: SkillSource,
  ) {}

  /**
   * 挂上两个钩子：轮次让出名额时同步运行记录；每条成功的操作日志写入后看有没有自动化在听它（不在请求里等，
   * 但记着这件事，关闭时等它做完）。
   */
  onModuleInit(): void {
    this.queue.onReleased((userId) => this.sync(userId))
    this.audit.onAction((a) => {
      const work = this.heard(a)
      this.inFlight.add(work)
      void work.finally(() => this.inFlight.delete(work))
    })
  }

  /** 关闭前等操作日志监听里的入队做完（heard 自己处理错误，不会抛）。 */
  async beforeApplicationShutdown(): Promise<void> {
    while (this.inFlight.size) await Promise.all(this.inFlight)
  }

  /** 启动时按库里的自动化重新登记定时任务（Redis 被清空或换过时也能恢复）；登记失败只记日志。 */
  async onApplicationBootstrap(): Promise<void> {
    try {
      // qw:cross-tenant boot-time re-registration of every tenant's schedules; each one is handled in its own tenant
      const rows = await allTenants(() =>
        this.ds.getRepository(AgentAutomation).find({
          where: { triggerKind: 'schedule', enabled: true },
          select: { id: true, tenantId: true },
        }),
      )
      for (const r of rows)
        // qw:cross-tenant each schedule is registered in the tenant it belongs to
        await withTenant(Number(r.tenantId), async () => {
          const a = await this.ds.getRepository(AgentAutomation).findOneBy({ id: r.id })
          if (a) await this.reschedule(a)
        })
    } catch (e) {
      this.logger.warn(e, 'agent automation schedules not re-registered')
    }
  }

  /** 每条自动化每天最多运行几次（平台参数，缺失或不合法时 50）。 */
  runsPerDay(): Promise<number> {
    return this.params.int(AGENT2_PARAMS.automationRunsPerDay, 1, 1e6, 50)
  }

  /** 今天（UTC）已经真正开始过的运行次数（跳过的不算：只在真要开始时计数）。 */
  async runsToday(a: AgentAutomation): Promise<number> {
    return Number((await this.redis.get(runsKey(a))) ?? 0)
  }

  /**
   * 占一次今天的运行名额：原子 INCR，超出上限的退回（DECR）并返回 false。几个触发同时到时不会一起越过上限。
   */
  private async claimRun(a: AgentAutomation): Promise<string | null> {
    const key = runsKey(a)
    const n = await this.redis.incr(key)
    await this.redis.pExpire(key, RUNS_KEY_MS)
    if (n <= (await this.runsPerDay())) return key
    await this.redis.decr(key)
    return null
  }

  /**
   * 运行前的检查，按顺序：急停、创建人被停用或删除、创建人失去对话 / 自动化（共享的还有共享）权限、上一次
   * 运行还没结束（先按隐藏会话同步一次，同步落下的不会一直挡着）、今天的次数已满。返回第一个不满足的原因与
   * 创建人此刻的身份。
   */
  async check(a: AgentAutomation): Promise<{ reason: RunError | null; owner: Principal | null }> {
    if (await this.queue.paused()) return { reason: 'paused', owner: null }
    const owner = await loadPrincipal(this.permVersion, Number(a.userId))
    if (!owner) return { reason: 'owner_inactive', owner: null }
    if (!ownerMayRun(owner, a)) return { reason: 'owner_forbidden', owner }
    await this.syncAutomation(Number(a.id))
    const runs = this.ds.getRepository(AgentAutomationRun)
    if (await runs.existsBy({ automationId: a.id, status: OPEN_RUN }))
      return { reason: 'overlap', owner }
    if ((await this.runsToday(a)) >= (await this.runsPerDay()))
      return { reason: 'daily_limit', owner }
    return { reason: null, owner }
  }

  /**
   * 开始一次运行：检查不通过的记一条 skipped（原因在 `quiet` 里的不记：事件风暴里不为每个被次数拦下的事件留一行），
   * 通过的在一个事务里记下运行、开隐藏会话、放进排队消息，再交给轮次队列（名额满时消息留在队里，名额空出
   * 来时开始）。返回运行记录与没能运行时的原因。
   */
  async start(
    a: AgentAutomation,
    trigger: Trigger,
    event?: HeardEvent,
    quiet: readonly RunError[] = [],
  ): Promise<{ run: AgentAutomationRun | null; reason: RunError | null }> {
    const { reason, owner } = await this.check(a)
    if (reason || !owner) {
      const why = reason ?? 'owner_inactive'
      if (quiet.includes(why)) return { run: null, reason: why }
      const run = await this.skipped(a, trigger, why, event)
      if (why === 'owner_inactive' || why === 'owner_forbidden') await this.switchOff(a)
      return { run, reason: why }
    }
    // 隐藏会话的审批模式与页面新建会话同一套校验（如自动审查要求平台已设审查模型）：此刻不可用的跳过
    try {
      await this.threads.assertMode(MODE[a.writeMode])
    } catch (e) {
      if (!(e instanceof BizError)) throw e
      return {
        run: await this.skipped(a, trigger, 'mode_unavailable', event),
        reason: 'mode_unavailable',
      }
    }
    // 预先同意的自动化：交给模型的指令只来自创建人本人或平台（保存时已校验），运行时按保存时的绑定取
    const pre = a.writeMode === 'pre_approved' && !!a.preApproved?.length
    // 配置方案按创建人此刻的身份再取一次：已删除或已不能用时不用方案（运行记录里注明），照常运行；预先同意
    // 的方案已改成全租户共用（别人能改它的说明）的也不用，预先同意随之失效
    let profile: AgentRunProfile | null =
      a.profileId === null
        ? null
        : ((await this.profiles?.find(owner, Number(a.profileId))) ?? null)
    if (pre && profile && profile.scope !== 'user') profile = null
    const skill = await this.skillFor(a, owner, pre)
    let model: Awaited<ReturnType<ProviderRegistry['resolve']>>
    try {
      model = await this.modelFor(profile)
    } catch (e) {
      if (!(e instanceof BizError)) throw e
      return {
        run: await this.skipped(a, trigger, 'not_configured', event),
        reason: 'not_configured',
      }
    }
    // 退回名额用占用时的同一个键（跨过 UTC 零点也退回到原来那一天）
    const claimed = await this.claimRun(a)
    if (!claimed)
      return { run: await this.skipped(a, trigger, 'daily_limit', event), reason: 'daily_limit' }
    const lang = owner.locale ?? DEFAULT_LOCALE
    const { text, eventFrom } = this.message(a, lang, event)
    const internal: ItemInternal = {
      ...(skill?.ref && { skillRef: skill.ref }),
      ...(eventFrom !== undefined && { eventFrom }),
    }
    const run = await this.store
      .tx(async (w) => {
        // 加锁重读：与停用、删除互斥；定时与事件触发要求此刻仍是启用的（手动运行停用的也可以）
        const fresh = await w.m
          .getRepository(AgentAutomation)
          .findOne({ where: { id: a.id }, lock: { mode: 'pessimistic_write' } })
        if (!fresh || (trigger !== 'manual' && !fresh.enabled)) return null
        const runs = w.m.getRepository(AgentAutomationRun)
        // 同一条自动化同时只跑一次：检查之后、锁住之前别的触发已经开了一次的，这次跳过
        if (await runs.existsBy({ automationId: a.id, status: OPEN_RUN })) return 'overlap' as const
        const r = await runs.save(
          runs.create({
            automationId: Number(a.id),
            threadId: null,
            triggerKind: trigger,
            event: event ? { domain: event.domain, verb: event.verb, bizId: event.bizId } : null,
            status: 'running',
            summary: null,
            errorCode: a.profileId !== null && !profile ? 'profile_missing' : null,
            startedAt: new Date(),
            endedAt: null,
          }),
        )
        const threads = w.m.getRepository(AgentThread)
        const t = await threads.save(
          threads.create({
            userId: Number(a.userId),
            title: a.name.slice(0, 200),
            status: 'active',
            providerId: model.providerId,
            model: model.model.id,
            // 推理强度只给支持它的模型（与新建会话套用方案的规则相同）
            reasoning: model.model.reasoning ? (profile?.reasoning ?? null) : null,
            approvalMode: MODE[a.writeMode],
            planMode: false,
            pinned: false,
            temporary: false,
            readSeq: 0,
            trusted: null,
            forkedFromId: null,
            profileId: profile?.id ?? null,
            automationRunId: Number(r.id),
            batchId: null,
            targetRef:
              event?.bizId && /^\d+$/.test(event.bizId) ? `${event.domain}:${event.bizId}` : null,
            context: null,
            summary: null,
            summarySeq: 0,
            lastActiveAt: new Date(),
          }),
        )
        await w.append(
          Number(t.id),
          null,
          'user',
          {
            text,
            ...(skill && { skill: skill.name }),
            ...(Object.keys(internal).length && { internal }),
          },
          'pending',
        )
        await runs.update({ id: r.id }, { threadId: Number(t.id) })
        r.threadId = Number(t.id)
        await w.m.getRepository(AgentAutomation).update({ id: a.id }, { lastRunAt: new Date() })
        return r
      })
      .catch(async (e: unknown) => {
        // 没开成：退回占用的名额
        await this.redis.decr(claimed)
        throw e
      })
    if (run === 'overlap') {
      await this.redis.decr(claimed)
      return { run: await this.skipped(a, trigger, 'overlap', event), reason: 'overlap' }
    }
    if (!run) {
      await this.redis.decr(claimed)
      return { run: null, reason: null }
    }
    await this.queue.startQueued(Number(run.threadId))
    return { run, reason: null }
  }

  /**
   * 隐藏会话用的模型：有方案时按新建会话套用方案的规则取方案的提供方与模型，已停用的退回平台默认；没有方案
   * 用平台默认。审批模式不取方案的，由自动化的写入模式决定。
   */
  private async modelFor(profile: AgentRunProfile | null) {
    if (!profile || (profile.providerId === null && profile.model === null))
      return this.providers.resolve()
    return this.providers
      .resolve(profile.providerId ?? undefined, profile.model ?? undefined)
      .catch(() => this.providers.resolve())
  }

  /**
   * 这次运行用的技能：没有技能为 null。预先同意的按条目记下的 id 与范围取（不按名字，别人建的同名技能遮
   * 不住它），取不到（删除、停用、换了范围）或没记下的就不用技能，预先同意也随之失效；其余按名字取。
   */
  private async skillFor(
    a: AgentAutomation,
    owner: Principal,
    pre: boolean,
  ): Promise<{ name: string; ref?: AgentSkillRef } | null> {
    if (!a.skill) return null
    if (!pre) return { name: a.skill }
    const ref = a.preApproved?.[0]?.skill
    const hit = ref ? await this.skills?.loadRef(owner, ref) : null
    return hit && ref ? { name: hit.name, ref } : null
  }

  /**
   * 交给模型的消息：提示词（没有时一句“运行自动化”），事件触发的再附上事件与记录 id（只是数据）。
   * `eventFrom` 是事件行在文字里开始的位置（自动审查据此只看提示词，不看事件数据）。
   */
  private message(
    a: AgentAutomation,
    lang: string,
    event?: HeardEvent,
  ): { text: string; eventFrom?: number } {
    const base =
      a.prompt?.trim() ||
      String(this.i18n.translate('agent.automation.runMessage', { lang, args: { name: a.name } }))
    if (!event) return { text: base.slice(0, AGENT_MESSAGE_MAX) }
    const line = String(
      this.i18n.translate('agent.automation.eventMessage', {
        lang,
        args: { domain: event.domain, verb: event.verb, id: event.bizId ?? '-' },
      }),
    ).slice(0, 1000)
    const room = Math.max(0, AGENT_MESSAGE_MAX - line.length - 2)
    const head = base.slice(0, room)
    return { text: `${head}\n\n${line}`.slice(0, AGENT_MESSAGE_MAX), eventFrom: head.length }
  }

  /** 记一条跳过的运行（没有会话），写明原因。 */
  private skipped(
    a: AgentAutomation,
    trigger: Trigger,
    reason: RunError,
    event?: HeardEvent,
  ): Promise<AgentAutomationRun> {
    const runs = this.ds.getRepository(AgentAutomationRun)
    const now = new Date()
    return runs.save(
      runs.create({
        automationId: Number(a.id),
        threadId: null,
        triggerKind: trigger,
        event: event ? { domain: event.domain, verb: event.verb, bizId: event.bizId } : null,
        status: 'skipped',
        summary: null,
        errorCode: reason,
        startedAt: now,
        endedAt: now,
      }),
    )
  }

  /**
   * 创建人第一次不能运行它（被停用、删除或失去权限）时停用这条自动化并移除定时任务，站内信告诉创建人；
   * 停用之后定时与事件都不再触发，也就不再一次次记“已跳过”。只有把它从启用改成停用的那一次发提醒。
   */
  private async switchOff(a: AgentAutomation): Promise<void> {
    const set = await this.ds
      .getRepository(AgentAutomation)
      .update({ id: a.id, enabled: true }, { enabled: false, nextRunAt: null })
    if (!set.affected) return
    a.enabled = false
    await this.reschedule(a)
    try {
      await this.txHost.withTransaction(() =>
        this.notifier.send({
          template: AUTOMATION_STOPPED,
          to: [Number(a.userId)],
          channels: ['inbox'],
          params: { title: a.name },
        }),
      )
    } catch (e) {
      this.logger.warn({ err: e instanceof Error ? e.name : 'Error' }, 'automation notice skipped')
    }
  }

  /**
   * 停用或删除一条自动化时停掉它还没结束的运行：先作废隐藏会话里还在排队的消息（中断之后排队的下一条不会被
   * 开成新的一轮），再以创建人（调用者）的身份中断进行中的一轮，运行记为取消。
   */
  async stopRuns(a: AgentAutomation, owner: Principal): Promise<void> {
    const open = await this.ds
      .getRepository(AgentAutomationRun)
      .find({ where: { automationId: a.id, status: OPEN_RUN } })
    for (const r of open) {
      if (r.threadId !== null) {
        const threadId = Number(r.threadId)
        await this.store.tx(async (w) => {
          if (!(await w.thread(threadId))) return
          const queued = await w.m.getRepository(AgentItem).find({
            where: { threadId, kind: 'user', status: 'pending', turnId: IsNull() },
          })
          for (const i of queued) await w.update(i, { status: 'expired' })
        })
        try {
          await this.control.cancel(owner, threadId)
        } catch (e) {
          // 会话已被删掉：运行照样记为取消
          if (!(e instanceof BizError)) throw e
        }
      }
      await this.finish(r, 'cancelled', null, null)
    }
  }

  // ---- 结果同步 ----

  /**
   * 同步某个用户（创建人）还没结束的运行；出错只记日志（这是让出名额的回调，不能抛）。隐藏会话与它们的
   * 轮次一次批量查出，只处理状态与运行记录不一致的（会话已删、轮次结束了或在运行与等人之间切换了）：
   * 未结束的运行再多，每次让出名额也只多几条查询。
   */
  async sync(userId: number): Promise<void> {
    try {
      const open = await this.ds
        .getRepository(AgentAutomationRun)
        .createQueryBuilder('r')
        .innerJoin(AgentAutomation, 'a', 'a.id = r.automationId')
        .where('a.userId = :userId', { userId })
        .andWhere('r.status IN (:...open)', { open: ['running', 'waiting'] })
        .andWhere('r.threadId IS NOT NULL')
        .getMany()
      if (!open.length) return
      const ids = open.map((r) => Number(r.threadId))
      const alive = new Set(
        (
          await this.ds
            .getRepository(AgentThread)
            .find({ where: { id: In(ids) }, select: { id: true } })
        ).map((t) => Number(t.id)),
      )
      // 隐藏会话只有一轮（不能再发消息）：按 id 升序读，后读到的覆盖前面的，留下的是最新一轮
      const latest = new Map<number, AgentTurn['status']>()
      const turns = await this.ds.getRepository(AgentTurn).find({
        where: { threadId: In(ids) },
        select: { id: true, threadId: true, status: true },
        order: { id: 'ASC' },
      })
      for (const t of turns) latest.set(Number(t.threadId), t.status)
      for (const r of open) {
        const tid = Number(r.threadId)
        const status = latest.get(tid)
        if (alive.has(tid) && (status === undefined || status === r.status)) continue
        await this.settle(r)
      }
    } catch (e) {
      this.logger.warn({ err: e instanceof Error ? e.name : 'Error' }, 'automation runs not synced')
    }
  }

  /** 同步一条自动化还没结束的运行（运行历史读取前调用）。 */
  async syncAutomation(automationId: number): Promise<void> {
    const open = await this.ds
      .getRepository(AgentAutomationRun)
      .find({ where: { automationId, status: OPEN_RUN } })
    for (const r of open) await this.settle(r)
  }

  /**
   * 按隐藏会话的最新一轮更新一条运行：还没开始（排队）的不动；进行中、等人的照抄；完成的写下回答摘要；
   * 失败的写下原因；会话被删掉的记为取消。终态只写一次（条件更新），写成的那一次才发结果提醒。
   */
  private async settle(r: AgentAutomationRun): Promise<void> {
    if (r.threadId === null) return
    const threadId = Number(r.threadId)
    if (!(await this.ds.getRepository(AgentThread).existsBy({ id: threadId }))) {
      await this.finish(r, 'cancelled', 'thread_gone', null)
      return
    }
    const turn = await this.ds
      .getRepository(AgentTurn)
      .findOne({ where: { threadId }, order: { id: 'DESC' } })
    if (!turn) return
    if (turn.status === 'running' || turn.status === 'waiting') {
      if (r.status !== turn.status)
        await this.ds
          .getRepository(AgentAutomationRun)
          .update({ id: r.id, status: OPEN_RUN }, { status: turn.status })
      return
    }
    if (turn.status === 'completed') {
      const last = await this.ds.getRepository(AgentItem).findOne({
        where: { threadId, kind: 'assistant', status: 'done' },
        order: { seq: 'DESC' },
      })
      const text = (last?.payload as { text?: string } | undefined)?.text ?? ''
      await this.finish(r, 'completed', null, text.slice(0, SUMMARY_MAX) || null)
    } else if (turn.status === 'failed')
      await this.finish(r, 'failed', 'turn_failed', turn.errorMsg?.slice(0, SUMMARY_MAX) ?? null)
    else await this.finish(r, 'cancelled', null, null)
  }

  /** 把一条运行写成终态（只在它还没结束时）；写成了且是完成或失败时提醒创建人。 */
  private async finish(
    r: AgentAutomationRun,
    status: 'completed' | 'failed' | 'cancelled',
    code: RunError | null,
    summary: string | null,
  ): Promise<void> {
    const set = await this.ds.getRepository(AgentAutomationRun).update(
      { id: r.id, status: OPEN_RUN },
      // 运行开始时记下的注明（如方案已不可用）在没有新原因时保留
      { status, ...(code !== null && { errorCode: code }), summary, endedAt: new Date() },
    )
    if (!set.affected || status === 'cancelled') return
    const a = await this.ds.getRepository(AgentAutomation).findOneBy({ id: r.automationId })
    if (a) await this.notice(a, Number(r.threadId))
  }

  /**
   * 结果提醒：自动化的通知方式里开了站内信就发站内信；邮件在自动化开了邮件、或本人的通知设置里“自动化结果”
   * 开了邮件时发。写在事务里、投递在提交之后（不等 SMTP）；失败只记日志。
   */
  private async notice(a: AgentAutomation, threadId: number): Promise<void> {
    try {
      const userId = Number(a.userId)
      const notify = a.notify ?? { inbox: true, mail: false }
      const channels: NotifyChannelCode[] = []
      if (notify.inbox) channels.push('inbox')
      if (
        notify.mail ||
        (await this.notifySettings.channels(userId, 'automation')).includes('mail')
      )
        channels.push('mail')
      if (!channels.length) return
      await this.txHost.withTransaction(() =>
        this.notifier.send({
          template: AUTOMATION_NOTICE,
          to: [userId],
          channels,
          params: { title: a.name, threadId },
        }),
      )
    } catch (e) {
      this.logger.warn({ err: e instanceof Error ? e.name : 'Error' }, 'automation notice skipped')
    }
  }

  // ---- 定时 ----

  /**
   * 按自动化此刻的设置登记或移除它的定时任务：启用的定时自动化登记（同一 id 再登记即替换，cron 或时区
   * 变了也就更新了），其余（含 `removed`：已删除）移除。任务数据带上自动化所属的租户，由队列在那个租户里执行。
   */
  async reschedule(a: AgentAutomation, removed = false): Promise<void> {
    const q = this.queues.queues().get(AGENT_AUTOMATION_QUEUE)
    if (!q) return
    const id = schedulerId(Number(a.id))
    if (!removed && a.enabled && a.triggerKind === 'schedule' && a.cron && a.timezone) {
      const data: QueuedJob<{ automationId: number }> = {
        tenantId: Number(a.tenantId),
        payload: { automationId: Number(a.id) },
      }
      // 一次触发只试一次：重试可能多开一次运行
      await q.upsertJobScheduler(
        id,
        { pattern: a.cron, tz: a.timezone },
        { name: 'schedule', data, opts: { attempts: 1 } },
      )
    } else await q.removeJobScheduler(id)
  }

  /**
   * 定时任务的入口：自动化仍是启用的定时自动化才运行，否则移除这个定时任务；之后更新下次运行时间。`at` 是
   * 这次触发的计划时刻：同一条自动化同一个计划时刻只运行一次（任务被处理两次——如卡住后被队列重新交出——
   * 也不会多开）。
   */
  async fire(automationId: number, at?: number): Promise<void> {
    const a = await this.ds.getRepository(AgentAutomation).findOneBy({ id: automationId })
    if (!a || !a.enabled || a.triggerKind !== 'schedule') {
      await this.queues
        .queues()
        .get(AGENT_AUTOMATION_QUEUE)
        ?.removeJobScheduler(schedulerId(automationId))
      return
    }
    if (at !== undefined && !(await this.once(eventMark(a, `fire-${at}`), FIRE_ONCE_MS))) return
    try {
      await this.start(a, 'schedule')
    } finally {
      const next = a.cron && a.timezone ? nextFire(a.cron, a.timezone) : null
      await this.ds.getRepository(AgentAutomation).update({ id: a.id }, { nextRunAt: next })
    }
  }

  // ---- 业务事件 ----

  /**
   * 操作日志监听：智能体自己代为执行的操作、智能体与 MCP 自身的操作不当作业务事件（免得自动化互相触发）；
   * 其余在操作所属的租户里看有没有启用的事件自动化在听它，有才入队（大多数写操作只多一次带索引的查询）。
   * 不在请求里等：失败只记日志。
   */
  private async heard(a: ActionHeard): Promise<void> {
    if (a.byAgent || a.domain.startsWith('agent.') || a.domain.startsWith('mcp.')) return
    try {
      // qw:cross-tenant the action's own tenant (the one its log row is written in)
      await withTenant(a.tenantId, async () => {
        if (!(await this.listeners(a.domain, a.verb).getExists())) return
        await this.queues.add(
          AGENT_AUTOMATION_QUEUE,
          'event',
          {
            domain: a.domain,
            verb: a.verb,
            bizId: a.bizId,
            traceId: a.traceId,
          } satisfies HeardEvent,
          { attempts: 1 },
        )
      })
    } catch (e) {
      this.logger.warn(
        { err: e instanceof Error ? e.name : 'Error' },
        'automation event not queued',
      )
    }
  }

  /** 当前租户里在听这个动作的启用的事件自动化。 */
  private listeners(domain: string, verb: string) {
    return this.ds
      .getRepository(AgentAutomation)
      .createQueryBuilder('a')
      .where("a.triggerKind = 'event' AND a.enabled = 1")
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(a.event, '$.domain')) = :domain", { domain })
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(a.event, '$.verb')) = :verb", { verb })
  }

  /**
   * 事件任务的入口：对每条在听的自动化，先看创建人能不能看到这条记录（看不到的什么也不记），再看这个事件
   * 是不是已经触发过（任务重做），然后节流（一条自动化一分钟内只因事件开一次），过了节流、真要开始运行时才
   * 记下“这个事件已触发”（风暴里被节流挡下的事件不留记号，Redis 里的记号至多每分钟一个），最后照常开始
   * 运行；风暴里被每日次数拦下的不逐条记录。
   */
  async onEvent(ev: HeardEvent): Promise<void> {
    for (const a of await this.listeners(ev.domain, ev.verb).getMany()) {
      try {
        // 创建人已被停用的照常进 start（记一条跳过）；在的须看得到这条记录
        const owner = await loadPrincipal(this.permVersion, Number(a.userId))
        if (owner && !(await this.visible(owner, ev))) continue
        const once = eventMark(a, `ev-${ev.traceId ?? '-'}-${ev.bizId ?? '-'}`)
        if (await this.redis.exists(once)) continue
        if (!(await this.once(eventMark(a, 'throttle'), EVENT_THROTTLE_MS))) continue
        if (!(await this.once(once, EVENT_ONCE_MS))) continue
        await this.start(a, 'event', ev, ['daily_limit'])
      } catch (e) {
        this.logger.warn({ err: e instanceof Error ? e.name : 'Error' }, 'automation event skipped')
      }
    }
  }

  /** 占一个只用一次的记号（Redis NX）；占到了返回 true。 */
  private async once(key: string, ms: number): Promise<boolean> {
    const set = await this.redis.set(key, '1', {
      condition: 'NX',
      expiration: { type: 'PX', value: ms },
    })
    return set === 'OK'
  }

  /**
   * 一个人能不能听某个资源的事件：root 都能；其余要有它的浏览权限（`<domain>.browse`）。资源有数据权限
   * （表是 `@DataScoped` 的实体）却没登记批量目标时，没法按这个人的数据范围读出那条记录来核对，只有给出
   * 浏览权限的角色数据范围全为“全部”的人才算看得到（否则事件会把数据范围外的记录 id 交给他的自动化）。
   */
  mayHear(p: Principal, domain: string): boolean {
    if (p.root) return true
    const browse = `${domain}.browse`
    if (!p.perms.includes(browse)) return false
    if (this.targets.get(domain) || !this.scoped(domain)) return true
    const granting = p.roles.filter((r) => r.perms.includes(browse) || r.perms.includes('*'))
    return granting.length > 0 && granting.every((r) => r.dataScope === 'all')
  }

  /** 资源（`<领域>.<资源>`，表名 `<领域>_<资源>`）的实体是否带数据权限。 */
  private scoped(domain: string): boolean {
    const table = domain.replace(/\./g, '_')
    return this.ds.entityMetadatas.some(
      (m) => m.tableName === table && typeof m.target === 'function' && !!dataScopeOf(m.target),
    )
  }

  /**
   * 创建人能不能看到事件里的记录：先要能听这个资源（{@link mayHear}）；这类记录登记了批量目标时，再以
   * 创建人的身份、按浏览权限的数据范围读一次这条记录，读不到（不在数据范围内、已删除）就算看不到。
   */
  async visible(owner: Principal, ev: HeardEvent): Promise<boolean> {
    if (!this.mayHear(owner, ev.domain)) return false
    const target = this.targets.get(ev.domain)
    if (!target) return true
    const id = Number(ev.bizId)
    if (!Number.isSafeInteger(id) || id < 1) return false
    const cls = ClsServiceManager.getClsService()
    const labels = await cls.run({ ifNested: 'inherit' }, () => {
      cls.set('principal', owner)
      return this.targets.labels(target, [id])
    })
    return labels.has(id)
  }
}
