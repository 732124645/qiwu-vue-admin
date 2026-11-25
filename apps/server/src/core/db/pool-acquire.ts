import { Logger } from '@nestjs/common'
import type { Pool, PoolConnection } from 'mysql2'

/** The error code of a pool acquire that waited longer than `DB_POOL_ACQUIRE_TIMEOUT_MS`. */
export const DB_POOL_TIMEOUT = 'QW_DB_POOL_TIMEOUT'

const logger = new Logger('DbPool')

/**
 * 连接池已满时请求拿不到连接的错误：本模块的取连接超时，或 mysql2 自己的排队上限
 * （`DB_POOL_QUEUE_LIMIT`，mysql2 只给 message 不给 code）。异常过滤器据此回 503。
 */
export function isPoolExhausted(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return (
    (e as { code?: unknown }).code === DB_POOL_TIMEOUT ||
    e.message === 'Queue limit reached.' ||
    e.message === 'No connections available.'
  )
}

/** 池的当前计数（mysql2 的私有字段，与监控页读法相同；字段改名时只是显示为 ?）。 */
function poolStats(pool: Pool): string {
  const p = pool as unknown as {
    config?: { connectionLimit?: number }
    _allConnections?: unknown[]
    _freeConnections?: unknown[]
    _connectionQueue?: unknown[]
  }
  const n = (v: unknown[] | undefined) => v?.length ?? '?'
  return `limit=${p.config?.connectionLimit ?? '?'} total=${n(p._allConnections)} idle=${n(p._freeConnections)} queued=${n(p._connectionQueue)}`
}

/** mysql2 池内部排队（`lib/ring_queue.js`）里用到的两个方法。 */
interface WaitQueue {
  toArray(): unknown[]
  removeOne(index: number): unknown
}

type GetConnectionCallback = (err: NodeJS.ErrnoException | null, conn: PoolConnection) => void

/** 本模块包装过的取连接回调（带超时的那一层）。 */
const wrapped = new WeakSet<GetConnectionCallback>()

/**
 * 给 mysql2 连接池的取连接加超时（mysql2 不认 `acquireTimeout`，池满时回调会无限排队）。
 * 替换实例上的 `getConnection`：TypeORM 的回调调用、`pool.query` 与 `pool.promise()` 都经由它。
 * 超时后只回调一次带 `QW_DB_POOL_TIMEOUT` 的错误并记一条 warn，并把它移出池的排队；
 * 若仍有连接迟到分配给它，立即归还，不会泄漏。`timeoutMs <= 0` 时不做任何改动（不限时，保持 mysql2 原行为）。
 */
export function withAcquireTimeout(pool: Pool, timeoutMs: number): Pool {
  if (!(timeoutMs > 0)) return pool
  const original = pool.getConnection.bind(pool) as (cb: GetConnectionCallback) => void
  pool.getConnection = ((cb: GetConnectionCallback) => {
    // mysql2 归还连接时会经由 this.getConnection 把排队中的回调重新分派：那是已包装过的同一次等待，
    // 由第一层的计时器负责，不再包第二层（否则重复计时、重复记 warn，并多占排队名额）
    if (wrapped.has(cb)) {
      original(cb)
      return
    }
    let settled = false
    const onConnection: GetConnectionCallback = (err, conn) => {
      if (settled) {
        // 调用方已收到超时错误：迟到的连接还回池里，交给下一个排队者
        if (!err) conn.release()
        return
      }
      settled = true
      clearTimeout(timer)
      cb(err, conn)
    }
    wrapped.add(onConnection)
    const timer = setTimeout(() => {
      settled = true
      // 已放弃的等待者移出 mysql2 的排队（私有字段，读法同 poolStats），否则它继续占
      // DB_POOL_QUEUE_LIMIT 的名额、计入 queued；找不到（字段改名或回调被包装）时，迟到的连接仍会被立即归还
      const queue = (pool as unknown as { _connectionQueue?: Partial<WaitQueue> })._connectionQueue
      const at = queue?.toArray?.().indexOf(onConnection) ?? -1
      if (at >= 0) queue?.removeOne?.(at)
      const message = `database pool acquire timed out after ${timeoutMs} ms (${poolStats(pool)})`
      logger.warn(message)
      cb(Object.assign(new Error(message), { code: DB_POOL_TIMEOUT }), undefined as never)
    }, timeoutMs)
    original(onConnection)
  }) as Pool['getConnection']
  return pool
}
