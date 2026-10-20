import type { CacheKeyTenancy } from '@qiwu/shared'
import { tenantId } from '../context/tenant.js'

/**
 * Redis key registry and the ONLY key builder: every key is
 * `REDIS_KEY_PREFIX` (`qw:`; the Redis ACL user may only touch `qw:*`) + a namespace + parts.
 * The cache monitor lists these namespaces; `scripts/arch/redis-keys.mjs` rejects literal keys.
 */
export interface CacheNamespace {
  /** after the global prefix, e.g. `auth:at:` */
  prefix: string
  /** the cache monitor may delete its keys (never `auth:*`: sessions end only via SessionRevoker) */
  clearable: boolean
  /**
   * values the cache monitor never shows: secrets (token pairs, answers, secret params, grants) or other
   * users' private data (import error reports). Unmasked ones hold only counters, versions, timestamps,
   * holder tokens of locks and duplicate guards, and dict payloads any signed-in user reads anyway.
   */
  masked: boolean
  /**
   * What its keys are built from (see docs/design-notes.md#tenancy). `tenant`: natural keys unique
   * within a tenant only (usernames, mobiles, emails, codes, names); `redisKey` and `keyPattern` put
   * `t:{tenantId}:` right after the prefix, from the context's tenant (the default tenant's too; none,
   * or inside `allTenants`, throws), so callers never add it. `global-id`: values unique across tenants
   * (session ids, token or content hashes, global numeric ids, AppIDs), a dimension every tenant shares
   * on purpose, or a tenant segment of its own. `platform`: data every tenant shares.
   */
  tenancy: CacheKeyTenancy
}

const ns = (
  prefix: string,
  clearable: boolean,
  masked: boolean,
  tenancy: CacheKeyTenancy,
): CacheNamespace => ({ prefix, clearable, masked, tenancy })

export const CACHE_NAMESPACES = {
  /** session id → session JSON, until `absoluteExpAt` (at/rt keys point here; see docs/design-notes.md#auth-sessions) */
  authSession: ns('auth:sess:', false, true, 'global-id'),
  /** access token hash → `{sid}` */
  authAccess: ns('auth:at:', false, true, 'global-id'),
  /** refresh token hash → `{sid, at}` */
  authRefresh: ns('auth:rt:', false, true, 'global-id'),
  /** rotated refresh token hash → encrypted new pair (30 s grace), then a replay tripwire */
  authRefreshGrace: ns('auth:rt:grace:', false, true, 'global-id'),
  /** user id → every token-type key of the user (SessionRevoker) */
  authUser: ns('auth:user:', false, true, 'global-id'),
  /** per-user ZSET: authorization code key → expiry (ms), pruned on insertion */
  authUserCodes: ns('auth:codes:', false, true, 'global-id'),
  /** one ZSET: sid → expAt */
  authOnline: ns('auth:online', false, false, 'global-id'),
  /** one ZSET: sid → last authenticated request (ms), for the online sessions list */
  authSeen: ns('auth:seen', false, false, 'global-id'),
  /** user id / `all` → permission version */
  authPermVer: ns('auth:permver:', false, false, 'global-id'),
  /** user id → revocation counter (SessionRevoker.revokeUser): a sign-in racing it cannot start a session */
  authCredVer: ns('auth:credver:', false, false, 'global-id'),
  /** `{sid}:{actingUntil}` → 1 for 60 s: the stay in another tenant whose leave is logged (TenantActing) */
  authActingLeave: ns('auth:acting-leave:', false, false, 'global-id'),
  /**
   * failed sign-in counters: `p:{username}:{ip}` (lock), `u:{username}`, `ip:{ip}`, and for tenant codes
   * other than the default one `tp:{code}:{username}:{ip}`, `tu:{code}:{username}`; current-password
   * failures `cur:{userId}`; lock-screen rate limits `vp:u:{userId}`, `vp:ip:{ip}`. `global-id` though
   * usernames are natural keys: the sign-in counts before (and whether or not) a tenant is resolved, so
   * the tenant code is a segment of its own (core/auth `failKeys`); no precedent for other namespaces.
   */
  authFail: ns('auth:fail:', false, false, 'global-id'),
  /** captcha answers and `ticket:{hash}` */
  captcha: ns('captcha:', true, true, 'global-id'),
  /** by mobile number and IP across tenants on purpose: the limits protect the number's owner */
  smsLimit: ns('sms:limit:', true, false, 'global-id'),
  /**
   * WeChat mini program sign-in: `code:{sha256}` → a spent `uni.login` code (single use),
   * `ticket:{sha256}` → a bind ticket's identity and IP (5 min, GETDEL); `token:{appid}` → the app's
   * access token (subscribe messages; a secret, masked). Not clearable: a cleared code could be replayed.
   */
  wxMp: ns('wxmp:', false, true, 'global-id'),
  /** WeChat Official Account tokens, callback bindings and sync caches; ids are shared across tenants. */
  wxoa: ns('wxoa:', false, true, 'global-id'),
  oauth2Code: ns('oauth2:code:', false, true, 'global-id'),
  /** direct-upload grants */
  presign: ns('presign:', false, true, 'global-id'),
  /** `entries:{code}` → a dict's payload (DictService) */
  dict: ns('dict:', true, false, 'platform'),
  /**
   * dict code → version, never cleared: the version checks racing fills, and a reset one could
   * climb back to the value a stale fill read. Clearing `dict` bumps them (DictService.invalidate).
   */
  dictVer: ns('dict:ver:', false, false, 'platform'),
  /** param key → `{value, isPublic}` (ParamService); may be a secret param's value */
  param: ns('param:', true, true, 'platform'),
  /** param key → version, never cleared (as `dictVer`) */
  paramVer: ns('param:ver:', false, false, 'platform'),
  /**
   * @Idempotent (core/guard/idempotent.ts): `{sid}:{sha256(method + url + canonical body [+ uploaded
   * file name and content])}` (`ip-{ip}` for a caller without a session) → the request's owner token
   */
  idem: ns('idem:', true, false, 'global-id'),
  /** handler/IP digest + throttler name → rolling hits and block/reset timestamps */
  throttle: ns('throttle:', false, false, 'platform'),
  /** Excel import error reports: `{userId}:{id}` → base64 .xlsx (another user's rows), 30 min (core/excel) */
  excelReport: ns('excel:report:', true, true, 'global-id'),
  /**
   * RedisLock keys by global ids (a lock by a natural key unique within a tenant gets a `tenant`
   * namespace of its own)
   */
  lock: ns('lock:', false, false, 'global-id'),
  jobLock: ns('job:lock:', false, false, 'platform'),
  jobFire: ns('job:fire:', false, false, 'platform'),
  /**
   * BullMQ queues (core/queue): `{queue}:{job id}`, `{queue}:wait`, `{queue}:events`, … built by BullMQ
   * under `queuePrefix()`. One queue holds every tenant's jobs, each naming its tenant in its data; job
   * ids are BullMQ's counters, or custom ids that QueueService.add prefixes with the adding tenant
   * (`t{tenantId}-`), so they are unique across tenants. Not clearable (BullMQ keeps its own state across these keys),
   * masked (a job's data may be any tenant's).
   */
  queue: ns('queue:', false, true, 'global-id'),
} as const satisfies Record<string, CacheNamespace>

