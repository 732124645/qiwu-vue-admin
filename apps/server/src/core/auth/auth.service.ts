import { Inject, Injectable } from '@nestjs/common'
import {
  Err,
  type ErrorDef,
  type FirstPartyClient,
  type LoginBody,
  type MenuNode,
  type MePayload,
  type PasswordPolicy,
} from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import { AuditWriter, type SigninLogEntry } from '../audit/audit-writer.js'
import { CaptchaTicketVerifier } from '../captcha/captcha-ticket.js'
import { CaptchaService } from '../captcha/captcha.service.js'
import { AppConfigService } from '../config/config.module.js'
import { demoMode } from '../config/demo-mode.js'
import { BizError } from '../http/biz-error.js'
import { redisKey } from '../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../redis/redis.module.js'
import { AuthParams, isBlocked, smsIpBucket } from './auth-params.js'
import { withFeatures } from './menu-features.js'
import { FAKE_HASH } from './password-hash.js'
import { PermVersion } from './perm-version.js'
import type { Principal } from './principal.js'
import { SessionRevoker } from './session-revoker.js'
import {
  CONSOLE_CLIENT,
  type IssuedTokens,
  type RefreshOutcome,
  type SessionFlags,
  TokenService,
} from './token.service.js'
import { USER_LOOKUP, type UserLookup } from './user-lookup.js'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** Lock-screen checks per minute, per user and per client IP (IPv6 by /64, as the SMS limits). */
const VERIFY_PER_MINUTE = { user: 20, ip: 60 }

/** The caller as the sign-in endpoints see it (`ip` after `trust proxy`). */
export interface Client {
  ip: string
  ua: string
}

/**
 * A sign-in that also binds an identity (WeChat mini program): its sign-in log kind,
 * and the write run once the credentials are proven, right before the session is issued (its error,
 * e.g. a 409, ends the sign-in, logged as `signin.bind_refused`). `proof` is what the sign-in rests
 * on, for the write to re-check atomically with itself: a password change or a disable racing the
 * sign-in then makes it write nothing.
 */
export interface SignInVia {
  kind: 'wx-mp'
  beforeIssue: (userId: number, proof: { passwordHash: string } | null) => Promise<void>
}

/** Sign-in log message of a sign-in whose `SignInVia.beforeIssue` threw after the credentials were proven. */
const BIND_REFUSED = 'signin.bind_refused'

/** The caller plus the client id of its session (sign-in log rows of session events). */
const withClient = (client: Client, p: Principal) => ({
  ...client,
  clientId: p.clientId ?? CONSOLE_CLIENT,
})

/** `mustChangePassword`: never changed (seeded/initial password); `passwordExpired`: older than the policy allows. */
export function passwordFlags(
  changedAt: Date | null,
  policy: PasswordPolicy,
  now = Date.now(),
): SessionFlags {
  return {
    mustChangePassword: changedAt === null,
    passwordExpired:
      changedAt !== null &&
      policy.expireDays > 0 &&
      now - changedAt.getTime() >= policy.expireDays * DAY_MS,
  }
}

/**
 * Failed sign-in counters (see docs/design-notes.md#auth-sessions, #security) keyed by the account's stored username when it exists
 * (the column collation is case- and accent-insensitive: `ALICE`/`alíce` reach `alice` and must share
 * its counters), else by the typed one; lower-cased either way. `pair` locks one username+IP pair
 * (others, and the same user elsewhere, can still sign in), `user` counts across IPs per hour (at
 * `auth.cross_ip_threshold` the username needs a captcha ticket, even with captcha.mode off), `ip`
 * counts per IP per hour. The pair key has its own `p` segment so no username (`u`, `ip`) can alias
 * the other two shapes.
 */
const failKeys = (username: string, ip: string) => {
  const u = username.toLowerCase()
  return {
    pair: redisKey('authFail', 'p', u, ip),
    user: redisKey('authFail', 'u', u),
    ip: redisKey('authFail', 'ip', ip),
  }
}
type FailKeys = ReturnType<typeof failKeys>

