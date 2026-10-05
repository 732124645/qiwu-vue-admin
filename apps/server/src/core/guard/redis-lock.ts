import { randomUUID } from 'node:crypto'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { REDIS, type Redis } from '../redis/redis.module.js'

/** Extends KEYS[1] to ARGV[2] ms only while it still holds this holder's token ARGV[1]. */
const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0`
/** Deletes KEYS[1] only while it still holds this holder's token ARGV[1] (compare-and-delete). */
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`

/** The reason of `Lease.lost`: the holder can no longer be sure it alone holds the key. */
export class LockLostError extends Error {
  override name = 'LockLostError'
}

/** A held lock: renewed every ttl/3 until `release()`, or until a renewal is not confirmed. */
export interface Lease {
  readonly key: string
  /** false once released or lost */
  readonly held: boolean
  /**
   * Aborted (reason: {@link LockLostError}) when the lease is lost: a renewal found the key gone or
   * held by another token, failed, or had not answered by the next one. The key may then expire and be
   * taken by another holder, so the work it guards must stop. `release()` never aborts it.
   */
  readonly lost: AbortSignal
  /** Stops renewing and deletes the key if it still holds this lease's token; true when it did. */
  release(): Promise<boolean>
}

/**
 * Mutual exclusion over Redis: `SET key token NX PX ttl`, renewed every ttl/3 while
 * held (so a holder that runs longer than ttl keeps it), released by a Lua compare-and-delete on the
 * random token (a lease that lost its key never deletes the next holder's). A renewal that is not
 * confirmed (refused, failed, or still pending at the next tick) ends the lease at once and aborts
 * `lost`: at that point at least 2/3 of the ttl is left for the holder to stop before the key can
 * expire. Keys come from the caller, built with `redisKey` (`job:lock:{id}`, `lock:…`).
 * One Redis node; a failover can hand the lock out twice (no Redlock), fine for a
 * single-instance scheduler.
 */
@Injectable()
export class RedisLock {
  private readonly logger = new Logger(RedisLock.name)

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Tries once; null when another holder has the key. */
  async acquire(key: string, ttlMs: number): Promise<Lease | null> {
    const ttl = Math.max(1, Math.ceil(ttlMs))
    const token = randomUUID()
    const taken = await this.redis.set(key, token, {
      condition: 'NX',
      expiration: { type: 'PX', value: ttl },
    })
    if (taken === null) return null
    let held = true
    let renewing = false
    const lost = new AbortController()
    const stop = () => {
      held = false
      clearInterval(timer)
    }
    const lose = (why: string, err?: unknown) => {
      if (!held) return
      stop()
      this.logger.warn({ key, err }, `lock lost: ${why}`)
      lost.abort(new LockLostError(`lock ${key} lost: ${why}`))
    }
    const timer = setInterval(
      () => {
        // the previous renewal never answered: the key may be expiring unseen
        if (renewing) return lose('renewal not answered')
        renewing = true
        this.redis.eval(RENEW, { keys: [key], arguments: [token, String(ttl)] }).then(
          (ok) => {
            renewing = false
            if (!ok) lose('taken over or expired')
          },
          (err: unknown) => {
            renewing = false
            lose('renewal failed', err)
          },
        )
      },
      Math.max(1, Math.floor(ttl / 3)),
    )
    // never keeps the process alive by itself
    timer.unref()
    return {
      key,
      get held() {
        return held
      },
      lost: lost.signal,
      release: async () => {
        stop()
        return (await this.redis.eval(RELEASE, { keys: [key], arguments: [token] })) === 1
      },
    }
  }
}
