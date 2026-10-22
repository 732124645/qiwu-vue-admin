import { Inject, Injectable, Logger } from '@nestjs/common'
import { redisKey } from '../../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../redis/redis.module.js'

/** Orphan sweep counters for the diagnostics page. */
export interface AgentSweepCounts {
  /** time of the last sweep (ISO), null before the first one */
  lastAt: string | null
  /** turns put back on the queue, in total */
  requeued: number
  /** turns failed because their job kept dying, in total */
  failed: number
}

// 平台级的一个哈希（只有计数与时间，不含任何租户内容）
const KEY = () => redisKey('agentSweep')

/**
 * 孤儿轮次清理的统计：清理在任意一个实例的平台队列任务里跑，诊断页可能落在另一个实例，所以记在 Redis
 * 里而不是进程内。只有最后一次的时间与累计次数；写入失败只记日志，绝不影响清理本身。
 */
@Injectable()
export class AgentSweepStats {
  private readonly logger = new Logger(AgentSweepStats.name)

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** 清理跑完一次后调用：记下时间，累加重新入队与置为失败的轮次数。 */
  async record(done: { requeued: number; failed: number }): Promise<void> {
    try {
      await this.redis
        .multi()
        .hSet(KEY(), 'lastAt', new Date().toISOString())
        .hIncrBy(KEY(), 'requeued', Math.max(0, Math.trunc(done.requeued)))
        .hIncrBy(KEY(), 'failed', Math.max(0, Math.trunc(done.failed)))
        .exec()
    } catch (e) {
      this.logger.warn({ err: e instanceof Error ? e.name : 'Error' }, 'agent sweep stats skipped')
    }
  }

  /** 诊断页读取；还没跑过（或尚未接入清理）时全是零。 */
  async read(): Promise<AgentSweepCounts> {
    const h = await this.redis.hGetAll(KEY())
    const n = (v: string | undefined) => (Number.isSafeInteger(Number(v)) ? Number(v) : 0)
    return { lastAt: h.lastAt || null, requeued: n(h.requeued), failed: n(h.failed) }
  }
}
