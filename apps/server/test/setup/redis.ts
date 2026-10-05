// Redis cleanup for specs: the ACL user may not FLUSHDB/KEYS, so delete this app's
// keys (REDIS_KEY_PREFIX, `qw:*`) with SCAN MATCH + UNLINK.
import type { Redis } from '../../src/core/redis/redis.module.js'
import { keyPattern } from '../../src/core/redis/cache-namespaces.js'

/** Deletes every `qw:*` key of the connected db; returns how many were removed. */
export async function cleanRedis(redis: Redis): Promise<number> {
  let removed = 0
  for await (const keys of redis.scanIterator({ MATCH: keyPattern(), COUNT: 500 }))
    if (keys.length) removed += await redis.unlink(keys)
  return removed
}
