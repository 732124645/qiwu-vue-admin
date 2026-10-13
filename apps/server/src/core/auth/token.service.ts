import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import {
  DEFAULT_TENANT_ID,
  Err,
  FIRST_PARTY_CLIENTS,
  type FirstPartyClient,
  type Locale,
  OAUTH_REFRESH_TTL_MAX_SEC,
} from '@qiwu/shared'
import { AppConfigService } from '../config/config.module.js'
import { deriveKey, open, seal, type Sealed } from '../crypto/secret-box.js'
import { BizError } from '../http/biz-error.js'
import { redisKey } from '../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../redis/redis.module.js'
import type { PrincipalRole } from './principal.js'
import { ownerIndexKey, SessionRevoker } from './session-revoker.js'

/** The admin console's client id: its refresh token travels only as the HttpOnly cookie. */
export const CONSOLE_CLIENT = 'console' satisfies FirstPartyClient
/** The uni-app's client id: its refresh token travels in request/response bodies. */
export const MOBILE_CLIENT = 'mobile' satisfies FirstPartyClient
/** AuthGuard and the realtime gateway accept only these sessions outside `@OAuthScope` routes. */
export const isFirstParty = (clientId: string): boolean =>
  (FIRST_PARTY_CLIENTS as readonly string[]).includes(clientId)
/** A rotated refresh token replayed within this window by the same session and UA gets the same new pair. */
export const REFRESH_GRACE_MS = 30_000
/** Absolute session lifetime fixed at sign-in (see docs/design-notes.md#auth-sessions): no renewal or rotation goes past it. */
export const ABSOLUTE_MS = { keepSignedIn: 7 * 86_400_000, session: 12 * 3_600_000 } as const
/** The longest any session lives: keep-signed-in or an OAuth2 client's max refresh TTL. */
export const MAX_SESSION_MS = Math.max(ABSOLUTE_MS.keepSignedIn, OAUTH_REFRESH_TTL_MAX_SEC * 1000)

export interface SessionFlags {
  mustChangePassword: boolean
  passwordExpired: boolean
}

/** User facts cached in the session; reloaded whenever `permVer` changes (see docs/design-notes.md#permissions). */
export interface SessionUser {
  /** null only for client_credentials tokens: those never pass PermGuard */
  userId: number | null
  userType: string
  /** for logs and the online list; absent on client_credentials sessions */
  username?: string
  /** the dept's name (i18n key or text) */
  deptName?: string | null
  deptId: number | null
  deptTreePath: string | null
  /** enabled roles */
  roles: PrincipalRole[]
  /** union of the roles' perms; `['*']` for root */
  perms: string[]
  /** holds the builtin root role (Principal.root) */
  root?: boolean
  /** holds the builtin `tenant_admin` role (Principal.tenantAdmin) */
  tenantAdmin?: boolean
  /**
   * the user's own tenant (`iam_user.tenant_id`, Principal.tenantId); absent on sessions signed before it
   * was recorded: those are reloaded before use (SessionCurrent), never taken for the default tenant
   */
  tenantId?: number
  /** the end of the user's tenant (epoch ms) when it has one; the session ends with it */
  tenantExpAt?: number
  /**
   * the route names of the top-level menu groups the user's tenant package opens (`@RequireFeature`,
   * `/me.features`); absent = unrestricted (see docs/design-notes.md#tenancy)
   */
  features?: string[]
  locale: Locale | null
  /** `auth:permver:{userId}` + `auth:permver:all` when loaded (PermVersion) */
  permVer: string
}

/**
 * Token lifetimes of a third-party OAuth2 session, from its client's row: the access token
 * never slides, and `refreshMs` (from the grant) is also the session's absolute lifetime.
 */
export interface SessionTtl {
  accessMs: number
  refreshMs: number
}