export type CacheNamespaceName = keyof typeof CACHE_NAMESPACES

/** `REDIS_KEY_PREFIX` (validated by EnvSchema: word chars ending in `:`). */
export const keyPrefix = (): string => process.env.REDIS_KEY_PREFIX ?? 'qw:'

/** BullMQ's `prefix` option (`qw:queue`): BullMQ adds `:{queue}:…`, so every key falls in `queue`. */
export const queuePrefix = (): string => keyPrefix() + CACHE_NAMESPACES.queue.prefix.slice(0, -1)

const namespace = (name: CacheNamespaceName): CacheNamespace => CACHE_NAMESPACES[name]

/** The namespace's prefix, with the context's tenant segment for a `tenant` one (throws without one). */
const head = (n: CacheNamespace): string =>
  n.tenancy === 'tenant' ? `${n.prefix}t:${tenantId()}:` : n.prefix

/**
 * `redisKey('authFail', username, ip)` → `qw:auth:fail:<username>:<ip>`. Parts are URI-encoded and
 * joined with `:`, so a client-supplied part (a username with `:`) can never forge another key shape.
 * A `tenant` namespace's keys get the context's tenant segment first (`CacheNamespace.tenancy`).
 */
export const redisKey = (name: CacheNamespaceName, ...parts: (string | number)[]): string =>
  keyPrefix() + head(namespace(name)) + parts.map((p) => encodeURIComponent(String(p))).join(':')

/** A key part as `redisKey` was given it (URI-decoded); undefined when no `redisKey` call built it. */
export function keyPart(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

/**
 * Pub/sub channels: prefixed like keys (the Redis ACL user may only use `&qw:*`), not keys, so not in
 * the cache monitor. `job:sync`: task ids whose schedule changed (JobScheduler, one message per write).
 */
const CHANNELS = { jobSync: 'job:sync', socketIo: 'socket.io' } as const

/** Pub/sub ignores SELECT: deployments on different Redis databases must use different channels. */
export const redisChannel = (name: keyof typeof CHANNELS): string =>
  `${keyPrefix()}${CHANNELS[name]}:${Number(process.env.REDIS_DB ?? 0)}`

/**
 * `SCAN MATCH` pattern for one namespace (a `tenant` one: the context's tenant's keys only), or every
 * key of this app (no argument).
 */
export const keyPattern = (name?: CacheNamespaceName): string =>
  `${keyPrefix()}${name ? head(namespace(name)) : ''}*`

/** `SCAN MATCH` pattern for every tenant's keys of one namespace: the cache monitor for root. */
export const keyPatternAllTenants = (name: CacheNamespaceName): string =>
  `${keyPrefix()}${namespace(name).prefix}*`
