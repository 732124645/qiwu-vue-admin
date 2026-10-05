import { z } from 'zod'
import { fieldDomains } from '../../validation/zod-i18n.js'

/**
 * Monitoring, `/api/monitor/*`, read-only dashboards but for the cache clean-up. Sizes
 * are bytes, durations seconds, `usage` a percentage 0–100. Field labels `field.monitor.<page>.<prop>`.
 *
 * - `GET /server` (`server`): `monitorServerVo` (systeminformation + `process`)
 * - `GET /redis` (`redis`): `monitorRedisVo` (`INFO`, `INFO commandstats`, `DBSIZE`)
 * - `GET /cache/namespaces` (`cache`): `cacheNamespaceVo[]`, the registry of `core/redis/cache-namespaces.ts`
 * - `GET /cache/keys?ns=` (`cache`): `cacheKeysQuery` → `cacheKeysVo` (SCAN, at most `CACHE_SCAN_MAX`)
 * - `GET /cache/value?key=` (`cache`): `cacheValueQuery` → `cacheValueVo`
 * - `DELETE /cache/keys?ns=` or `?key=` (`cacheClear`): `cacheClearQuery` → `cacheClearVo`
 * - `DELETE /cache/all-registered` (`cacheClear`): every clearable namespace → `cacheClearVo`
 * - `GET /mysql` (`mysql`): `monitorMysqlVo`
 *
 * Cache keys travel without the global `REDIS_KEY_PREFIX` (`dict:iam.gender`) and must fall in a
 * registered namespace; only `clearable` ones may be deleted (never `auth:*`), `masked` values are never
 * shown.
 */

export const monitorPerms = {
  server: 'monitor.server.browse',
  redis: 'monitor.redis.browse',
  cache: 'monitor.cache.browse',
  cacheClear: 'monitor.cache.remove',
  mysql: 'monitor.mysql.browse',
} as const

// ---- server ----

export const monitorServerVo = z.object({
  cpu: z.object({
    model: z.string(),
    cores: z.number().int(),
    usage: z.number(),
    /** 1, 5, 15 minutes (all 0 on Windows) */
    loadAvg: z.array(z.number()),
  }),
  mem: z.object({
    total: z.number(),
    used: z.number(),
    usage: z.number(),
  }),
  disks: z.array(
    z.object({
      mount: z.string(),
      fs: z.string(),
      type: z.string(),
      size: z.number(),
      used: z.number(),
      usage: z.number(),
    }),
  ),
  os: z.object({
    platform: z.string(),
    distro: z.string(),
    release: z.string(),
    arch: z.string(),
    hostname: z.string(),
    uptime: z.number(),
  }),
  node: z.object({ version: z.string(), v8: z.string() }),
  process: z.object({
    pid: z.number().int(),
    uptime: z.number(),
    rss: z.number(),
    heapTotal: z.number(),
    heapUsed: z.number(),
    external: z.number(),
  }),
})
export type MonitorServerVo = z.infer<typeof monitorServerVo>

// ---- redis ----

/** INFO sections the page may show (no `keyspace`: the instance is shared, see `keyspace` below). */
export const REDIS_INFO_SECTIONS = [
  'server',
  'clients',
  'memory',
  'persistence',
  'stats',
  'cpu',
] as const
export type RedisInfoSection = (typeof REDIS_INFO_SECTIONS)[number]

export const monitorRedisVo = z.object({
  /** section → raw `field → value`; the server may drop fields (paths, config file) */
  info: z.partialRecord(z.enum(REDIS_INFO_SECTIONS), z.record(z.string(), z.string())),
  /** `INFO commandstats`, by calls desc */
  commandStats: z.array(
    z.object({
      command: z.string(),
      calls: z.number().int(),
      usec: z.number(),
      usecPerCall: z.number(),
    }),
  ),
  /** this app's own db (`REDIS_DB`) only */
  keyspace: z.object({
    db: z.number().int(),
    keys: z.number().int(),
    expires: z.number().int(),
    /** ms */
    avgTtl: z.number(),
  }),
})
export type MonitorRedisVo = z.infer<typeof monitorRedisVo>