/** Session JSON at `auth:sess:{sid}` (see docs/design-notes.md#auth-sessions); times are epoch ms. */
export interface Session extends SessionUser {
  sid: string
  clientId: string
  scopes: string[]
  /** computed at sign-in, cleared by the password change (AuthGuard gate) */
  flags: SessionFlags
  keepSignedIn: boolean
  ip: string
  ua: string
  loginAt: number
  absoluteExpAt: number
  /** third-party sessions only; absent = first-party (ACCESS_TTL_SEC / REFRESH_TTL_SEC, sliding) */
  ttl?: SessionTtl
  /**
   * set while a platform user works inside another tenant (see docs/design-notes.md#tenancy): that tenant
   * is the data tenant of every route but those running in the user's own (`@HomeTenant()`,
   * `@PlatformOnly()`); the user, perms and roles stay the user's own
   */
  actingTenantId?: number
  /** when the entered tenant is left at the latest */
  actingUntil?: number
}

/** A live session as the online list shows it (TokenService.online). */
export interface OnlineSession extends Session {
  /** refresh expiry (epoch ms), capped at `absoluteExpAt` */
  expiresAt: number
  /** last authenticated request or the sign-in (epoch ms); null when not recorded */
  lastSeenAt: number | null
}

export interface IssueOptions {
  keepSignedIn: boolean
  ip: string
  ua: string
  flags?: SessionFlags
  clientId?: string
  scopes?: string[]
  /** `credVersion(userId)` as read before the sign-in's last credential read: refused once it moved */
  credVer?: string
  /** third-party OAuth2 session lifetimes (replace keepSignedIn's absolute limit) */
  ttl?: SessionTtl
}

/**
 * An OAuth2 authorization code's entry (`oauth2:code:{sha256}`): indexed by expiry in
 * `auth:codes:{userId}` so `revokeUser` deletes it; session and client revocation leave it alone.
 */
export interface CodeEntry {
  /** the client's `client_id` */
  client: string
  /** `oauth_client.id`: a later client registered under the same `client_id` cannot redeem it */
  clientPk: number
  userId: number
  redirectUri: string
  scopes: string[]
  /** PKCE S256 challenge */
  challenge: string
  /** the user's credver when the code was issued: a revocation since then refuses the exchange */
  credVer: string
  /**
   * the user's own tenant (the approving session's): the exchange runs in it and refuses a user of
   * another; absent on codes issued before it was recorded, which belong to the default tenant
   */
  tenantId?: number
  /** epoch ms */
  exp: number
}

/** A live token as introspection sees it (RFC 7662): read only, renews nothing. */
export interface Inspected {
  session: Session
  kind: 'access' | 'refresh'
  /** epoch ms, capped at the session's `absoluteExpAt` */
  expiresAt: number
}

/** A new session and its first token pair. */
export type Issued = IssuedTokens & { session: Session }

export interface IssuedTokens {
  accessToken: string
  refreshToken: string
  /** access token lifetime, seconds */
  expiresIn: number
  /** refresh token lifetime, seconds (the refresh cookie's Max-Age when keepSignedIn) */
  refreshExpiresIn: number
}

export type RefreshOutcome =
  | { kind: 'rotated'; tokens: IssuedTokens; session: Session }
  /** unknown, expired or revoked token; `tenantUnavailable`: its session just ended with its tenant */
  | { kind: 'rejected'; tenantUnavailable?: true }
  /** a rotated token replayed after the grace window or from another UA: the whole session was revoked */
  | { kind: 'reused'; session: Session | null }

interface AccessEntry {
  sid: string
}
interface RefreshEntry {
  sid: string
  /** hash of the access token issued with it, deleted on rotation */
  at: string
}
/** Grace entry: the new pair, AES-256-GCM under a key only the old refresh token's holder can derive. */
interface GraceEntry extends Sealed {
  sid: string
  /** end of the grace window (epoch ms); afterwards the entry only detects replays */
  until: number
}

/** Revocation reason (and `session:kicked` reason) of a session whose tenant is no longer available. */
export const TENANT_UNAVAILABLE = 'tenant_unavailable'

/**
 * A session ended because its tenant is disabled, expired or multi-tenancy is off for it: answered 401
 * `A1042` (see docs/design-notes.md#tenancy).
 */
