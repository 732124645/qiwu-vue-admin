// Redis cleanup for specs: the ACL user may not FLUSHDB/KEYS, so delete this app's
// keys (REDIS_KEY_PREFIX, `qw:*`) with SCAN MATCH + UNLINK.
import type { INestApplication } from '@nestjs/common'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { keyPattern } from '../../src/core/redis/cache-namespaces.js'

/** Deletes every `qw:*` key of the connected db; returns how many were removed. */
export async function cleanRedis(redis: Redis): Promise<number> {
  let removed = 0
  for await (const keys of redis.scanIterator({ MATCH: keyPattern(), COUNT: 500 }))
    if (keys.length) removed += await redis.unlink(keys)
  return removed
}

/**
 * 等防重复提交窗口（`@Idempotent()`）真正结束：轮询本库的 `idem` 键，直到一个不剩，而不是按 ttl 猜等待时间——
 * Redis 跑在容器或虚拟机里时，过期判定与本机时钟可能差出几百毫秒甚至更多。测试文件串行执行，库里的 `idem`
 * 键只来自本文件的请求。最多等 `timeoutMs`，仍有键时抛错。
 */
export async function waitIdempotencyWindow(
  app: Pick<INestApplication, 'get'>,
  timeoutMs = 10_000,
): Promise<void> {
  const redis = app.get<Redis>(REDIS)
  for (const until = Date.now() + timeoutMs; ;) {
    let alive = 0
    for await (const keys of redis.scanIterator({ MATCH: keyPattern('idem'), COUNT: 500 }))
      alive += keys.length
    if (!alive) return
    if (Date.now() > until)
      throw new Error(`${alive} idempotency keys still alive after ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
