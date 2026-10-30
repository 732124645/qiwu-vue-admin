import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { Err } from '@qiwu/shared'
import { BizError } from '../../http/biz-error.js'
import { redisKey } from '../../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../redis/redis.module.js'
import type { ChatModel } from './chat-model.js'

/**
 * 原子地取一个名额：先清掉已过期的租约，在用的少于上限才加入本租约（分数 = 到期毫秒）。时间取 Redis 的
 * TIME，各实例的本机时钟不准也不影响到期判断；整个键随每次取得或续期按租约时长过期，没人用时自己消失。
 * KEYS[1] 名额集合；ARGV[1] 上限，ARGV[2] 租约 id，ARGV[3] 租约毫秒。
 */
const ACQUIRE = `local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[1]) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return 1
end
return 0`
/** 续期：租约还在才延长（已过期被别人清掉的不再加回，否则会超出上限）。参数同上（ARGV[1] 不用）。 */
const RENEW = `if not redis.call('ZSCORE', KEYS[1], ARGV[2]) then return 0 end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZADD', KEYS[1], 'XX', now + tonumber(ARGV[3]), ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1`

/** 名额满时等待的退避：从 100 ms 起每次加倍，最长 1 s。以后可以改成释放时发布消息唤醒等待者。 */
const BACKOFF_MIN_MS = 100
const BACKOFF_MAX_MS = 1000
/**
 * 等名额的最长时间，不管有没有中断信号都一样：经用量登记的调用都带着信号，但技能起草、记忆提炼这类调用的
 * 信号只在进程退出时才中断，不能指望它结束等待。停止、暂停、轮次时限仍可以更早结束等待。
 */
const MAX_WAIT_MS = 120_000
/** 一次调用最长占用名额的时长：超过后不再续期，防止没被正确收尾的流把名额一直占着。 */
const HOLD_MAX_MS = 60 * 60_000

/** 名额等到上限仍没空出：与端点自己回的 `http_429` 区分，消息提示“模型繁忙”。 */
export const providerBusy = () =>
  new BizError(
    { ...Err.AGENT_PROVIDER_FAILED, key: 'error.agent.provider_busy' },
    { reason: 'provider_busy' },
  )

/** 释放已取得的名额；可重复调用，只有第一次生效，且从不抛错。 */
export type SlotRelease = () => Promise<void>

/**
 * 按模型提供方计数的跨实例信号量：每个名额是 Redis 有序集合里的一个租约（成员 = 随机 id，分数 = 到期时间），
 * 所有实例、所有租户发往同一提供方的调用共用一个集合。持有期间定时续期，长时间的流式调用不会丢名额；
 * 持有的进程崩溃后，名额最晚在租约时长后自动空出。
 */
@Injectable()
export class ProviderSlots {
  private readonly logger = new Logger(ProviderSlots.name)
  /** 租约时长；测试可改短 */
  ttlMs = 90_000
  /** 续期间隔 */
  renewMs = 30_000
  /** 等名额的最长时间；测试可改短 */
  maxWaitMs = MAX_WAIT_MS

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * 取得提供方 `providerId` 的一个名额（上限 `limit`），满了就等：直到有名额空出、`signal` 中断（抛出中断
   * 原因，不算繁忙）或等待超过上限（抛 provider_busy）。返回释放函数，调用方必须在所有路径上调用它。
   */
  async acquire(providerId: number, limit: number, signal?: AbortSignal): Promise<SlotRelease> {
    const key = redisKey('lock', 'agent-provider', providerId)
    const lease = randomUUID()
    const args = [String(limit), lease, String(this.ttlMs)]
    const deadline = Date.now() + this.maxWaitMs
    for (let delay = BACKOFF_MIN_MS; ; delay = Math.min(delay * 2, BACKOFF_MAX_MS)) {
      signal?.throwIfAborted()
      if (await this.redis.eval(ACQUIRE, { keys: [key], arguments: args })) break
      const left = deadline - Date.now()
      if (left <= 0) throw providerBusy()
      try {
        await sleep(Math.min(delay, left), undefined, { signal })
      } catch (e) {
        // 等待中被中断：抛出调用方的中断原因（停止、暂停、轮次时限），与普通中断的结果一致
        signal?.throwIfAborted()
        throw e
      }
    }
    return this.hold(key, lease, args)
  }

  /** 持有名额：定时续期（续期失败只记日志，调用照常进行），返回只生效一次的释放函数。 */
  private hold(key: string, lease: string, args: string[]): SlotRelease {
    const started = Date.now()
    const timer = setInterval(() => {
      if (Date.now() - started > HOLD_MAX_MS) return clearInterval(timer)
      this.redis
        .eval(RENEW, { keys: [key], arguments: args })
        .catch((err: unknown) => this.logger.warn({ key, err }, 'provider slot renewal failed'))
    }, this.renewMs)
    // 续期定时器不单独让进程保持运行
    timer.unref()
    let released = false
    return async () => {
      if (released) return
      released = true
      clearInterval(timer)
      try {
        await this.redis.zRem(key, lease)
      } catch (err) {
        // 删不掉的租约最晚在租约时长后过期，名额自己空出
        this.logger.warn({ key, err }, 'provider slot release failed')
      }
    }
  }
}

/**
 * 给模型调用套上名额：每次 `stream` / `complete` / `image` 先取得名额，结束时释放——正常结束、流读完、
 * 调用方提前停止读取（`return()`）、出错、中断都只释放一次。流式调用在整个流期间占着名额。
 * 开始等名额时同步回报 `onSlot(false)`，取得后回报 `onSlot(true)`：以 false 结束的调用请求没有发出，
 * 计量据此不计积分、不记调用，图片也不当成结果不明的付费请求。
 */
export function withProviderSlot(
  chat: ChatModel,
  take: (signal?: AbortSignal) => Promise<SlotRelease>,
): ChatModel {
  /** 取名额并回报进度；第一句在调用里同步执行，等待中被中断时调用方已能看到“没发出”。 */
  const slot = async (req: { signal?: AbortSignal; onSlot?: (held: boolean) => void }) => {
    req.onSlot?.(false)
    const release = await take(req.signal)
    req.onSlot?.(true)
    return release
  }
  return {
    async *stream(req) {
      const release = await slot(req)
      try {
        yield* chat.stream(req)
      } finally {
        await release()
      }
    },
    async complete(req) {
      const release = await slot(req)
      try {
        return await chat.complete(req)
      } finally {
        await release()
      }
    },
    ...(chat.image && {
      async image(req) {
        const release = await slot(req)
        try {
          return await chat.image!(req)
        } finally {
          await release()
        }
      },
    }),
  }
}
