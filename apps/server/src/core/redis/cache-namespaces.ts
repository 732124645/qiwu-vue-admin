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
}

const ns = (prefix: string, clearable: boolean, masked: boolean): CacheNamespace => ({
  prefix,
  clearable,
  masked,
})

export const CACHE_NAMESPACES = {
  /** session id → session JSON, until `absoluteExpAt` (at/rt keys point here; see docs/design-notes.md#auth-sessions) */
  authSession: ns('auth:sess:', false, true),
  /** access token hash → `{sid}` */
  authAccess: ns('auth:at:', false, true),
  /** refresh token hash → `{sid, at}` */
  authRefresh: ns('auth:rt:', false, true),
  /** rotated refresh token hash → encrypted new pair (30 s grace), then a replay tripwire */
  authRefreshGrace: ns('auth:rt:grace:', false, true),
  /** user id → every token-type key of the user (SessionRevoker) */
  authUser: ns('auth:user:', false, true),
  /** per-user ZSET: authorization code key → expiry (ms), pruned on insertion */
  authUserCodes: ns('auth:codes:', false, true),
  /** one ZSET: sid → expAt */
  authOnline: ns('auth:online', false, false),
  /** one ZSET: sid → last authenticated request (ms), for the online sessions list */
  authSeen: ns('auth:seen', false, false),
  /** user id / `all` → permission version */
  authPermVer: ns('auth:permver:', false, false),
  /** user id → revocation counter (SessionRevoker.revokeUser): a sign-in racing it cannot start a session */
  authCredVer: ns('auth:credver:', false, false),
  /**
   * failed sign-in counters: `p:{username}:{ip}` (lock), `u:{username}`, `ip:{ip}`; current-password
   * failures `cur:{userId}`; lock-screen rate limits `vp:u:{userId}`, `vp:ip:{ip}`
   */
  authFail: ns('auth:fail:', false, false),
  /** captcha answers and `ticket:{hash}` */
  captcha: ns('captcha:', true, true),
  smsLimit: ns('sms:limit:', true, false),
  /**
   * WeChat mini program sign-in: `code:{sha256}` → a spent `uni.login` code (single use),
   * `ticket:{sha256}` → a bind ticket's identity and IP (5 min, GETDEL); `token:{appid}` → the app's
   * access token (subscribe messages; a secret, masked). Not clearable: a cleared code could be replayed.
   */
  wxMp: ns('wxmp:', false, true),
  oauth2Code: ns('oauth2:code:', false, true),
  /** direct-upload grants */
  presign: ns('presign:', false, true),
  /** `entries:{code}` → a dict's payload (DictService) */
  dict: ns('dict:', true, false),
  /**
   * dict code → version, never cleared: the version checks racing fills, and a reset one could
   * climb back to the value a stale fill read. Clearing `dict` bumps them (DictService.invalidate).
   */
  dictVer: ns('dict:ver:', false, false),
  /** param key → `{value, isPublic}` (ParamService); may be a secret param's value */
  param: ns('param:', true, true),
  /** param key → version, never cleared (as `dictVer`) */
  paramVer: ns('param:ver:', false, false),
  /**
   * @Idempotent (core/guard/idempotent.ts): `{sid}:{sha256(method + url + canonical body [+ uploaded
   * file name and content])}` (`ip-{ip}` for a caller without a session) → the request's owner token
   */
  idem: ns('idem:', true, false),
  /** handler/IP digest + throttler name → rolling hits and block/reset timestamps */
  throttle: ns('throttle:', false, false),
  /** Excel import error reports: `{userId}:{id}` → base64 .xlsx (another user's rows), 30 min (core/excel) */
  excelReport: ns('excel:report:', true, true),
  lock: ns('lock:', false, false),
  jobLock: ns('job:lock:', false, false),
  jobFire: ns('job:fire:', false, false),
} as const satisfies Record<string, CacheNamespace>

export type CacheNamespaceName = keyof typeof CACHE_NAMESPACES

/** `REDIS_KEY_PREFIX` (validated by EnvSchema: word chars ending in `:`). */
export const keyPrefix = (): string => process.env.REDIS_KEY_PREFIX ?? 'qw:'

/**
 * `redisKey('authFail', username, ip)` → `qw:auth:fail:<username>:<ip>`. Parts are URI-encoded and
 * joined with `:`, so a client-supplied part (a username with `:`) can never forge another key shape.
 */
export const redisKey = (name: CacheNamespaceName, ...parts: (string | number)[]): string =>
  keyPrefix() +
  CACHE_NAMESPACES[name].prefix +
  parts.map((p) => encodeURIComponent(String(p))).join(':')

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

/** `SCAN MATCH` pattern for one namespace, or every key of this app (no argument). */
export const keyPattern = (name?: CacheNamespaceName): string =>
  `${keyPrefix()}${name ? CACHE_NAMESPACES[name].prefix : ''}*`
