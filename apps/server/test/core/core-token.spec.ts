// core/auth TokenService + SessionRevoker (see docs/design-notes.md#auth-sessions): opaque tokens stored only as sha256, session JSON,
// sliding renewal and rotation capped at absoluteExpAt, 30 s grace bound to sid + UA (sealed pair),
// replay → whole session revoked, revokeSession / revokeUser via the auth:user:{id} index.
import { createHash } from 'node:crypto'
import { Test, type TestingModule } from '@nestjs/testing'
import { CoreConfigModule } from '../../src/core/config/config.module.js'
import { ownerIndexKey, SessionRevoker } from '../../src/core/auth/session-revoker.js'
import { sweepOnline } from '../../src/core/auth/online-sweep.js'
import { RealtimeService } from '../../src/core/realtime/realtime.service.js'
import {
  ABSOLUTE_MS,
  type CodeEntry,
  MOBILE_CLIENT,
  REFRESH_GRACE_MS,
  type SessionUser,
  TokenService,
} from '../../src/core/auth/token.service.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { CoreRedisModule, REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { cleanRedis } from '../setup/redis.js'

let moduleRef: TestingModule
let tokens: TokenService
let revoker: SessionRevoker
let redis: Redis

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const atKey = (t: string) => redisKey('authAccess', sha256(t))
const rtKey = (t: string) => redisKey('authRefresh', sha256(t))
const UA = 'Mozilla/5.0 (test) UA-1'
const opts = { keepSignedIn: false, ip: '127.0.0.1', ua: UA }
const user = (userId: number): SessionUser => ({
  userId,
  userType: 'admin',
  deptId: 2,
  deptTreePath: '/1/2/',
  roles: [{ code: 'ops', dataScope: 'own_dept', perms: ['iam.user.browse'] }],
  perms: ['iam.user.browse'],
  locale: 'en-US',
  permVer: '0.0',
})
const sidOf = async (accessToken: string) => (await tokens.authenticate(accessToken))?.sid ?? null

/** Every key and value of this app in Redis as one string (proves no plaintext token is stored). */
async function dump(): Promise<string> {
  const out: string[] = []
  for await (const keys of redis.scanIterator({ MATCH: 'qw:*', COUNT: 500 }))
    for (const key of keys) {
      const type = await redis.type(key)
      const value =
        type === 'string'
          ? await redis.get(key)
          : type === 'set'
            ? (await redis.sMembers(key)).join(' ')
            : (await redis.zRange(key, 0, -1)).join(' ')
      out.push(`${key}=${value}`)
    }
  return out.join('\n')
}

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [CoreConfigModule.forRoot(), CoreRedisModule],
    // RealtimeService without a gateway: socket endings are no-ops here (core-realtime.e2e covers them)
    providers: [TokenService, SessionRevoker, RealtimeService],
  }).compile()
  tokens = moduleRef.get(TokenService)
  revoker = moduleRef.get(SessionRevoker)
  redis = moduleRef.get(REDIS)
  await cleanRedis(redis)
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(async () => {
  if (redis) await cleanRedis(redis)
  await moduleRef?.close()
})

/** Freezes Date.now() only (node-redis keeps its real timers; Redis TTLs stay real). */
const freezeAt = (ms: number) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ms)
}

