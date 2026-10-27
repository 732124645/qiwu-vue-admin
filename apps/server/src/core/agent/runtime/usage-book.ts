import { Injectable, type OnModuleInit } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { AGENT_LIMIT_PARAMS, agentCreditAmount, Err } from '@qiwu/shared'
import type { DataSource, EntityManager } from 'typeorm'
import type { Principal } from '../../auth/principal.js'
import { allTenants, tenantId, withTenant } from '../../context/tenant.js'
import { QueueService } from '../../queue/queue.service.js'
import { AgentTurn } from '../entities/agent-thread.entity.js'
import { BizError } from '../../http/biz-error.js'
import { canonicalJson } from '../../guard/idempotent.js'
import { ParamService } from '../../settings/param.service.js'
import type { AgentUsageTarget } from '../agent-ports.js'
import { AgentUsage, AgentUsageEntry } from '../entities/agent-usage.entity.js'
import type { ChatUsage } from '../provider/chat-model.js'
import { estimatedUsage, IMAGE_OUTPUT_ESTIMATE, usageOf } from '../provider/usage.js'
import { chargeCredits, creditLimitReached, creditMicros, creditString } from './billing.js'

/** 用量和预算按 UTC 日归集。 */
export const usageDay = () => new Date().toISOString().slice(0, 10)

export interface DailyUsage {
  credits: string
  promptTokens: number | null
  completionTokens: number | null
  unpricedCalls: number
  unreportedCalls: number
  legacyCalls: number
}

/** 调用租约丢失，原调用不再有权提交结果。 */
export class InvocationLeaseLost extends Error {}

export interface UsageInvocation {
  id: number
  signal: AbortSignal
  fence(m: EntityManager): Promise<void>
  observe(usage: ChatUsage): Promise<void>
  settle(usage: ChatUsage | null, failed?: boolean): Promise<string | null>
  release(): void
}

interface UsageContext {
  threadId?: number
  turnId?: number
  failed?: boolean
  /** 调用前的输入估算：进程在拿到任何回执前崩溃时，接管结算按它计积分，不能当作免费 */
  estimate?: ChatUsage
}