/** Password sign-in (see docs/design-notes.md#auth-sessions); tokens and sessions are TokenService's, revocation SessionRevoker's. */
@Injectable()
export class AuthService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(USER_LOOKUP) private readonly lookup: UserLookup,
    private readonly permVersion: PermVersion,
    private readonly tokens: TokenService,
    private readonly params: AuthParams,
    private readonly audit: AuditWriter,
    private readonly captcha: CaptchaService,
    private readonly captchaTickets: CaptchaTicketVerifier,
    private readonly revoker: SessionRevoker,
    private readonly cfg: AppConfigService,
  ) {}

  /**
   * Look up the stored username for counter keys → ticket gate (mode or cross-IP failures) → IP
   * blacklist → username+IP lock → bcrypt (fake hash for unknown, disabled or deleted users) →
   * failure counters or, on success, reset + session + `last_login_*` + sign-in log. A required
   * ticket is spent before the password check; a refused ticket changes no failure counters.
   * Every credential failure answers the same `bad_credentials`. `via`: a sign-in that also binds.
   */
  async login(
    body: LoginBody,
    client: Client,
    timezone: string | null,
    via?: SignInVia,
  ): Promise<IssuedTokens> {
    const { username, password } = body
    const clientId = body.clientId ?? CONSOLE_CLIENT
    const log = (
      e: Pick<SigninLogEntry, 'userId' | 'ok' | 'msgKey' | 'msgParams'> & { userType?: string },
      kind: SigninLogEntry['kind'] = via?.kind ?? 'password',
    ) =>
      this.audit.signin({
        userType: cred?.userType ?? 'admin',
        ...e,
        kind,
        username,
        clientId,
        ...client,
      })

    const { security, policy, blocked } = await this.params.load()
    // Look up before the gates so every spelling of an existing account shares its counters.
    const cred = await this.lookup.findCredentials({ username })
    const keys = failKeys(cred?.username ?? username, client.ip)
    if (
      ((await this.captcha.mode()) !== 'off' ||
        Number(await this.redis.get(keys.user)) >= security.crossIpThreshold) &&
      !(await this.captchaTickets.verify('signin', client.ip, body.captchaTicket))
    ) {
      log({ userId: cred?.userId ?? null, ok: false, msgKey: 'signin.captcha_required' })
      throw new BizError(Err.AUTH_CAPTCHA_REQUIRED)
    }
    if (isBlocked(blocked, client.ip)) {
      log({ userId: null, ok: false, msgKey: 'signin.ip_blocked' })
      throw new BizError(Err.AUTH_IP_BLOCKED)
    }
    const locked = {
      userId: cred?.userId ?? null,
      ok: false,
      msgKey: 'signin.locked',
      msgParams: { minutes: security.lockMinutes },
    }
    if (Number(await this.redis.get(keys.pair)) >= security.lockThreshold) {
      log(locked, 'locked')
      throw new BizError(Err.AUTH_LOCKED)
    }

    const live = cred?.enabled ? cred : null
    const match = await bcrypt.compare(password, live?.passwordHash ?? FAKE_HASH)
    const user = match && live ? await this.permVersion.load(live.userId) : null
    if (!live || !user) {
      const reason = !cred ? 'unknown_user' : !cred.enabled ? 'disabled' : 'bad_password'
      log({ userId: cred?.userId ?? null, ok: false, msgKey: `signin.${reason}` })
      if ((await this.countFailure(keys, security.lockMinutes)) >= security.lockThreshold) {
        log(locked, 'locked')
        throw new BizError(Err.AUTH_LOCKED)
      }
      throw new BizError(Err.AUTH_BAD_CREDENTIALS)
    }

    // A password change/reset or disable racing this sign-in commits first, then
    // SessionRevoker.revokeUser bumps credver and ends the sessions. credver is read BEFORE the
    // credentials are read again: a change committed before that read shows here (another hash, or
    // disabled); one committed after it moves credver, so issue() refuses, or else the session
    // existed before the revocation and was ended by it. Not counted as a failure: nothing was guessed.
    const credVer = await this.tokens.credVersion(live.userId)
    const again = await this.lookup.findCredentials({ userId: live.userId })
    const now = new Date()
    const current = again?.enabled === true && again.passwordHash === live.passwordHash
    // a refused bind (409, or the proof gone meanwhile) is a failed sign-in of this user
    if (current)
      await via?.beforeIssue(live.userId, { passwordHash: live.passwordHash }).catch((e) => {
        log({ userId: live.userId, ok: false, msgKey: BIND_REFUSED })
        throw e
      })
    const issued = current
      ? await this.tokens.issue(user, {
          keepSignedIn: body.keepSignedIn ?? false,
          ip: client.ip,
          ua: client.ua,
          flags: passwordFlags(live.passwordChangedAt, policy, now.getTime()),
          clientId,
          credVer,
        })
      : null
    if (!issued) {
      log({ userId: live.userId, ok: false, msgKey: 'signin.credentials_changed' })
      throw new BizError(Err.AUTH_BAD_CREDENTIALS)
    }
    await this.redis.del([keys.pair, keys.user, redisKey('authFail', 'cur', live.userId)])
    await this.lookup.recordSignIn(live.userId, { ip: client.ip, at: now, timezone })
    log({ userId: live.userId, userType: issued.session.userType, ok: true, msgKey: 'signin.ok' })
    return issued
  }

  /**
   * Sign-in of a user a module already proved (a consumed SMS code, a bound WeChat identity; see docs/design-notes.md#auth-sessions):
   * IP blacklist → credver read before the user (a racing reset or disable then makes issue() refuse) →
   * live, enabled user → `beforeIssue` (SignInVia) → session with the same password flags as a password
   * sign-in → `last_login_*` + sign-in log. Every refusal after the blacklist answers `refused` (default
   * `sms_code_invalid`, like a wrong code: accounts stay unknown). `label` is the log's username while
   * the user is unknown (a masked mobile).
   */
  async signInVerified(
    userId: number,
    opts: {
      kind: 'sms' | 'wx-mp'
      keepSignedIn?: boolean
      timezone: string | null
      label: string
      clientId?: FirstPartyClient
      refused?: ErrorDef
      beforeIssue?: (userId: number) => Promise<void>
    },
    client: Client,
  ): Promise<IssuedTokens> {
    const refused = opts.refused ?? Err.AUTH_SMS_CODE_INVALID
    const clientId = opts.clientId ?? CONSOLE_CLIENT
    const log = (
      ok: boolean,
      msgKey: string,
      username: string,
      id: number | null,
      userType: string,
    ) =>
      this.audit.signin({
        kind: opts.kind,
        userId: id,
        userType,
        username,
        clientId,
        ...client,
        ok,
        msgKey,
      })
    const { policy, blocked } = await this.params.load()
    if (isBlocked(blocked, client.ip)) {
      log(false, 'signin.ip_blocked', opts.label, null, 'admin')
      throw new BizError(Err.AUTH_IP_BLOCKED)
    }
    const credVer = await this.tokens.credVersion(userId)
    const cred = await this.lookup.findCredentials({ userId })
    const username = cred?.username ?? opts.label
    if (!cred?.enabled) {
      // the reason for the log reader; the caller gets the same answer as for a wrong code
      log(
        false,
        cred ? 'signin.disabled' : 'signin.unknown_user',
        username,
        cred?.userId ?? null,
        cred?.userType ?? 'admin',
      )
      throw new BizError(refused)
    }
    const user = await this.permVersion.load(userId)
    const now = new Date()
    if (user)
      await opts.beforeIssue?.(userId).catch((e) => {
        log(false, BIND_REFUSED, username, userId, cred.userType)
        throw e
      })
    const issued = user
      ? await this.tokens.issue(user, {
          keepSignedIn: opts.keepSignedIn ?? false,
          ip: client.ip,
          ua: client.ua,
          flags: passwordFlags(cred.passwordChangedAt, policy, now.getTime()),
          clientId,
          credVer,
        })
      : null
    if (!issued) {
      log(false, 'signin.credentials_changed', username, userId, cred.userType)
      throw new BizError(refused)
    }
    // like a password sign-in: a proven sign-in clears the current-password counter (see docs/design-notes.md#auth-sessions)
    await this.redis.del(redisKey('authFail', 'cur', userId))
    await this.lookup.recordSignIn(userId, { ip: client.ip, at: now, timezone: opts.timezone })
    log(true, 'signin.ok', cred.username, userId, issued.session.userType)
    return issued
  }

  /**
   * Rotates the refresh token (grace for the same sid + UA, replay revokes the chain, never
   * past `absoluteExpAt`; see docs/design-notes.md#auth-sessions). A replay is logged as `refresh_reuse`. `clientId` is the channel the token
   * came in (cookie = console, body = mobile): a token of another client's session is refused.
   */
  async refresh(
    refreshToken: string,
    client: Client,
    clientId: FirstPartyClient,
  ): Promise<RefreshOutcome> {
    const out = await this.tokens.refresh(refreshToken, client.ua, clientId)
    if (out.kind === 'reused')
      await this.logSession(
        out.session?.userId ?? null,
        out.session?.userType ?? 'admin',
        { ...client, clientId: out.session?.clientId ?? clientId },
        'refresh_reuse',
        'signin.refresh_reuse',
        false,
      )
    return out
  }

  /**
   * Sign-out: ends the caller's session and the one the presented refresh cookie belongs to, which
   * differs when another tab signed in again since (the cookie is shared, the bearer is per tab);
   * holding a refresh token is authority over its session.
   */
  async logout(p: Principal, client: Client, refreshToken: string | null): Promise<void> {
    const sids = new Set([p.sid, refreshToken && (await this.tokens.sidOfRefresh(refreshToken))])
    for (const sid of sids) if (sid) await this.revoker.revokeSession(sid, 'signout')
    await this.logSession(
      p.userId,
      p.userType ?? 'admin',
      withClient(client, p),
      'signout',
      'signin.signout',
      true,
    )
  }

  /** Lock screen: rate limited per user and per IP, then the shared current-password check. */
  async verifyPassword(p: Principal, password: string, client: Client): Promise<void> {
    const user = redisKey('authFail', 'vp', 'u', p.userId)
    const ip = redisKey('authFail', 'vp', 'ip', smsIpBucket(client.ip))
    const [byUser, , byIp] = await this.redis
      .multi()
      .incr(user)
      .pExpire(user, 60_000, 'NX')
      .incr(ip)
      .pExpire(ip, 60_000, 'NX')
      .exec()
    if (Number(byUser) > VERIFY_PER_MINUTE.user || Number(byIp) > VERIFY_PER_MINUTE.ip)
      throw new BizError(Err.TOO_MANY_REQUESTS)
    const cred = await this.lookup.findCredentials({ userId: p.userId })
    await this.checkCurrentPassword(
      p,
      password,
      cred?.passwordHash ?? null,
      client,
      Err.AUTH_PASSWORD_WRONG,
      demoMode(),
    )
  }

  /**
   * The caller's current password (lock screen, profile, password change; see docs/design-notes.md#auth-sessions): one counter
   * per user across routes and IPs. Each check first reserves an attempt (one atomic INCR), so
   * parallel guesses reach bcrypt at most `lockThreshold` times; a check reserved past the threshold
   * is refused without bcrypt, and the failure that reaches it, like every refused one, ends all of
   * the user's sessions (401). Demo lock-screen checks count and revoke only the caller's session;
   * per-minute user/IP rate limits stay shared. A right password clears the counter.
   */
  async checkCurrentPassword(
    p: Principal,
    password: string,
    hash: string | null,
    client: Client,
    wrong: ErrorDef,
    sessionOnly = false,
  ): Promise<void> {
    const key = sessionOnly
      ? redisKey('authFail', 'cur', p.userId, p.sid!)
      : redisKey('authFail', 'cur', p.userId)
    const { security } = await this.params.load()
    const [reserved] = await this.redis
      .multi()
      .incr(key)
      .pExpire(key, security.lockMinutes * 60_000)
      .exec()
    const attempt = Number(reserved)
    if (attempt <= security.lockThreshold) {
      if (hash && (await bcrypt.compare(password, hash))) {
        await this.redis.del(key)
        return
      }
      if (attempt < security.lockThreshold) throw new BizError(wrong)
    }
    if (sessionOnly) {
      if (p.sid) await this.revoker.revokeSession(p.sid, 'password_attempts')
    } else await this.revoker.revokeUser(p.userId, 'password_attempts')
    await this.logSession(
      p.userId,
      p.userType ?? 'admin',
      withClient(client, p),
      'locked',
      'signin.password_check_exceeded',
      false,
    )
    throw new BizError(Err.AUTH_SESSION_EXPIRED)
  }

  /**
   * GET /me (see docs/design-notes.md#auth-sessions): profile, role codes, perms, the session's password flags, the policy and the
   * previous sign-in's time.
   */
  async me(p: Principal): Promise<MePayload> {
    const [user, session, { policy }] = await Promise.all([
      this.lookup.profile(p.userId),
      p.sid ? this.tokens.load(p.sid) : null,
      this.params.load(),
    ])
    if (!user || !session) throw new BizError(Err.UNAUTHENTICATED)
    return {
      user,
      roles: p.roles.map((r) => r.code),
      perms: p.perms,
      flags: session.flags,
      policy,
      lastSignInAt: await this.audit.lastSignIn(p.userId, session.loginAt),
    }
  }

  /** GET /menus: root sees every enabled menu; menus of switched-off features never (menu-features.ts). */
  async menus(p: Principal): Promise<MenuNode[]> {
    return withFeatures(await this.lookup.menus(p.userId, p.root === true), (s) => this.cfg.get(s))
  }

  /** Sign-in log row for an existing session's user (username from the user store). */
  private async logSession(
    userId: number | null,
    userType: string,
    client: Client & { clientId: string },
    kind: SigninLogEntry['kind'],
    msgKey: string,
    ok: boolean,
  ) {
    const cred = userId === null ? null : await this.lookup.findCredentials({ userId })
    this.audit.signin({
      kind,
      userId,
      userType,
      username: cred?.username ?? '',
      ...client,
      ok,
      msgKey,
    })
  }

  /**
   * Unlocks `username` (the sign-in log page's "unlock", 登录日志): its username+IP pair
   * counters on every IP and its cross-IP counter are deleted, keyed like `failKeys` (an account's stored
   * spelling, lower-cased), so its locks end at once. The per-IP counters stay: they belong to the IP.
   */
  async unlock(username: string): Promise<void> {
    const cred = await this.lookup.findCredentials({ username })
    const u = (cred?.username ?? username).toLowerCase()
    // `p:<user>:` + any IP; the key's own glob characters escaped (URI-encoding leaves `*` as it is)
    const pairs = `${redisKey('authFail', 'p', u, '').replace(/[*?[\]\\]/g, '\\$&')}*`
    for await (const keys of this.redis.scanIterator({ MATCH: pairs, COUNT: 500 }))
      if (keys.length) await this.redis.unlink(keys)
    await this.redis.unlink(failKeys(u, '').user)
  }

  /** One more failure on every counter; returns the username+IP pair's count. */
  private async countFailure(keys: FailKeys, lockMinutes: number): Promise<number> {
    const [pair] = await this.redis
      .multi()
      .incr(keys.pair)
      // the lock lasts lockMinutes after the last counted failure
      .pExpire(keys.pair, lockMinutes * 60_000)
      .incr(keys.user)
      .pExpire(keys.user, HOUR_MS, 'NX')
      .incr(keys.ip)
      .pExpire(keys.ip, HOUR_MS, 'NX')
      .exec()
    return Number(pair)
  }
}