describe('issue', () => {
  it('mints 256-bit base64url tokens; Redis keeps only their sha256 and the session JSON', async () => {
    const t = await tokens.issue(user(1), opts)
    expect(t.accessToken).toMatch(/^[\w-]{43}$/)
    expect(t.refreshToken).toMatch(/^[\w-]{43}$/)
    expect(t.refreshToken).not.toBe(t.accessToken)
    const all = await dump()
    expect(all).not.toContain(t.accessToken)
    expect(all).not.toContain(t.refreshToken)
    expect(await redis.exists([atKey(t.accessToken), rtKey(t.refreshToken)])).toBe(2)

    const session = await tokens.load(t.session.sid)
    expect(Object.keys(session!).sort()).toEqual(
      [
        'sid',
        'userId',
        'userType',
        'clientId',
        'scopes',
        'deptId',
        'deptTreePath',
        'roles',
        'perms',
        'permVer',
        'flags',
        'keepSignedIn',
        'ip',
        'ua',
        'loginAt',
        'absoluteExpAt',
        'locale',
      ].sort(),
    )
    expect(session).toMatchObject({
      userId: 1,
      clientId: 'console',
      scopes: [],
      flags: { mustChangePassword: false, passwordExpired: false },
      keepSignedIn: false,
      ua: UA,
    })
    expect(session!.absoluteExpAt - session!.loginAt).toBe(ABSOLUTE_MS.session)

    // access 30 min (ACCESS_TTL_SEC); refresh 7 d (REFRESH_TTL_SEC) capped by the 12 h absolute limit
    expect(t.expiresIn).toBe(1800)
    expect(t.refreshExpiresIn).toBe(12 * 3600)
    expect(await redis.pTTL(rtKey(t.refreshToken))).toBeLessThanOrEqual(ABSOLUTE_MS.session)

    const index = redisKey('authUser', 1)
    expect((await redis.sMembers(index)).sort()).toEqual(
      [redisKey('authSession', t.session.sid), atKey(t.accessToken), rtKey(t.refreshToken)].sort(),
    )
    expect(await redis.pTTL(index)).toBeGreaterThan(0)
    expect(await redis.zScore(redisKey('authOnline'), t.session.sid)).toBeGreaterThan(Date.now())
  })

  it('keepSignedIn: 7-day absolute limit, refresh TTL 7 days', async () => {
    const t = await tokens.issue(user(1), { ...opts, keepSignedIn: true })
    expect(t.session.absoluteExpAt - t.session.loginAt).toBe(ABSOLUTE_MS.keepSignedIn)
    expect(t.refreshExpiresIn).toBe(7 * 86400)
  })
})

describe('authenticate', () => {
  it('live token → its session; unknown token → null', async () => {
    const t = await tokens.issue(user(1), opts)
    expect(await sidOf(t.accessToken)).toBe(t.session.sid)
    expect(await tokens.authenticate('not-a-token')).toBeNull()
    // a refresh token is not an access token
    expect(await tokens.authenticate(t.refreshToken)).toBeNull()
  })

  it('sliding renewal below a third of the TTL, never past absoluteExpAt', async () => {
    const t = await tokens.issue(user(1), opts)
    const key = atKey(t.accessToken)
    await redis.pExpire(key, 1_000_000) // more than a third of 30 min left: untouched
    await tokens.authenticate(t.accessToken)
    expect(await redis.pTTL(key)).toBeLessThanOrEqual(1_000_000)
    await redis.pExpire(key, 100_000) // less than a third: renewed to the full TTL
    await tokens.authenticate(t.accessToken)
    expect(await redis.pTTL(key)).toBeGreaterThan(1_700_000)

    freezeAt(t.session.absoluteExpAt - 60_000)
    await redis.pExpire(key, 1000)
    expect(await sidOf(t.accessToken)).toBe(t.session.sid)
    const ttl = await redis.pTTL(key)
    expect(ttl).toBeGreaterThan(1000)
    expect(ttl).toBeLessThanOrEqual(60_000)
  })

  it('at absoluteExpAt the access and refresh tokens are dead, whatever their TTLs', async () => {
    const t = await tokens.issue(user(1), opts)
    freezeAt(t.session.absoluteExpAt)
    expect(await tokens.authenticate(t.accessToken)).toBeNull()
    expect(await tokens.refresh(t.refreshToken, UA)).toEqual({ kind: 'rejected' })
  })
})