/** 模型调用先登记尝试与费率，结束或接管时原子归集明细、每日及父子轮次用量。 */
@Injectable()
export class UsageBook implements OnModuleInit {
  private closing = false
  private readonly active = new Map<number, { abort(): void; done: Promise<unknown> }>()
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly params: ParamService,
    private readonly queues: QueueService,
  ) {}

  /** 两个模块的用量服务实例都登记，避免只停止主对话而漏掉后台提炼。 */
  onModuleInit(): void {
    this.queues.onDrain(async () => {
      this.closing = true
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          Promise.allSettled([...this.active.values()].map((a) => a.done)),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 3000)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
      for (const a of this.active.values()) a.abort()
      await Promise.allSettled([...this.active.values()].map((a) => a.done))
    })
  }

  /** 调用发出前先提交记录；活跃 pending 不当成欠账，从而保持既有并发额度语义。 */
  async begin(
    userId: number,
    target: AgentUsageTarget,
    context: UsageContext = {},
    signal?: AbortSignal,
  ): Promise<UsageInvocation> {
    if (this.closing) throw new InvocationLeaseLost('application is draining')
    signal?.throwIfAborted()
    if (context.turnId) {
      await this.recoverExpired(false)
      // 接管的轮次不能与上个执行者仍活跃的调用重叠；不同轮次和用户仍可正常并发。
      if (
        await this.ds
          .getRepository(AgentUsageEntry)
          .existsBy({ turnId: context.turnId, status: 'pending' })
      )
        throw new InvocationLeaseLost('the previous invocation is still leased')
    }
    const tid = tenantId()
    const parentTurnId = context.turnId
      ? ((await this.ds.getRepository(AgentTurn).findOneBy({ id: context.turnId }))?.parentTurnId ??
        null)
      : null
    const inserted = await this.ds
      .getRepository(AgentUsageEntry)
      .createQueryBuilder()
      .insert()
      .values({
        tenantId: tid,
        userId,
        providerId: target.providerId,
        providerName: target.providerName,
        model: target.model,
        threadId: context.threadId ?? null,
        turnId: context.turnId ?? null,
        parentTurnId,
        kind: target.kind ?? 'chat',
        pricing: target.pricing ? structuredClone(target.pricing) : null,
        usage: context.estimate ? () => ':estimate' : null,
        usageReported: false,
        credits: null,
        status: 'pending',
        usageDay: () => 'DATE(UTC_TIMESTAMP(3))',
        leaseUntil: () => 'DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 SECOND)',
        settledAt: null,
      })
      .setParameter('estimate', context.estimate ? JSON.stringify(context.estimate) : null)
      .execute()
    const id = Number(inserted.identifiers[0]!.id)
    const ctrl = new AbortController()
    const abort = () =>
      ctrl.abort(signal?.reason ?? new InvocationLeaseLost('invocation lease lost'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    let released = false
    let renewing = false
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const timer = setInterval(() => {
      if (renewing) {
        ctrl.abort(new InvocationLeaseLost('invocation renewal stalled'))
        return
      }
      renewing = true
      // qw:cross-tenant 异步续租必须恢复调用开始时固定的租户，不能借用调度器上下文。
      void withTenant(tid, async () => {
        const result = await this.ds
          .getRepository(AgentUsageEntry)
          .createQueryBuilder()
          .update()
          .set({ leaseUntil: () => 'DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 SECOND)' })
          .where('id = :id AND status = :status AND lease_until > UTC_TIMESTAMP(3)', {
            id,
            status: 'pending',
          })
          .execute()
        if (!result.affected) ctrl.abort(new InvocationLeaseLost('invocation lease expired'))
      })
        .catch(() => ctrl.abort(new InvocationLeaseLost('invocation renewal failed')))
        .finally(() => {
          renewing = false
        })
    }, 10_000)
    timer.unref()
    const release = () => {
      if (released) return
      released = true
      clearInterval(timer)
      signal?.removeEventListener('abort', abort)
      this.active.delete(id)
      finish()
    }
    this.active.set(id, {
      abort: () => ctrl.abort(new InvocationLeaseLost('application is draining')),
      done,
    })
    return {
      id,
      signal: ctrl.signal,
      fence: async (m) => {
        ctrl.signal.throwIfAborted()
        const row = await m
          .getRepository(AgentUsageEntry)
          .createQueryBuilder('e')
          .setLock('pessimistic_read')
          .where("e.id = :id AND e.status = 'pending' AND e.leaseUntil > UTC_TIMESTAMP(3)", { id })
          .getOne()
        if (!row) {
          ctrl.abort(new InvocationLeaseLost('invocation checkpoint is fenced'))
          ctrl.signal.throwIfAborted()
        }
      },
      observe: async (usage) => {
        const result = await this.ds
          .getRepository(AgentUsageEntry)
          .createQueryBuilder()
          .update()
          .set({ usage: () => ':usage', usageReported: usage.usageReported })
          .setParameter('usage', JSON.stringify(usage))
          .where('id = :id AND status = :status AND lease_until > UTC_TIMESTAMP(3)', {
            id,
            status: 'pending',
          })
          .execute()
        if (!result.affected) {
          // 陈旧执行者不能发布结果，但迟到的供应商数字仍必须归回同一个调用。
          try {
            await this.settle(id, usage, true, false)
          } catch (error) {
            if (!(error instanceof InvocationLeaseLost)) throw error
          }
          ctrl.abort(new InvocationLeaseLost('invocation receipt is fenced'))
        }
      },
      settle: async (usage, failed = false) => {
        try {
          const credits = await this.settle(id, usage, failed, false)
          if (ctrl.signal.reason instanceof InvocationLeaseLost) throw ctrl.signal.reason
          return credits
        } catch (error) {
          if (error instanceof InvocationLeaseLost) ctrl.abort(error)
          throw error
        } finally {
          release()
        }
      },
      release,
    }
  }

  /** complete/image 共用的持久调用入口；原始取消原因不包装，回执始终只属于本次请求。 */
  async invoke<T extends { usage?: ChatUsage | null }>(
    userId: number,
    target: AgentUsageTarget,
    context: UsageContext,
    work: (receipt: { signal: AbortSignal; onUsage(usage: ChatUsage): void }) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const invocation = await this.begin(userId, target, context, signal)
    let reported: ChatUsage | null = null
    let receipt = Promise.resolve()
    let remove = () => {}
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        const stop = () => reject(invocation.signal.reason)
        remove = () => invocation.signal.removeEventListener('abort', stop)
        invocation.signal.addEventListener('abort', stop, { once: true })
        if (invocation.signal.aborted) stop()
      })
      const result = await Promise.race([
        work({
          signal: invocation.signal,
          onUsage: (usage) => {
            reported = usage
            receipt = receipt.then(() => invocation.observe(usage))
            void receipt.catch(() => {})
          },
        }),
        aborted,
      ])
      await receipt
      invocation.signal.throwIfAborted()
      // 没报告用量的结果不能覆盖调用前记下的估算
      if (result.usage?.usageReported || result.usage?.estimated) reported = result.usage
      await invocation.settle(reported)
      return result
    } catch (error) {
      await receipt.catch(() => {})
      try {
        await invocation.settle(reported ?? usageOf(null, target.kind === 'image'), true)
      } catch (settleError) {
        if (!(settleError instanceof InvocationLeaseLost)) throw settleError
      }
      throw error
    } finally {
      remove()
      invocation.release()
    }
  }

  /** 只结算已过期的调用；跨租户仅枚举身份，实际结算回到所属租户。 */
  async recoverExpired(acrossTenants = true): Promise<number> {
    const find = () =>
      this.ds
        .getRepository(AgentUsageEntry)
        .createQueryBuilder('e')
        .select(['e.id', 'e.tenantId'])
        .where("e.status = 'pending' AND e.leaseUntil <= UTC_TIMESTAMP(3)")
        .orderBy('e.id', 'ASC')
        .take(200)
        .getMany()
    // qw:cross-tenant 定时清理只枚举租户身份，结算必须回到原租户。
    const rows = acrossTenants ? await allTenants(find) : await find()
    for (const row of rows)
      // qw:cross-tenant 只结算枚举记录所属租户的原始调用。
      await withTenant(row.tenantId, () => this.settle(Number(row.id), null, true, true))
    return rows.length
  }

  /** 扫描有界；有限预算遇到尚未归集的过期记录必须暂时拒绝，不能漏算后放行。 */
  private async expiredPending(userId?: number): Promise<boolean> {
    const qb = this.ds
      .getRepository(AgentUsageEntry)
      .createQueryBuilder('e')
      .where("e.status = 'pending' AND e.leaseUntil <= UTC_TIMESTAMP(3)")
    if (userId !== undefined) qb.andWhere('e.userId = :userId', { userId })
    return qb.getExists()
  }

  /** 0 是明确的不限额；非法配置不能静默降为免费或不限额。 */
  async limit(key: string): Promise<string> {
    const value = ((await this.params.get(key)) ?? '0').trim()
    try {
      agentCreditAmount.parse(value)
      return creditString(creditMicros(value))
    } catch {
      throw new BizError(Err.AGENT_CREDIT_CONFIG_INVALID)
    }
  }

  /**
   * 模型调用前统一检查当前每日积分：只按已计价积分判断，未计价、未报告用量的调用不阻断后续调用。
   * 有限预算下仍有过期未归集的调用时暂时拒绝，避免这笔可能已计价的消费漏算后放行。
   */
  async overDaily(userId: number): Promise<'user_daily' | 'tenant_daily' | null> {
    await this.recoverExpired(false)
    const over = async (limitKey: string, user?: number) => {
      const limit = await this.limit(limitKey)
      if (creditMicros(limit) === 0n) return false
      return (
        creditLimitReached((await this.today(user)).credits, limit) ||
        (await this.expiredPending(user))
      )
    }
    if (await over(AGENT_LIMIT_PARAMS.userDailyCredits, userId)) return 'user_daily'
    return (await over(AGENT_LIMIT_PARAMS.tenantDailyCredits)) ? 'tenant_daily' : null
  }

  /** 记录调用者本次实际用量，返回本次已计算积分供父轮汇总复用。 */
  record(
    p: Principal,
    target: AgentUsageTarget,
    usage: ChatUsage | null,
    context: { threadId?: number; turnId?: number; failed?: boolean } = {},
  ): Promise<string | null> {
    return this.add(p.userId, target, usage, context)
  }

  /** 明细与日汇总同一事务写入；同名模型按提供方区分，缓存细分不重复累加到 Token 总数。 */
  async add(
    userId: number,
    target: AgentUsageTarget,
    usage: ChatUsage | null,
    context: { threadId?: number; turnId?: number; failed?: boolean } = {},
  ): Promise<string | null> {
    const invocation = await this.begin(userId, target, context)
    return invocation.settle(usage, context.failed)
  }

  /** 行锁与状态转换把明细、日账、本轮与父轮放进同一事务，重复提交不重复计量。 */
  private async settle(
    id: number,
    reported: ChatUsage | null,
    failed: boolean,
    expired: boolean,
  ): Promise<string | null> {
    const result = await this.ds.transaction(async (m) => {
      const entry = await m
        .getRepository(AgentUsageEntry)
        .createQueryBuilder('e')
        .setLock('pessimistic_write')
        .where('e.id = :id', { id })
        .getOneOrFail()
      const pending = entry.status === 'pending'
      const previous = entry.usage
      // 估算只用于计积分：Token 统计、增量与合并只取供应商真实报告的部分
      const prior = previous?.usageReported ? previous : null
      const moreActual =
        reported?.usageReported && canonicalJson(previous) !== canonicalJson(reported)
      if (!pending && !moreActual)
        return { credits: entry.credits, fenced: entry.status === 'unknown' }
      const [{ alive }] = await m.query<{ alive: number }[]>(
        'SELECT lease_until > UTC_TIMESTAMP(3) AS alive FROM agent_usage_entry WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
        [id, tenantId()],
      )
      if (expired && (alive || !pending)) return { credits: entry.credits, fenced: false }
      // 过期的原调用不能覆盖接管；其最后已提交的供应商回执仍保留计费。
      const abandoned = expired || !alive || !pending
      const usage = reported?.usageReported
        ? {
            ...reported,
            promptTokens: reported.promptTokens ?? prior?.promptTokens ?? null,
            completionTokens: reported.completionTokens ?? prior?.completionTokens ?? null,
            cacheReadTokens: reported.cacheReadTokens ?? prior?.cacheReadTokens ?? null,
            cacheWriteTokens: reported.cacheWriteTokens ?? prior?.cacheWriteTokens ?? null,
            reasoningTokens: reported.reasoningTokens ?? prior?.reasoningTokens ?? null,
            inputDetails:
              reported.inputDetails || prior?.inputDetails
                ? { ...prior?.inputDetails, ...reported.inputDetails }
                : null,
            outputDetails:
              reported.outputDetails || prior?.outputDetails
                ? { ...prior?.outputDetails, ...reported.outputDetails }
                : null,
          }
        : prior
          ? prior
          : // 没有真实用量：结束时带来的估算（含已输出内容）优先于调用前只含输入的估算
            reported?.estimated
            ? reported
            : (previous ?? reported)
      const oldUnreported =
        !previous?.usageReported ||
        previous.promptTokens === null ||
        previous.completionTokens === null

      const pricing =
        failed && entry.kind === 'image' && entry.pricing
          ? { ...entry.pricing, imageCredits: null }
          : entry.pricing
      let credits: string | null
      try {
        credits = chargeCredits(pricing, usage, entry.kind)
      } catch {
        credits = null
      }
      if (!pending && entry.kind === 'image' && credits === null && entry.credits !== null)
        credits = entry.credits // 已确认产出时的单张费用不会被迟到但仍不完整的 Token 回执抹掉。
      // 配了费率就一定记积分：实际用量不能计价时退回这次调用的估算，没有任何估算时按零输入估算
      // （成功的图片另计固定输出估算），不能记成“未计价”而不计也不挡
      if (credits === null && pricing) {
        const fallback =
          [reported, previous].find((u) => u?.estimated) ??
          estimatedUsage(0, entry.kind === 'image' && !failed ? IMAGE_OUTPUT_ESTIMATE : 0)
        try {
          credits = chargeCredits(pricing, fallback, entry.kind)
        } catch {
          credits = null
        }
      }
      const unreported =
        !usage?.usageReported || usage.promptTokens === null || usage.completionTokens === null
      const tid = tenantId()
      await m
        .getRepository(AgentUsageEntry)
        .createQueryBuilder()
        .update()
        .set({
          usage: () => ':usage',
          credits,
          usageReported: usage?.usageReported ?? false,
          status: abandoned && pending ? 'unknown' : 'complete',
          settledAt: new Date(),
          leaseUntil: null,
        })
        .setParameter('usage', usage === null ? null : JSON.stringify(usage))
        .where('id = :id', { id })
        .execute()
      const day = entry.usageDay ?? new Date(entry.createdAt).toISOString().slice(0, 10)
      const beforeCredits = pending ? '0' : (entry.credits ?? '0')
      const change = creditMicros(credits ?? '0') - creditMicros(beforeCredits)
      const creditChange = `${change < 0n ? '-' : ''}${creditString(change < 0n ? -change : change)}`
      const actual = usage?.usageReported ? usage : null
      const inputChange = (actual?.promptTokens ?? 0) - (pending ? 0 : (prior?.promptTokens ?? 0))
      const outputChange =
        (actual?.completionTokens ?? 0) - (pending ? 0 : (prior?.completionTokens ?? 0))
      const unpricedChange =
        Number(credits === null) - (pending ? 0 : Number(entry.credits === null))
      const unreportedChange = Number(unreported) - (pending ? 0 : Number(oldUnreported))
      if (pending)
        await m.query(
          `INSERT INTO agent_usage
           (tenant_id, user_id, day, provider_id, provider_name, model, calls,
            prompt_tokens, completion_tokens, credits, cache_read_tokens, cache_write_tokens,
            reasoning_tokens, unpriced_calls, unreported_calls, legacy_calls)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 0) AS n
         ON DUPLICATE KEY UPDATE calls = agent_usage.calls + 1,
           prompt_tokens = agent_usage.prompt_tokens + n.prompt_tokens,
           completion_tokens = agent_usage.completion_tokens + n.completion_tokens,
           credits = agent_usage.credits + n.credits,
           cache_read_tokens = agent_usage.cache_read_tokens + n.cache_read_tokens,
           cache_write_tokens = agent_usage.cache_write_tokens + n.cache_write_tokens,
           reasoning_tokens = agent_usage.reasoning_tokens + n.reasoning_tokens,
           unpriced_calls = agent_usage.unpriced_calls + n.unpriced_calls,
           unreported_calls = agent_usage.unreported_calls + n.unreported_calls`,
          [
            tid,
            entry.userId,
            day,
            entry.providerId,
            entry.providerName,
            entry.model.slice(0, 128),
            actual?.promptTokens ?? 0,
            actual?.completionTokens ?? 0,
            credits ?? '0',
            usage?.cacheReadTokens ?? null,
            usage?.cacheWriteTokens ?? null,
            usage?.reasoningTokens ?? null,
            credits === null ? 1 : 0,
            unreported ? 1 : 0,
          ],
        )
      else {
        await m.query(
          `UPDATE agent_usage SET prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?,
          credits = credits + ?, unpriced_calls = unpriced_calls + ?, unreported_calls = unreported_calls + ?
          WHERE tenant_id = ? AND user_id = ? AND day = ? AND provider_id = ? AND model = ? AND deleted_at IS NULL`,
          [
            inputChange,
            outputChange,
            creditChange,
            unpricedChange,
            unreportedChange,
            tid,
            entry.userId,
            day,
            entry.providerId,
            entry.model,
          ],
        )
        // 补回迟到明细后重算 nullable 子计数，不能让早期未知留下永久 NULL 或虚造零。
        const [detail] = await m.query<Record<string, string | number | null>[]>(
          `SELECT COUNT(*) AS n,
          COUNT(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(usage_json, '$.cacheReadTokens')), 'null')) AS readCount,
          COUNT(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(usage_json, '$.cacheWriteTokens')), 'null')) AS writeCount,
          COUNT(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(usage_json, '$.reasoningTokens')), 'null')) AS reasonCount,
          SUM(CASE WHEN JSON_TYPE(JSON_EXTRACT(usage_json, '$.cacheReadTokens')) = 'INTEGER' THEN JSON_EXTRACT(usage_json, '$.cacheReadTokens') ELSE 0 END) AS readTokens,
          SUM(CASE WHEN JSON_TYPE(JSON_EXTRACT(usage_json, '$.cacheWriteTokens')) = 'INTEGER' THEN JSON_EXTRACT(usage_json, '$.cacheWriteTokens') ELSE 0 END) AS writeTokens,
          SUM(CASE WHEN JSON_TYPE(JSON_EXTRACT(usage_json, '$.reasoningTokens')) = 'INTEGER' THEN JSON_EXTRACT(usage_json, '$.reasoningTokens') ELSE 0 END) AS reasoningTokens
          FROM agent_usage_entry WHERE tenant_id = ? AND user_id = ? AND usage_day = ? AND provider_id = ? AND model = ? AND status <> 'pending' AND deleted_at IS NULL`,
          [tid, entry.userId, day, entry.providerId, entry.model],
        )
        await m.query(
          `UPDATE agent_usage SET
          cache_read_tokens = IF(calls = ? AND ? = ?, ?, NULL),
          cache_write_tokens = IF(calls = ? AND ? = ?, ?, NULL),
          reasoning_tokens = IF(calls = ? AND ? = ?, ?, NULL)
          WHERE tenant_id = ? AND user_id = ? AND day = ? AND provider_id = ? AND model = ? AND deleted_at IS NULL`,
          [
            detail.n,
            detail.n,
            detail.readCount,
            detail.readTokens,
            detail.n,
            detail.n,
            detail.writeCount,
            detail.writeTokens,
            detail.n,
            detail.n,
            detail.reasonCount,
            detail.reasoningTokens,
            tid,
            entry.userId,
            day,
            entry.providerId,
            entry.model,
          ],
        )
      }
      for (const turnId of new Set(
        [entry.turnId, entry.parentTurnId].filter((v): v is number => v !== null),
      )) {
        await m.query(
          // qw:include-deleted 晚到的真实账单仍修正原轮次审计累计，软删除不能造成漏账。
          `UPDATE agent_turn SET prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?,
          credits = credits + ?, unpriced_calls = unpriced_calls + ?, unreported_calls = unreported_calls + ?
          WHERE id = ? AND tenant_id = ?`,
          [inputChange, outputChange, creditChange, unpricedChange, unreportedChange, turnId, tid],
        )
      }
      return { credits, fenced: abandoned }
    })
    if (!expired && result.fenced) throw new InvocationLeaseLost('invocation already taken over')
    return result.credits
  }

  /** 今日已知积分与未知次数分别返回；历史未定价记录不冒充本轮新消费，也不猜历史费率。 */
  async today(userId?: number): Promise<DailyUsage> {
    const qb = this.ds
      .getRepository(AgentUsage)
      .createQueryBuilder('u')
      .select('COALESCE(SUM(u.credits), 0)', 'credits')
      .addSelect('COALESCE(SUM(u.promptTokens), 0)', 'promptTokens')
      .addSelect('COALESCE(SUM(u.completionTokens), 0)', 'completionTokens')
      .addSelect('COALESCE(SUM(u.unpricedCalls), 0)', 'unpricedCalls')
      .addSelect('COALESCE(SUM(u.unreportedCalls), 0)', 'unreportedCalls')
      .addSelect('COALESCE(SUM(u.legacyCalls), 0)', 'legacyCalls')
      .where('u.day = UTC_DATE()')
    if (userId !== undefined) qb.andWhere('u.userId = :userId', { userId })
    const r = (await qb.getRawOne<Record<string, string>>()) ?? {}
    const missing = Number(r.unreportedCalls ?? 0)
    return {
      credits: r.credits ?? '0',
      promptTokens: missing ? null : Number(r.promptTokens ?? 0),
      completionTokens: missing ? null : Number(r.completionTokens ?? 0),
      unpricedCalls: Number(r.unpricedCalls ?? 0),
      unreportedCalls: missing,
      legacyCalls: Number(r.legacyCalls ?? 0),
    }
  }
}