// ---- cache ----

/** Most keys one `GET /cache/keys` returns (SCAN stops there, `truncated` = more exist). */
export const CACHE_SCAN_MAX = 1000

export const cacheNamespaceVo = z.object({
  /** registry name, e.g. `dict` (page label `monitor.cache.ns.<name>`) */
  name: z.string(),
  /** after the global prefix, e.g. `dict:` */
  prefix: z.string(),
  clearable: z.boolean(),
  masked: z.boolean(),
})
export type CacheNamespaceVo = z.infer<typeof cacheNamespaceVo>

const nsName = z
  .string()
  .max(64)
  .regex(/^[a-zA-Z]\w*$/)
/** a key without the global prefix */
const cacheKey = z.string().trim().min(1).max(512)

export const cacheKeysQuery = z.object({ ns: nsName }).register(fieldDomains, {
  domain: 'monitor.cache',
})
export type CacheKeysQuery = z.infer<typeof cacheKeysQuery>

export const cacheKeysVo = z.object({ keys: z.array(z.string()), truncated: z.boolean() })
export type CacheKeysVo = z.infer<typeof cacheKeysVo>

export const cacheValueQuery = z.object({ key: cacheKey }).register(fieldDomains, {
  domain: 'monitor.cache',
})
export type CacheValueQuery = z.infer<typeof cacheValueQuery>

export const cacheValueVo = z.object({
  key: z.string(),
  /** Redis `TYPE`: string / hash / list / set / zset / … (`none` = gone) */
  type: z.string(),
  /** seconds; -1 = no expiry */
  ttl: z.number().int(),
  masked: z.boolean(),
  /** string, field map, member list…; null when masked or gone */
  value: z.unknown(),
})
export type CacheValueVo = z.infer<typeof cacheValueVo>

/** DELETE /cache/keys query: exactly one of `ns` (a whole namespace) or `key`; both or neither → 400. */
export const cacheClearQuery = z
  .object({ ns: nsName.optional(), key: cacheKey.optional() })
  .refine((q) => (q.ns === undefined) !== (q.key === undefined), { message: 'validation.invalid' })
  .register(fieldDomains, { domain: 'monitor.cache' })
export type CacheClearQuery = z.infer<typeof cacheClearQuery>

export const cacheClearVo = z.object({ deleted: z.number().int() })
export type CacheClearVo = z.infer<typeof cacheClearVo>

// ---- mysql ----

/** `SHOW GLOBAL STATUS` whitelist (the card shows nothing else). */
export const MYSQL_STATUS_KEYS = [
  'Uptime',
  'Threads_connected',
  'Threads_running',
  'Questions',
  'Slow_queries',
  'Innodb_buffer_pool_pages_total',
  'Innodb_buffer_pool_pages_free',
  'Innodb_buffer_pool_read_requests',
  'Innodb_buffer_pool_reads',
  'Bytes_received',
  'Bytes_sent',
] as const
/** `SHOW VARIABLES` whitelist. */
export const MYSQL_VARIABLE_KEYS = ['version', 'max_connections'] as const

export const monitorMysqlVo = z.object({
  status: z.partialRecord(z.enum(MYSQL_STATUS_KEYS), z.number()),
  variables: z.partialRecord(z.enum(MYSQL_VARIABLE_KEYS), z.string()),
  /** the app's connection pool (TypeORM / mysql2); null when not readable */
  pool: z
    .object({
      limit: z.number().int(),
      total: z.number().int(),
      idle: z.number().int(),
      queued: z.number().int(),
    })
    .nullable(),
})
export type MonitorMysqlVo = z.infer<typeof monitorMysqlVo>