describe('refresh', () => {
  it('rotates: new pair, the old access token dies, the old refresh token only enters grace', async () => {
    const t = await tokens.issue(user(1), opts)
    const r = await tokens.refresh(t.refreshToken, UA)
    if (r.kind !== 'rotated') throw new Error(r.kind)
    expect(r.session.sid).toBe(t.session.sid)
    expect(r.tokens.accessToken).not.toBe(t.accessToken)
    expect(r.tokens.refreshToken).not.toBe(t.refreshToken)
    expect(await tokens.authenticate(t.accessToken)).toBeNull()
    expect(await sidOf(r.tokens.accessToken)).toBe(t.session.sid)
    expect(await redis.exists(rtKey(t.refreshToken))).toBe(0)

    const members = await redis.sMembers(redisKey('authUser', 1))
    expect(members).toContain(redisKey('authRefreshGrace', sha256(t.refreshToken)))
    expect(members).not.toContain(atKey(t.accessToken))
    expect(members).not.toContain(rtKey(t.refreshToken))
    // the grace entry holds the new pair encrypted, never in plaintext
    const all = await dump()
    expect(all).not.toContain(r.tokens.accessToken)
    expect(all).not.toContain(r.tokens.refreshToken)
  })

  it('rotation near absoluteExpAt caps both new TTLs at the time left', async () => {
    const t = await tokens.issue(user(1), opts)
    freezeAt(t.session.absoluteExpAt - 5000)
    const r = await tokens.refresh(t.refreshToken, UA)
    if (r.kind !== 'rotated') throw new Error(r.kind)
    expect(r.tokens.expiresIn).toBe(5)
    expect(r.tokens.refreshExpiresIn).toBe(5)
    expect(await redis.pTTL(atKey(r.tokens.accessToken))).toBeLessThanOrEqual(5000)
    expect(await redis.pTTL(rtKey(r.tokens.refreshToken))).toBeLessThanOrEqual(5000)
  })

  it('two parallel refreshes of the same token both succeed with the same pair', async () => {
    const t = await tokens.issue(user(1), opts)
    const [a, b] = await Promise.all([
      tokens.refresh(t.refreshToken, UA),
      tokens.refresh(t.refreshToken, UA),
    ])
    if (a.kind !== 'rotated' || b.kind !== 'rotated') throw new Error(`${a.kind}/${b.kind}`)
    expect(a.tokens).toEqual(b.tokens)
    expect(await sidOf(a.tokens.accessToken)).toBe(t.session.sid)
  })

  it('grace replay from the same session and UA gets the same pair again', async () => {
    const t = await tokens.issue(user(1), opts)
    const first = await tokens.refresh(t.refreshToken, UA)
    const again = await tokens.refresh(t.refreshToken, UA)
    expect(again).toEqual(first)
    expect(first.kind).toBe('rotated')
  })

  it('grace replay after a second rotation gets the live pair, not the rotated one', async () => {
    const t = await tokens.issue(user(1), opts)
    const r1 = await tokens.refresh(t.refreshToken, UA)
    if (r1.kind !== 'rotated') throw new Error(r1.kind)
    const r2 = await tokens.refresh(r1.tokens.refreshToken, UA)
    if (r2.kind !== 'rotated') throw new Error(r2.kind)
    const late = await tokens.refresh(t.refreshToken, UA)
    expect(late).toEqual(r2)
    expect(await sidOf(r2.tokens.accessToken)).toBe(t.session.sid)
  })

  it('grace replay from another UA revokes the whole session', async () => {
    const t = await tokens.issue(user(1), opts)
    const first = await tokens.refresh(t.refreshToken, UA)
    if (first.kind !== 'rotated') throw new Error(first.kind)
    const replay = await tokens.refresh(t.refreshToken, 'curl/8.0')
    expect(replay.kind).toBe('reused')
    expect(replay.kind === 'reused' && replay.session?.sid).toBe(t.session.sid)
    expect(await tokens.load(t.session.sid)).toBeNull()
    expect(await tokens.authenticate(first.tokens.accessToken)).toBeNull()
    expect(await tokens.refresh(first.tokens.refreshToken, UA)).toEqual({ kind: 'rejected' })
    expect(await redis.zScore(redisKey('authOnline'), t.session.sid)).toBeNull()
  })

  it('replay after the grace window revokes the whole session', async () => {
    const t = await tokens.issue(user(1), opts)
    const first = await tokens.refresh(t.refreshToken, UA)
    if (first.kind !== 'rotated') throw new Error(first.kind)
    freezeAt(Date.now() + REFRESH_GRACE_MS + 1000)
    expect((await tokens.refresh(t.refreshToken, UA)).kind).toBe('reused')
    expect(await tokens.authenticate(first.tokens.accessToken)).toBeNull()
  })

  it('an unknown refresh token is rejected and revokes nothing', async () => {
    const t = await tokens.issue(user(1), opts)
    expect(await tokens.refresh('forged-token', UA)).toEqual({ kind: 'rejected' })
    expect(await tokens.refresh(t.accessToken, UA)).toEqual({ kind: 'rejected' })
    expect(await sidOf(t.accessToken)).toBe(t.session.sid)
  })
})