export class TenantUnavailable extends BizError {
  constructor() {
    super(Err.AUTH_TENANT_INACTIVE)
  }
}

/** What a refresh needs besides the token (AuthService). */
export interface RefreshOptions {
  /**
   * the tenant the request's host is bound to (null: none), asked only once a live session is found:
   * a session of another tenant is rejected untouched
   */
  expectTenant?: () => Promise<number | null>
  /** reloads the session before it rotates (SessionCurrent.current); null = ended */
  reload?: (session: Session) => Promise<Session | null>
}

const REJECTED = { kind: 'rejected' } as const
const newToken = () => randomBytes(32).toString('base64url')
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const secs = (ms: number) => Math.floor(ms / 1000)

/** HKDF(old refresh token, salt = sid, info bound to the UA): same sid + UA → same key. */
const graceKey = (refreshToken: string, sid: string, ua: string) =>
  deriveKey(refreshToken, sid, `qw-rt-grace:${sha256(ua)}`)

// Atomic rotation: consumes the refresh token only if it and its session still exist, so of two
// parallel refreshes exactly one rotates and the other finds the grace entry already in place.
// KEYS: rt, session, old at, grace, new at, new rt, owner index, online
// ARGV: grace JSON, grace ttl, at JSON, at ttl, rt JSON, rt ttl, sid, online score
const ROTATE = `
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
redis.call('DEL', KEYS[1], KEYS[3])
redis.call('SET', KEYS[4], ARGV[1], 'PX', ARGV[2])
redis.call('SET', KEYS[5], ARGV[3], 'PX', ARGV[4])
redis.call('SET', KEYS[6], ARGV[5], 'PX', ARGV[6])
redis.call('SREM', KEYS[7], KEYS[1], KEYS[3])
redis.call('SADD', KEYS[7], KEYS[4], KEYS[5], KEYS[6])
redis.call('ZADD', KEYS[8], ARGV[8], ARGV[7])
return 1`

// An OAuth2 authorization code, indexed by expiry for SessionRevoker.revokeUser.
// KEYS: code, code index · ARGV: entry JSON, ttl (ms), now, expiry; index TTL NX/GT like ISSUE
const SAVE_CODE = `
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[4], KEYS[1])
redis.call('PEXPIRE', KEYS[2], ARGV[2], 'NX')
redis.call('PEXPIRE', KEYS[2], ARGV[2], 'GT')
return 1`

// Atomic sign-in: refuses (0) when the user's credver moved since the sign-in read it (ARGV[10];
// '' = no check), i.e. SessionRevoker.revokeUser ran meanwhile; otherwise writes the session and its
// first pair, registers them in the owner index and the online and last-seen sets, and prunes both
// (last-seen entries older than MAX_SESSION_MS, ARGV[11], belong to sessions that expired).
// KEYS: session, at, rt, owner index, online, credver, seen
// ARGV: session JSON, session ttl, at JSON, at ttl, rt JSON, rt ttl, online score, sid, now, credver,
//       seen cutoff
const ISSUE = `
if ARGV[10] ~= '' and (redis.call('GET', KEYS[6]) or '0') ~= ARGV[10] then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[4])
redis.call('SET', KEYS[3], ARGV[5], 'PX', ARGV[6])
redis.call('SADD', KEYS[4], KEYS[1], KEYS[2], KEYS[3])
redis.call('PEXPIRE', KEYS[4], ARGV[2], 'NX')
redis.call('PEXPIRE', KEYS[4], ARGV[2], 'GT')
redis.call('ZADD', KEYS[5], ARGV[7], ARGV[8])
redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', ARGV[9])
redis.call('ZADD', KEYS[7], ARGV[9], ARGV[8])
redis.call('ZREMRANGEBYSCORE', KEYS[7], '-inf', ARGV[11])
return 1`