describe('third-party sessions', () => {
  const ttl = { accessMs: 600_000, refreshMs: 3_600_000 }
  const crm = { ...opts, clientId: 'crm-ttl', scopes: ['user.read'], ttl }

  it.each(['sweep', 'issue'])(
    '%s keeps 8-day-old last-seen times of 30-day sessions, prunes beyond 30 days',
    async (action) => {
      const t = await tokens.issue(user(45), {
        ...crm,
        ttl: { ...ttl, refreshMs: 30 * 86_400_000 },
      })
      const now = Date.now()
      freezeAt(now)
      const seen = redisKey('authSeen')
      const lastSeen = now - 8 * 86_400_000
      await redis.zAdd(seen, [
        { score: lastSeen, value: t.session.sid },
        { score: now - 30 * 86_400_000 - 1, value: 'expired-sid' },
      ])
      if (action === 'sweep') await sweepOnline(redis, now)
      else await tokens.issue(user(46), opts)
      expect(await redis.zScore(seen, t.session.sid)).toBe(lastSeen)
      expect(await redis.zScore(seen, 'expired-sid')).toBeNull()
      expect((await tokens.online()).find((s) => s.sid === t.session.sid)?.lastSeenAt).toBe(
        lastSeen,
      )
    },
  )

  it('live by the client row: access TTL fixed (no sliding), refresh TTL = absolute limit, kept on rotation', async () => {
    const t = await tokens.issue(user(41), crm)
    expect(t.session.absoluteExpAt - t.session.loginAt).toBe(ttl.refreshMs)
    expect(t.expiresIn).toBe(600)
    expect(t.refreshExpiresIn).toBe(3600)
    expect((await tokens.load(t.session.sid))?.ttl).toEqual(ttl)

    const key = atKey(t.accessToken)
    await redis.pExpire(key, 100_000) // below a third: a first-party token would slide back to 30 min
    expect(await sidOf(t.accessToken)).toBe(t.session.sid)
    expect(await redis.pTTL(key)).toBeLessThanOrEqual(100_000)

    const r = await tokens.refresh(t.refreshToken, UA, 'crm-ttl')
    if (r.kind !== 'rotated') throw new Error(r.kind)
    expect(r.tokens.expiresIn).toBe(600)
    expect(r.tokens.refreshExpiresIn).toBeLessThanOrEqual(3600)
    freezeAt(t.session.absoluteExpAt - 5000)
    const late = await tokens.refresh(r.tokens.refreshToken, UA, 'crm-ttl')
    if (late.kind !== 'rotated') throw new Error(late.kind)
    expect(late.tokens.refreshExpiresIn).toBe(5)
  })

  it('inspect reads a live access or refresh token without renewing it; null when unknown or past the limit', async () => {
    const t = await tokens.issue(user(42), crm)
    await redis.pExpire(atKey(t.accessToken), 100_000)
    const a = await tokens.inspect(t.accessToken)
    expect(a).toMatchObject({
      kind: 'access',
      session: { sid: t.session.sid, clientId: 'crm-ttl' },
    })
    expect(a!.expiresAt - Date.now()).toBeLessThanOrEqual(100_000)
    expect(await redis.pTTL(atKey(t.accessToken))).toBeLessThanOrEqual(100_000)
    expect(await redis.zScore(redisKey('authSeen'), t.session.sid)).toBe(t.session.loginAt)
    const r = await tokens.inspect(t.refreshToken)
    expect(r).toMatchObject({ kind: 'refresh', session: { sid: t.session.sid } })
    expect(r!.expiresAt).toBeLessThanOrEqual(t.session.absoluteExpAt)
    expect(await tokens.inspect('not-a-token')).toBeNull()
    freezeAt(t.session.absoluteExpAt)
    expect(await tokens.inspect(t.accessToken)).toBeNull()
  })

  it('authorization codes: single use, indexed under the user; revokeUser deletes them, revokeSession and a client-filtered revokeUser do not', async () => {
    const entry = (userId: number): CodeEntry => ({
      client: 'crm-ttl',
      clientPk: 1,
      userId,
      redirectUri: 'https://crm.example/cb',
      scopes: ['user.read'],
      challenge: 'c'.repeat(43),
      credVer: '0',
      exp: Date.now() + 300_000,
    })
    const codeKey = (c: string) => redisKey('oauth2Code', sha256(c))
    const first = entry(43)
    await tokens.saveCode('code-1', first, 300_000)
    expect(await dump()).not.toContain('code-1')
    const index = redisKey('authUserCodes', 43)
    expect(await redis.zRangeWithScores(index, 0, -1)).toEqual([
      { value: codeKey('code-1'), score: first.exp },
    ])
    expect(await redis.exists(redisKey('authUser', 43))).toBe(0)
    expect(await redis.pTTL(index)).toBeGreaterThan(0)
    expect(await tokens.takeCode('code-1')).toEqual(first)
    expect(await tokens.takeCode('code-1')).toBeNull()
    // No sleeps: expire the score (including its boundary); the next insert prunes dead members.
    const now = Date.now()
    freezeAt(now)
    await redis.zAdd(index, { score: now, value: codeKey('code-1') })
    await tokens.saveCode('code-fresh', entry(43), 300_000)
    expect(await redis.zCard(index)).toBe(1)
    expect(await redis.zRange(index, 0, -1)).toEqual([codeKey('code-fresh')])

    const s = await tokens.issue(user(44), opts)
    await tokens.saveCode('code-2', entry(44), 300_000)
    await revoker.revokeSession(s.session.sid, 'kicked')
    await revoker.revokeClient('crm-ttl', 'client_disabled')
    await revoker.revokeUser(44, 'wx_mp_unbound', { clientId: MOBILE_CLIENT })
    expect(await redis.exists(codeKey('code-2'))).toBe(1)
    await revoker.revokeUser(44, 'disabled')
    expect(await redis.exists(codeKey('code-2'))).toBe(0)
    expect(await redis.exists(redisKey('authUserCodes', 44))).toBe(0)
    await tokens.saveCode('code-3', entry(44), 300_000)
    await revoker.revokeUser(44, 'password_changed', { exceptSid: 'some-other-sid' })
    expect(await tokens.takeCode('code-3')).toBeNull()
  })
})

describe('SessionRevoker', () => {
  it('revokeSession ends one session; revokeUser ends all but exceptSid, only for that user', async () => {
    const a = await tokens.issue(user(7), opts)
    const b = await tokens.issue(user(7), opts)
    const other = await tokens.issue(user(8), opts)

    await revoker.revokeSession(a.session.sid, 'kicked')
    expect(await tokens.authenticate(a.accessToken)).toBeNull()
    expect(await tokens.refresh(a.refreshToken, UA)).toEqual({ kind: 'rejected' })
    expect(await redis.zScore(redisKey('authOnline'), a.session.sid)).toBeNull()
    expect(await sidOf(b.accessToken)).toBe(b.session.sid)

    // rotated keys (grace entry, new pair) are registered too
    const rotated = await tokens.refresh(b.refreshToken, UA)
    if (rotated.kind !== 'rotated') throw new Error(rotated.kind)
    const mine = await tokens.issue(user(7), opts)
    await revoker.revokeUser(7, 'password_changed', { exceptSid: mine.session.sid })
    expect(await tokens.authenticate(rotated.tokens.accessToken)).toBeNull()
    expect(await tokens.refresh(b.refreshToken, UA)).toEqual({ kind: 'rejected' })
    expect(await sidOf(mine.accessToken)).toBe(mine.session.sid)
    expect(await sidOf(other.accessToken)).toBe(other.session.sid)

    await revoker.revokeUser(7, 'disabled')
    expect(await tokens.authenticate(mine.accessToken)).toBeNull()
    expect(await redis.exists(redisKey('authUser', 7))).toBe(0)
    expect(await sidOf(other.accessToken)).toBe(other.session.sid)
  })

  it('revokeUser runs its hooks first (credver unmoved, sessions live), then revokes even when one fails', async () => {
    const t = await tokens.issue(user(11), opts)
    const before = await tokens.credVersion(11)
    const seen: unknown[] = []
    revoker.onRevokeUser(async (userId, reason) => {
      if (userId !== 11) return
      seen.push([reason, await tokens.credVersion(11), await sidOf(t.accessToken)])
      throw new Error('hook down')
    })
    await expect(revoker.revokeUser(11, 'password_reset')).rejects.toThrow('hook down')
    expect(seen).toEqual([['password_reset', before, t.session.sid]])
    expect(await tokens.credVersion(11)).not.toBe(before)
    expect(await tokens.authenticate(t.accessToken)).toBeNull()
  })

  it('revokeUser with a clientId ends only that client’s sessions, their token keys too', async () => {
    const mobile = { ...opts, clientId: MOBILE_CLIENT }
    const phone = await tokens.issue(user(12), mobile)
    const here = await tokens.issue(user(12), mobile)
    const desk = await tokens.issue(user(12), opts)
    await revoker.revokeUser(12, 'wx_mp_unbound', {
      exceptSid: here.session.sid,
      clientId: MOBILE_CLIENT,
    })
    expect(await tokens.authenticate(phone.accessToken)).toBeNull()
    expect(await sidOf(here.accessToken)).toBe(here.session.sid)
    expect(await sidOf(desk.accessToken)).toBe(desk.session.sid)
    // session, access and refresh key of the two left: none of the ended one's stays indexed
    expect(await redis.sMembers(redisKey('authUser', 12))).toHaveLength(6)
  })

  it('revokeClient ends every session of that OAuth2 client, a client_credentials one too; refuses a first-party id', async () => {
    const crm = { ...opts, clientId: 'crm-web', scopes: ['user.read'] }
    const machine: SessionUser = {
      ...user(0),
      userId: null,
      userType: 'client',
      roles: [],
      perms: [],
    }
    const ann = await tokens.issue(user(21), crm)
    const bob = await tokens.issue(user(22), crm)
    const cc = await tokens.issue(machine, crm)
    const erp = await tokens.issue(user(21), { ...opts, clientId: 'erp', scopes: ['user.read'] })
    const desk = await tokens.issue(user(21), opts)
    const phone = await tokens.issue(user(21), { ...opts, clientId: MOBILE_CLIENT })

    for (const firstParty of ['console', MOBILE_CLIENT])
      await expect(revoker.revokeClient(firstParty, 'client_disabled')).rejects.toThrow(
        'first-party',
      )
    expect(await sidOf(desk.accessToken)).toBe(desk.session.sid)
    expect(await sidOf(phone.accessToken)).toBe(phone.session.sid)

    expect(await revoker.revokeClient('crm-web', 'client_disabled')).toBe(3)
    for (const t of [ann, bob, cc]) {
      expect(await tokens.authenticate(t.accessToken)).toBeNull()
      expect(await tokens.refresh(t.refreshToken, UA, 'crm-web')).toEqual({ kind: 'rejected' })
      expect(await redis.zScore(redisKey('authOnline'), t.session.sid)).toBeNull()
    }
    expect(await redis.exists(ownerIndexKey({ userId: null, clientId: 'crm-web' }))).toBe(0)
    // the same users' other clients, and the other third-party client, stay signed in
    for (const t of [erp, desk, phone]) expect(await sidOf(t.accessToken)).toBe(t.session.sid)
    expect(await revoker.revokeClient('crm-web', 'client_deleted')).toBe(0)
  })

  it('save() updates a live session but never revives a revoked one', async () => {
    const t = await tokens.issue(user(9), opts)
    const s = (await tokens.load(t.session.sid))!
    expect(await tokens.save({ ...s, perms: ['*'] })).toBe(true)
    expect((await tokens.authenticate(t.accessToken))?.perms).toEqual(['*'])
    await revoker.revokeSession(s.sid, 'kicked')
    expect(await tokens.save(s)).toBe(false)
    expect(await tokens.load(s.sid)).toBeNull()
  })
})