/**
 * Opaque access/refresh tokens with Redis as the only store (see docs/design-notes.md#auth-sessions). Tokens are 32 random bytes
 * (base64url); Redis holds only their sha256. `auth:sess:{sid}` holds the session JSON until
 * `absoluteExpAt`; `auth:at:{hash}` → `{sid}` (ACCESS_TTL_SEC, sliding), `auth:rt:{hash}` → `{sid, at}`
 * (REFRESH_TTL_SEC, rotated on use); every TTL is capped at `absoluteExpAt`. Every session or token
 * key is registered in `auth:user:{id}` for SessionRevoker; `auth:online` scores sid → refresh expiry.
 * Third-party OAuth2 sessions live by their client's lifetimes instead (`Session.ttl`, no
 * sliding); their authorization codes (`oauth2:code:{hash}`, single use) are indexed by expiry in
 * `auth:codes:{userId}`.
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly cfg: AppConfigService,
    private readonly revoker: SessionRevoker,
  ) {}

  private get accessMs() {
    return this.cfg.get('ACCESS_TTL_SEC') * 1000
  }

  private get refreshMs() {
    return this.cfg.get('REFRESH_TTL_SEC') * 1000
  }

  /** `auth:credver:{userId}` (SessionRevoker.revokeUser bumps it); a sign-in passes it to `issue`. */
  async credVersion(userId: number): Promise<string> {
    return (await this.redis.get(redisKey('authCredVer', userId))) ?? '0'
  }

  /**
   * Starts a session (sign-in) and returns its first token pair. With `credVer` it is atomic with a
   * check of the user's credver: null when it moved since it was read, i.e. the user's sessions were
   * revoked (password change/reset, disable) while this sign-in was in flight.
   */
  issue(user: SessionUser, opts: IssueOptions & { credVer: string }): Promise<Issued | null>
  issue(user: SessionUser, opts: IssueOptions): Promise<Issued>
  async issue(user: SessionUser, opts: IssueOptions): Promise<Issued | null> {
    // every user session names its tenant: a sign-in path that forgets it fails here, never defaults
    if (user.userId !== null && !Number.isSafeInteger(user.tenantId))
      throw new Error('TokenService.issue: a user session needs the tenant of its user')
    const now = Date.now()
    const session: Session = {
      ...user,
      sid: randomUUID(),
      clientId: opts.clientId ?? CONSOLE_CLIENT,
      scopes: opts.scopes ?? [],
      flags: opts.flags ?? { mustChangePassword: false, passwordExpired: false },
      keepSignedIn: opts.keepSignedIn,
      ip: opts.ip,
      ua: opts.ua,
      loginAt: now,
      // never past the tenant's end
      absoluteExpAt: Math.min(
        now +
          (opts.ttl?.refreshMs ??
            (opts.keepSignedIn ? ABSOLUTE_MS.keepSignedIn : ABSOLUTE_MS.session)),
        user.tenantExpAt ?? Infinity,
      ),
      ...(opts.ttl && { ttl: opts.ttl }),
    }
    const life = Math.max(session.absoluteExpAt - now, 1)
    const t = this.mint(session, now)
    const issued = await this.redis.eval(ISSUE, {
      keys: [
        redisKey('authSession', session.sid),
        t.atKey,
        t.rtKey,
        // the index lives as long as the owner's longest session: NX sets a first TTL, GT only extends
        ownerIndexKey(session),
        redisKey('authOnline'),
        // client_credentials sessions have no user: never checked (credVer is a sign-in's)
        redisKey('authCredVer', user.userId ?? 0),
        redisKey('authSeen'),
      ],
      arguments: [
        JSON.stringify(session),
        String(life),
        t.atValue,
        String(t.atMs),
        t.rtValue,
        String(t.rtMs),
        String(now + t.rtMs),
        session.sid,
        String(now),
        opts.credVer ?? '',
        String(now - MAX_SESSION_MS),
      ],
    })
    return issued === 1 ? { ...t.tokens, session } : null
  }

  /**
   * The session of a live access token, or null. Sliding renewal: when less than a third of the
   * access TTL is left it is extended again, never past `absoluteExpAt`; a third-party session's
   * (`ttl`) never is: its token keeps the `expires_in` it was issued with. Records the request
   * as the session's last-seen time (online list).
   */
  async authenticate(accessToken: string): Promise<Session | null> {
    const atKey = redisKey('authAccess', sha256(accessToken))
    const [raw, ttl] = await this.redis.multi().get(atKey).pTTL(atKey).exec()
    if (typeof raw !== 'string') return null
    const session = await this.live((JSON.parse(raw) as AccessEntry).sid)
    if (session === TENANT_UNAVAILABLE) throw new TenantUnavailable()
    const now = Date.now()
    if (!session) return null
    await Promise.all([
      this.redis.zAdd(redisKey('authSeen'), { score: now, value: session.sid }),
      !session.ttl &&
        Number(ttl) < this.accessMs / 3 &&
        this.redis.pExpire(atKey, Math.min(this.accessMs, session.absoluteExpAt - now), 'XX'),
    ])
    return session
  }

  /**
   * Every live session (online list): the `auth:online` members whose refresh has not
   * expired, with that expiry and the last-seen time. All of them in one MGET, fine for
   * thousands of sessions; page in Redis if an install ever keeps far more online.
   */
  async online(): Promise<OnlineSession[]> {
    const now = Date.now()
    const live = await this.redis.zRangeWithScores(redisKey('authOnline'), now, '+inf', {
      BY: 'SCORE',
    })
    if (!live.length) return []
    const sids = live.map((e) => String(e.value))
    const [raws, seen] = await Promise.all([
      this.redis.mGet(sids.map((sid) => redisKey('authSession', sid))),
      this.redis.zmScore(redisKey('authSeen'), sids),
    ])
    return live.flatMap(({ score }, i) => {
      const raw = raws[i]
      if (!raw) return []
      const session = JSON.parse(raw) as Session
      if (now >= session.absoluteExpAt || this.tenantEnded(session, now)) return []
      const last = seen[i]
      return [
        { ...session, expiresAt: Number(score), lastSeenAt: last == null ? null : Number(last) },
      ]
    })
  }

  /**
   * A live access or refresh token's session, kind and expiry (OAuth2 introspection and revocation,
   * RFC 7662/7009); null when unknown, rotated away, revoked or past `absoluteExpAt`. Read only: no
   * renewal, no last-seen write.
   */
  async inspect(token: string): Promise<Inspected | null> {
    const hash = sha256(token)
    for (const kind of ['access', 'refresh'] as const) {
      const key = redisKey(kind === 'access' ? 'authAccess' : 'authRefresh', hash)
      const [raw, ttl] = await this.redis.multi().get(key).pTTL(key).exec()
      if (typeof raw !== 'string') continue
      const session = await this.load((JSON.parse(raw) as AccessEntry).sid)
      if (!session) return null
      return { session, kind, expiresAt: Math.min(Date.now() + Number(ttl), session.absoluteExpAt) }
    }
    return null
  }

  /** Stores an authorization code (only its sha256) for `ttlMs`; prunes its user's code index. */
  async saveCode(code: string, entry: CodeEntry, ttlMs: number): Promise<void> {
    await this.redis.eval(SAVE_CODE, {
      keys: [redisKey('oauth2Code', sha256(code)), redisKey('authUserCodes', entry.userId)],
      arguments: [JSON.stringify(entry), String(ttlMs), String(Date.now()), String(entry.exp)],
    })
  }

  /**
   * Consumes an authorization code: GETDEL, so of two concurrent exchanges exactly one gets the entry.
   * The expiry index keeps the dead member until the next insertion prunes it or its TTL expires.
   */
  async takeCode(code: string): Promise<CodeEntry | null> {
    const raw = await this.redis.getDel(redisKey('oauth2Code', sha256(code)))
    return raw ? (JSON.parse(raw) as CodeEntry) : null
  }

  /**
   * Current session JSON by id: null once past `absoluteExpAt`, revoked, or ended with its tenant (`live`).
   */
  async load(sid: string): Promise<Session | null> {
    const session = await this.live(sid)
    return session === TENANT_UNAVAILABLE ? null : session
  }

  /**
   * The session, unless it ended: past `absoluteExpAt` (null) or with its tenant (TENANT_UNAVAILABLE,
   * revoked here; see docs/design-notes.md#tenancy). Every use of a session passes here: requests,
   * refresh, introspection, sockets. Only what the session itself holds is checked (the switch and the
   * tenant end it was loaded with); the tenant row is read when the user is (SessionCurrent).
   */
  async live(sid: string): Promise<Session | null | typeof TENANT_UNAVAILABLE> {
    const raw = await this.redis.get(redisKey('authSession', sid))
    if (!raw) return null
    const session = JSON.parse(raw) as Session
    const now = Date.now()
    if (this.tenantEnded(session, now)) {
      await this.revoker.revokeSession(sid, TENANT_UNAVAILABLE)
      return TENANT_UNAVAILABLE
    }
    return now >= session.absoluteExpAt ? null : session
  }

  /**
   * Multi-tenancy is off and the session is of another tenant than the default one, or its tenant's end
   * passed. A session that does not name its tenant is not judged: it is reloaded first.
   */
  private tenantEnded(s: Session, now: number): boolean {
    return (
      (s.tenantId !== undefined &&
        s.tenantId !== DEFAULT_TENANT_ID &&
        !this.cfg.get('APP_MULTI_TENANT')) ||
      (s.tenantExpAt !== undefined && now >= s.tenantExpAt)
    )
  }

  /** The session a live refresh token belongs to; null when unknown, rotated away or expired. */
  async sidOfRefresh(refreshToken: string): Promise<string | null> {
    const raw = await this.redis.get(redisKey('authRefresh', sha256(refreshToken)))
    return raw ? (JSON.parse(raw) as RefreshEntry).sid : null
  }

  /** Writes back a changed session (reloaded perms, cleared flags); never revives a revoked one. */
  async save(session: Session): Promise<boolean> {
    const res = await this.redis.set(
      redisKey('authSession', session.sid),
      JSON.stringify(session),
      { condition: 'XX', expiration: 'KEEPTTL' },
    )
    return res === 'OK'
  }

  /**
   * Rotates a refresh token (see docs/design-notes.md#auth-sessions). A token already rotated within REFRESH_GRACE_MS, replayed by
   * the same session and UA, gets the same new pair again (parallel tabs); replayed later or from
   * another UA it revokes the whole session (`reused`: the caller logs `refresh_reuse`). A token of
   * a session of another client than `clientId` (the channel it came in: cookie = console, body =
   * mobile), or of another tenant than `opts.expectTenant`, is `rejected` untouched: neither rotated nor
   * revoked. The session is reloaded first (`opts.reload`), so it rotates with its current facts.
   */
  async refresh(
    refreshToken: string,
    ua: string,
    clientId: string = CONSOLE_CLIENT,
    opts: RefreshOptions = {},
  ): Promise<RefreshOutcome> {
    const hash = sha256(refreshToken)
    const rtKey = redisKey('authRefresh', hash)
    const graceKeyName = redisKey('authRefreshGrace', hash)
    const raw = await this.redis.get(rtKey)
    if (raw) {
      const entry = JSON.parse(raw) as RefreshEntry
      const session = await this.refreshable(entry.sid, clientId, opts)
      if ('kind' in session) return session
      const now = Date.now()
      const t = this.mint(session, now)
      const grace = this.seal(refreshToken, session.sid, ua, t.tokens, now + REFRESH_GRACE_MS)
      const rotated = await this.redis.eval(ROTATE, {
        keys: [
          rtKey,
          redisKey('authSession', session.sid),
          redisKey('authAccess', entry.at),
          graceKeyName,
          t.atKey,
          t.rtKey,
          ownerIndexKey(session),
          redisKey('authOnline'),
        ],
        arguments: [
          JSON.stringify(grace),
          // kept as a replay tripwire for as long as the session could live
          String(session.absoluteExpAt - now),
          t.atValue,
          String(t.atMs),
          t.rtValue,
          String(t.rtMs),
          session.sid,
          String(now + t.rtMs),
        ],
      })
      if (rotated === 1) return { kind: 'rotated', tokens: t.tokens, session }
      // lost the race to a parallel refresh of the same token: its grace entry answers below
    }
    const graceRaw = await this.redis.get(graceKeyName)
    if (!graceRaw) return REJECTED
    const grace = JSON.parse(graceRaw) as GraceEntry
    const session = await this.refreshable(grace.sid, clientId, opts)
    if ('kind' in session) return session
    const tokens = await this.unseal(refreshToken, ua, grace)
    if (tokens) return { kind: 'rotated', tokens, session }
    await this.revoker.revokeSession(grace.sid, 'refresh_reuse')
    return { kind: 'reused', session }
  }

  /** The session a refresh may rotate (see `refresh`), else what the refresh answers. */
  private async refreshable(
    sid: string,
    clientId: string,
    opts: RefreshOptions,
  ): Promise<Session | Extract<RefreshOutcome, { kind: 'rejected' }>> {
    const live = await this.live(sid)
    if (live === TENANT_UNAVAILABLE) return { kind: 'rejected', tenantUnavailable: true }
    if (!live || live.clientId !== clientId) return REJECTED
    let session: Session | null = live
    try {
      if (opts.reload) session = await opts.reload(live)
    } catch (e) {
      if (e instanceof TenantUnavailable) return { kind: 'rejected', tenantUnavailable: true }
      throw e
    }
    if (!session) return REJECTED
    const expected = opts.expectTenant ? await opts.expectTenant() : null
    return expected !== null && session.tenantId !== expected ? REJECTED : session
  }

  /**
   * The live pair behind a grace entry: when the sealed pair was itself rotated since (R0 → R1 → R2
   * within the window), follows the chain with each unsealed refresh token. null = outside the
   * window or another UA.
   */
  private async unseal(
    refreshToken: string,
    ua: string,
    grace: GraceEntry,
  ): Promise<IssuedTokens | null> {
    // bounded: each hop is a rotation of the same session within one grace window
    for (let hop = 0; hop < 8; hop++) {
      const tokens = Date.now() <= grace.until ? this.open(refreshToken, ua, grace) : null
      if (!tokens) return null
      const hash = sha256(tokens.refreshToken)
      if (await this.redis.exists(redisKey('authRefresh', hash))) return tokens
      const next = await this.redis.get(redisKey('authRefreshGrace', hash))
      if (!next) return null
      refreshToken = tokens.refreshToken
      grace = JSON.parse(next) as GraceEntry
    }
    return null
  }

  /**
   * A new token pair for `session` at `now`, with TTLs capped at `absoluteExpAt`; a third-party
   * session's from its `ttl`, first-party ones' from the env.
   */
  private mint(session: Session, now: number) {
    const left = session.absoluteExpAt - now
    const accessToken = newToken()
    const refreshToken = newToken()
    const atHash = sha256(accessToken)
    const atMs = Math.min(session.ttl?.accessMs ?? this.accessMs, left)
    const rtMs = Math.min(session.ttl?.refreshMs ?? this.refreshMs, left)
    return {
      atKey: redisKey('authAccess', atHash),
      atValue: JSON.stringify({ sid: session.sid } satisfies AccessEntry),
      atMs,
      rtKey: redisKey('authRefresh', sha256(refreshToken)),
      rtValue: JSON.stringify({ sid: session.sid, at: atHash } satisfies RefreshEntry),
      rtMs,
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: secs(atMs),
        refreshExpiresIn: secs(rtMs),
      } satisfies IssuedTokens,
    }
  }

  private seal(
    refreshToken: string,
    sid: string,
    ua: string,
    tokens: IssuedTokens,
    until: number,
  ): GraceEntry {
    return { sid, until, ...seal(graceKey(refreshToken, sid, ua), JSON.stringify(tokens), sid) }
  }

  /** The sealed pair, or null when the key does not match (another UA). */
  private open(refreshToken: string, ua: string, g: GraceEntry): IssuedTokens | null {
    const pt = open(graceKey(refreshToken, g.sid, ua), g, g.sid)
    return pt == null ? null : (JSON.parse(pt) as IssuedTokens)
  }
}
