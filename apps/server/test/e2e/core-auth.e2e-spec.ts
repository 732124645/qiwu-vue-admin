// Sign-in and sessions (see docs/design-notes.md#auth-sessions, #security): sign-in (enumeration-safe errors, fake-hash bcrypt, per
// username+IP locks, IP blacklist, @RateLimit, trust proxy), refresh rotation, logout, lock screen,
// /me + /menus and the minimal password change. Every request picks its own client IP through
// X-Forwarded-For (trusted from loopback, TRUST_PROXY=loopback) so counters never cross tests.
import type { AddressInfo } from 'node:net'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, IP_BLACKLIST_PARAM, type MenuNode } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { ABSOLUTE_MS, REFRESH_GRACE_MS, TokenService } from '../../src/core/auth/token.service.js'
import { LAST_SIGNIN_SQL } from '../../src/core/audit/audit-writer.js'
import { AuthParams, smsIpBucket } from '../../src/core/auth/auth-params.js'
import { BCRYPT_COST, FAKE_HASH } from '../../src/core/auth/password-hash.js'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { AppConfigService } from '../../src/core/config/config.module.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'auth-e2e-'
const PW = 'Auth-e2e#2026'
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let tokens: TokenService
let ipSeq = 0

const http = () => request(app.getHttpServer())
/** A fresh documentation-range client IP (RFC 5737) per call. */
const nextIp = () => `198.18.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`

interface LoginOpts {
  ip?: string
  keepSignedIn?: boolean
  headers?: Record<string, string>
}
const login = (username: string, password = PW, o: LoginOpts = {}) =>
  http()
    .post('/api/auth/login')
    .set('X-Forwarded-For', o.ip ?? nextIp())
    .set('User-Agent', CHROME)
    .set(o.headers ?? {})
    .send({
      username,
      password,
      ...(o.keepSignedIn === undefined ? {} : { keepSignedIn: o.keepSignedIn }),
    })

/** Creates a user (cheap bcrypt cost: these specs never measure timing). */
async function user(name: string, extra: Record<string, unknown> = {}, password = PW) {
  return insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: bcrypt.hashSync(password, 4),
    password_changed_at: new Date(),
    ...extra,
  })
}

const cookieOf = (res: request.Response) =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('qw_rt=')) ?? ''

interface SigninRow {
  kind: string
  user_id: number | null
  ok: number
  msg_key: string
  msg_params: Record<string, unknown> | null
  ip: string
  browser: string | null
  os: string | null
  trace_id: string
}
/** Sign-in log rows of a username, oldest first; the writer does not await, so poll for `count`. */
async function signinLog(username: string, count: number): Promise<SigninRow[]> {
  return vi.waitFor(
    async () => {
      const rows = await ds.query<SigninRow[]>(
        'SELECT kind, user_id, ok, msg_key, msg_params, ip, browser, os, trace_id FROM aud_signin_log WHERE username = ? ORDER BY id',
        [username],
      )
      if (rows.length < count) throw new Error(`${rows.length}/${count} sign-in rows`)
      return rows
    },
    { timeout: 5000 },
  )
}

const failCount = async (...parts: string[]) =>
  Number(await redis.get(redisKey('authFail', ...parts)))

const selfOrigin = () => `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`

interface RefreshOpts {
  ua?: string
  /** null: no Origin header */
  origin?: string | null
  ip?: string
}
/** POST /refresh with the `qw_rt=…` pair of a Set-Cookie line. */
const refresh = (cookie: string, o: RefreshOpts = {}) => {
  const req = http()
    .post('/api/auth/refresh')
    .set('X-Forwarded-For', o.ip ?? nextIp())
    .set('User-Agent', o.ua ?? CHROME)
  if (cookie) req.set('Cookie', cookie.split(';')[0]!)
  const origin = o.origin === undefined ? selfOrigin() : o.origin
  return origin === null ? req : req.set('Origin', origin)
}

/** Signs `name` in; returns the access token and the refresh Set-Cookie line. */
async function signedIn(name: string, o: LoginOpts = {}) {
  const res = await login(PREFIX + name, PW, o).expect(200)
  return { access: res.body.data.accessToken as string, cookie: cookieOf(res) }
}

const alive = async (accessToken: string) => (await tokens.authenticate(accessToken)) !== null

/** Freezes Date.now() only (Redis TTLs and sockets keep real time). */
const freezeAt = (ms: number) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ms)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  tokens = app.get(TokenService)
  await cleanRedis(redis)
})

afterAll(async () => {
  if (ds) {
    const like = `${PREFIX}%`
    await ds.query(
      'DELETE ur FROM iam_user_roles ur JOIN iam_user u ON u.id = ur.user_id WHERE u.username LIKE ?',
      [like],
    )
    await ds.query('DELETE FROM iam_user WHERE username LIKE ?', [like])
    await ds.query('DELETE FROM aud_signin_log WHERE username LIKE ?', [`%${like}`])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('login', () => {
  it('success: access token, session refresh cookie, last_login_*, X-Timezone, sign-in log', async () => {
    const id = await user('alice')
    const ip = nextIp()
    const res = await login(`${PREFIX}alice`, PW, {
      ip,
      headers: { 'X-Timezone': 'Europe/Berlin', 'X-Request-Id': 'auth-e2e-trace-1' },
    }).expect(200)
    expect(res.body.data).toEqual({
      accessToken: expect.stringMatching(/^[\w-]{43}$/),
      expiresIn: 1800,
    })

    const cookie = cookieOf(res)
    expect(cookie).toMatch(/^qw_rt=[\w-]{43};/)
    expect(cookie).toMatch(/; Path=\/api\/auth/)
    expect(cookie).toMatch(/; HttpOnly/)
    expect(cookie).toMatch(/; SameSite=Strict/)
    // not keepSignedIn: a session cookie (no Max-Age/Expires); not production: no Secure
    expect(cookie).not.toMatch(/Max-Age|Expires|Secure/i)

    const session = await tokens.authenticate(res.body.data.accessToken)
    expect(session).toMatchObject({ userId: id, keepSignedIn: false, ip, ua: CHROME })
    expect(session!.absoluteExpAt - session!.loginAt).toBe(ABSOLUTE_MS.session)
    expect(session!.flags).toEqual({ mustChangePassword: false, passwordExpired: false })

    const [row] = await ds.query<
      { last_login_ip: string; last_login_at: Date; timezone: string }[]
    >('SELECT last_login_ip, last_login_at, timezone FROM iam_user WHERE id = ?', [id])
    expect(row).toMatchObject({ last_login_ip: ip, timezone: 'Europe/Berlin' })
    expect(Date.now() - row!.last_login_at.getTime()).toBeLessThan(10_000)

    const [log] = await signinLog(`${PREFIX}alice`, 1)
    expect(log).toMatchObject({
      kind: 'password',
      user_id: id,
      ok: 1,
      msg_key: 'signin.ok',
      ip,
      trace_id: 'auth-e2e-trace-1',
      browser: 'Chrome 131.0.0.0',
      os: expect.stringMatching(/^macOS/),
    })
  })

  it('keepSignedIn: persistent cookie (Max-Age = refresh TTL), 7-day absolute limit; a bad X-Timezone is ignored', async () => {
    const id = await user('keep', { timezone: 'Asia/Tokyo' })
    const res = await login(`${PREFIX}keep`, PW, {
      keepSignedIn: true,
      headers: { 'X-Timezone': 'Mars/Olympus_Mons' },
    }).expect(200)
    expect(cookieOf(res)).toMatch(/; Max-Age=604800;/)
    const session = await tokens.authenticate(res.body.data.accessToken)
    expect(session!.keepSignedIn).toBe(true)
    expect(session!.absoluteExpAt - session!.loginAt).toBe(ABSOLUTE_MS.keepSignedIn)
    const [row] = await ds.query<{ timezone: string }[]>(
      'SELECT timezone FROM iam_user WHERE id = ?',
      [id],
    )
    expect(row!.timezone).toBe('Asia/Tokyo')
  })

  it('wrong password, unknown, disabled and deleted users: one identical 401, all counted, logged with the real reason', async () => {
    await user('bob')
    await user('off', { enabled: 0 })
    await user('gone', { deleted_at: new Date() })
    const ip = nextIp()
    const attempts = [
      await login(`${PREFIX}bob`, 'Wrong#pass1', { ip }),
      await login(`${PREFIX}nobody`, PW, { ip }),
      await login(`${PREFIX}off`, PW, { ip }),
      await login(`${PREFIX}gone`, PW, { ip }),
    ]
    const shape = ({ status, body }: request.Response) => ({
      status,
      code: body.code,
      msg: body.msg,
      data: body.data,
    })
    for (const res of attempts) {
      expect(shape(res)).toEqual(shape(attempts[0]!))
      expect(cookieOf(res)).toBe('')
    }
    expect(attempts[0]!.status).toBe(401)
    expect(attempts[0]!.body.code).toBe(Err.AUTH_BAD_CREDENTIALS.code)

    for (const name of ['bob', 'nobody', 'off', 'gone']) {
      expect(await failCount('p', PREFIX + name, ip)).toBe(1)
      expect(await failCount('u', PREFIX + name)).toBe(1)
    }
    expect(await failCount('ip', ip)).toBe(4)
    const reasons = await Promise.all(
      ['bob', 'nobody', 'off', 'gone'].map(
        async (n) => (await signinLog(PREFIX + n, 1))[0]!.msg_key,
      ),
    )
    expect(reasons).toEqual([
      'signin.bad_password',
      'signin.unknown_user',
      'signin.disabled',
      'signin.unknown_user',
    ])
  })

  it('the fake hash costs as much as every stored one: the one bcrypt cost', () => {
    expect(bcrypt.getRounds(FAKE_HASH)).toBe(BCRYPT_COST)
  })

  it('username+IP lock: the 5th failure locks that pair only; another IP still signs in; success resets', async () => {
    await user('carol')
    const ipA = nextIp()
    for (let i = 1; i <= 4; i++)
      expect((await login(`${PREFIX}carol`, 'Wrong#pass1', { ip: ipA })).body.code).toBe(
        Err.AUTH_BAD_CREDENTIALS.code,
      )
    const fifth = await login(`${PREFIX}carol`, 'Wrong#pass1', { ip: ipA })
    expect(fifth.status).toBe(429)
    expect(fifth.body.code).toBe(Err.AUTH_LOCKED.code)
    // locked: even the right password, in any spelling the collation maps to the account, is refused
    for (const name of [`${PREFIX}CAROL`, `${PREFIX}cärol`]) {
      const res = await login(name, PW, { ip: ipA })
      expect(res.status).toBe(429)
      expect(res.body.code).toBe(Err.AUTH_LOCKED.code)
    }
    // 5 failures, the lock itself, 2 refusals (the username column matches case-insensitively)
    const log = await signinLog(`${PREFIX}carol`, 8)
    expect(log.filter((r) => r.kind === 'locked').map((r) => r.msg_params)).toEqual(
      Array(3).fill({ minutes: 10 }),
    )

    // another IP: fine, and a success clears the pair and cross-IP counters there
    const ipB = nextIp()
    await login(`${PREFIX}carol`, 'Wrong#pass1', { ip: ipB }).expect(401)
    expect(await failCount('p', `${PREFIX}carol`, ipB)).toBe(1)
    await login(`${PREFIX}carol`, PW, { ip: ipB }).expect(200)
    expect(await redis.exists(redisKey('authFail', 'p', `${PREFIX}carol`, ipB))).toBe(0)
    expect(await redis.exists(redisKey('authFail', 'u', `${PREFIX}carol`))).toBe(0)
    // the pair on ipA stays locked
    expect((await login(`${PREFIX}carol`, PW, { ip: ipA })).status).toBe(429)
  })

  it('TRUST_PROXY excluding the source: a spoofed X-Forwarded-For still counts against the real IP', async () => {
    app.set('trust proxy', false)
    try {
      const spoofed = nextIp()
      await login(`${PREFIX}spoof`, 'Wrong#pass1', { ip: spoofed }).expect(401)
      expect(await failCount('ip', spoofed)).toBe(0)
      expect(await failCount('p', `${PREFIX}spoof`, '127.0.0.1')).toBe(1)
      expect(await failCount('ip', '127.0.0.1')).toBeGreaterThanOrEqual(1)
      expect((await signinLog(`${PREFIX}spoof`, 1))[0]!.ip).toBe('127.0.0.1')
    } finally {
      app.set('trust proxy', 'loopback')
    }
  })

  it('IP blacklist (addresses and CIDRs from cfg_param): 403 before any password check', async () => {
    await user('dave')
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
      '192.0.2.0/24, 2001:db8::1\n not-an-ip 10.0.0.0/99',
      IP_BLACKLIST_PARAM,
    ])
    await app.get(ParamService).invalidate(IP_BLACKLIST_PARAM)
    try {
      for (const ip of ['192.0.2.77', '2001:db8::1']) {
        const res = await login(`${PREFIX}dave`, PW, { ip })
        expect(res.status).toBe(403)
        expect(res.body.code).toBe(Err.AUTH_IP_BLOCKED.code)
        expect(await failCount('p', `${PREFIX}dave`, ip)).toBe(0)
      }
      expect((await signinLog(`${PREFIX}dave`, 2)).map((r) => r.msg_key)).toEqual([
        'signin.ip_blocked',
        'signin.ip_blocked',
      ])
      await login(`${PREFIX}dave`, PW, { ip: '192.0.3.1' }).expect(200)
    } finally {
      await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
        '',
        IP_BLACKLIST_PARAM,
      ])
      await app.get(ParamService).invalidate(IP_BLACKLIST_PARAM)
    }
  })

  it('@RateLimit: the 21st call within a minute from one IP → 429 too_many_requests; body validated → 400', async () => {
    const ip = nextIp()
    for (let i = 0; i < 20; i++) {
      const res = await http()
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ password: 'x' })
      expect(res.status).toBe(400)
    }
    const res = await http().post('/api/auth/login').set('X-Forwarded-For', ip).send({})
    expect(res.status).toBe(429)
    expect(res.body.code).toBe(Err.TOO_MANY_REQUESTS.code)
    // other IPs are unaffected
    await http().post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({}).expect(400)
  })
})

describe('session', () => {
  it('refresh rotates: new pair, old access token dead, cookie kind kept (session / persistent)', async () => {
    await user('rot')
    for (const keepSignedIn of [false, true]) {
      const first = await signedIn('rot', { keepSignedIn })
      const res = await refresh(first.cookie).expect(200)
      const next = res.body.data.accessToken as string
      expect(next).not.toBe(first.access)
      expect(res.body.data.expiresIn).toBe(1800)
      const cookie = cookieOf(res)
      for (const attr of [/; Path=\/api\/auth/, /; HttpOnly/, /; SameSite=Strict/])
        expect(cookie).toMatch(attr)
      expect(cookie.split(';')[0]).not.toBe(first.cookie.split(';')[0])
      if (keepSignedIn) expect(cookie).toMatch(/; Max-Age=\d+;/)
      else expect(cookie).not.toMatch(/Max-Age|Expires/i)
      expect(await alive(first.access)).toBe(false)
      expect(await alive(next)).toBe(true)
    }
  })

  it('Origin: missing or foreign → 403 origin_rejected; own origin or CORS_ORIGIN → ok', async () => {
    await user('orig')
    const { cookie } = await signedIn('orig')
    for (const origin of [null, 'https://evil.example', 'null']) {
      const res = await refresh(cookie, { origin })
      expect(res.status).toBe(403)
      expect(res.body.code).toBe(Err.AUTH_ORIGIN_REJECTED.code)
    }
    const cfg = app.get(AppConfigService)
    const get = cfg.get.bind(cfg)
    vi.spyOn(cfg, 'get').mockImplementation(((k: string) =>
      k === 'CORS_ORIGIN'
        ? 'http://localhost:5173, https://admin.example'
        : get(k as never)) as typeof cfg.get)
    const res = await refresh(cookie, { origin: 'https://admin.example' }).expect(200)
    await refresh(cookieOf(res), { origin: selfOrigin() }).expect(200)
  })

  it('no, unknown or revoked cookie → 401 refresh_rejected and the cookie is cleared', async () => {
    for (const cookie of ['', 'qw_rt=not-a-real-token', 'qw_rt=x;y']) {
      const res = await refresh(cookie)
      expect(res.status).toBe(401)
      expect(res.body.code).toBe(Err.AUTH_REFRESH_REJECTED.code)
      expect(cookieOf(res)).toMatch(/^qw_rt=; Path=\/api\/auth; Expires=Thu, 01 Jan 1970/)
    }
  })

  it('two parallel refreshes of one cookie both succeed with the same new pair', async () => {
    await user('tabs')
    const { cookie } = await signedIn('tabs')
    const [a, b] = await Promise.all([refresh(cookie), refresh(cookie)])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.body.data.accessToken).toBe(b.body.data.accessToken)
    expect(cookieOf(a).split(';')[0]).toBe(cookieOf(b).split(';')[0])
    expect(await alive(a.body.data.accessToken)).toBe(true)
  })

  it('replay after the grace window or from another UA revokes the whole chain (refresh_reuse logged)', async () => {
    const id = await user('replay')
    // after the window
    let s = await signedIn('replay')
    let rotated = await refresh(s.cookie).expect(200)
    freezeAt(Date.now() + REFRESH_GRACE_MS + 1000)
    expect((await refresh(s.cookie)).status).toBe(401)
    vi.useRealTimers()
    expect(await alive(rotated.body.data.accessToken)).toBe(false)
    expect((await refresh(cookieOf(rotated))).status).toBe(401)

    // inside the window, another UA
    s = await signedIn('replay')
    rotated = await refresh(s.cookie).expect(200)
    expect((await refresh(s.cookie, { ua: 'curl/8.9.1' })).status).toBe(401)
    expect(await alive(rotated.body.data.accessToken)).toBe(false)

    const reuse = (await signinLog(`${PREFIX}replay`, 4)).filter((r) => r.kind === 'refresh_reuse')
    expect(reuse).toEqual([
      expect.objectContaining({ user_id: id, ok: 0, msg_key: 'signin.refresh_reuse' }),
      expect.objectContaining({ user_id: id, ok: 0, msg_key: 'signin.refresh_reuse' }),
    ])
  })

  it('absoluteExpAt: past it the access token and the refresh cookie are dead (401)', async () => {
    await user('abs')
    const { access, cookie } = await signedIn('abs')
    const session = (await tokens.authenticate(access))!
    freezeAt(session.absoluteExpAt + 1)
    expect(
      (await http().post('/api/auth/verify-password').set(bearer(access)).send({ password: PW }))
        .status,
    ).toBe(401)
    expect((await refresh(cookie)).status).toBe(401)
  })

  it('logout: session revoked, cookie cleared, signout logged; the old tokens are dead', async () => {
    const id = await user('bye')
    const { access, cookie } = await signedIn('bye')
    const res = await http().post('/api/auth/logout').set(bearer(access)).expect(200)
    expect(res.body.data).toBeNull()
    expect(cookieOf(res)).toMatch(/^qw_rt=; Path=\/api\/auth; Expires=Thu, 01 Jan 1970/)
    expect(await alive(access)).toBe(false)
    expect((await http().post('/api/auth/logout').set(bearer(access))).status).toBe(401)
    expect((await refresh(cookie)).status).toBe(401)
    const [, out] = await signinLog(`${PREFIX}bye`, 2)
    expect(out).toMatchObject({ kind: 'signout', user_id: id, ok: 1, msg_key: 'signin.signout' })
  })

  it('logout also ends the session of the presented cookie (another tab signed in again)', async () => {
    await user('tabs2')
    const older = await signedIn('tabs2')
    const newer = await signedIn('tabs2')
    await http()
      .post('/api/auth/logout')
      .set(bearer(older.access))
      .set('Cookie', newer.cookie.split(';')[0]!)
      .expect(200)
    expect(await alive(older.access)).toBe(false)
    expect(await alive(newer.access)).toBe(false)
    expect((await refresh(newer.cookie)).status).toBe(401)
  })

  it('verify-password: wrong passwords across IPs revoke every session, independent of sign-in failures', async () => {
    const id = await user('lock')
    const ip = nextIp()
    const { access } = await signedIn('lock', { ip })
    const second = await signedIn('lock')
    const verify = (password: string, from = nextIp()) =>
      http()
        .post('/api/auth/verify-password')
        .set('X-Forwarded-For', from)
        .set(bearer(access))
        .send({ password })
    await verify(PW).expect(200)
    // Sign-in failures stay in the username+IP bucket and do not advance the current-password bucket.
    await login(`${PREFIX}lock`, 'Wrong#pass1', { ip }).expect(401)
    await login(`${PREFIX}lock`, 'Wrong#pass1', { ip }).expect(401)
    expect(await failCount('cur', String(id))).toBe(0)
    for (let i = 0; i < 4; i++) {
      const res = await verify('Wrong#pass1')
      expect(res.status).toBe(400)
      expect(res.body.code).toBe(Err.AUTH_PASSWORD_WRONG.code)
    }
    expect(await failCount('cur', String(id))).toBe(4)
    expect(await failCount('p', `${PREFIX}lock`, ip)).toBe(2)
    const last = await verify('Wrong#pass1')
    expect(last.status).toBe(401)
    expect(last.body.code).toBe(Err.AUTH_SESSION_EXPIRED.code)
    expect(await alive(access)).toBe(false)
    expect(await alive(second.access)).toBe(false)
    expect((await refresh(second.cookie)).status).toBe(401)
    const log = await signinLog(`${PREFIX}lock`, 5)
    expect(log.at(-1)).toMatchObject({
      kind: 'locked',
      ok: 0,
      msg_key: 'signin.password_check_exceeded',
    })
    expect(await failCount('p', `${PREFIX}lock`, ip)).toBe(2)
    await login(`${PREFIX}lock`, PW, { ip }).expect(200)
  })

  it('verify-password: a correct check and a password sign-in each reset the user counter', async () => {
    const id = await user('reset')
    const ip = nextIp()
    const { access } = await signedIn('reset', { ip })
    const verify = (password: string) =>
      http()
        .post('/api/auth/verify-password')
        .set('X-Forwarded-For', ip)
        .set(bearer(access))
        .send({ password })
    for (let i = 0; i < 4; i++) await verify('Wrong#pass1').expect(400)
    await verify(PW).expect(200)
    expect(await failCount('cur', String(id))).toBe(0)
    for (let i = 0; i < 4; i++) await verify('Wrong#pass1').expect(400)
    expect(await alive(access)).toBe(true)
    await login(`${PREFIX}reset`, PW).expect(200)
    expect(await failCount('cur', String(id))).toBe(0)
    for (let i = 0; i < 4; i++) await verify('Wrong#pass1').expect(400)
    expect(await alive(access)).toBe(true)
  })

  it('verify-password: parallel guesses reach bcrypt at most threshold times; past it the right password is refused unchecked', async () => {
    const id = await user('guess')
    const a = await signedIn('guess')
    const b = await signedIn('guess')
    const [{ password_hash: hash }] = await ds.query<{ password_hash: string }[]>(
      'SELECT password_hash FROM iam_user WHERE id = ?',
      [id],
    )
    const { lockThreshold } = (await app.get(AuthParams).load()).security
    const compare = bcrypt.compare
    let open = () => {}
    const gate = new Promise<void>((resolve) => (open = resolve))
    // this user's wrong guesses wait inside bcrypt until the gate opens: all of them are in flight at once
    const spy = vi.spyOn(bcrypt, 'compare').mockImplementation((async (s: string, h: string) => {
      if (h === hash && s !== PW) await gate
      return compare(s, h)
    }) as typeof bcrypt.compare)
    const checks = () => spy.mock.calls.filter((c) => c[1] === hash).length
    const verify = (access: string, password: string) =>
      http()
        .post('/api/auth/verify-password')
        .set('X-Forwarded-For', nextIp())
        .set(bearer(access))
        .send({ password })
    try {
      const wrong = Array.from({ length: lockThreshold }, (_, i) =>
        verify(i % 2 ? b.access : a.access, `Wrong#pass${i}`).then((res) => res),
      )
      await vi.waitFor(() => expect(checks()).toBe(lockThreshold), { timeout: 5000 })
      const right = await verify(b.access, PW)
      expect(right.status).toBe(401)
      expect(right.body.code).toBe(Err.AUTH_SESSION_EXPIRED.code)
      expect(await alive(a.access)).toBe(false)
      expect(await alive(b.access)).toBe(false)
      const late = await Promise.all([verify(a.access, 'Wrong#late'), verify(b.access, PW)])
      expect(late.map((res) => res.status)).toEqual([401, 401])
      open()
      const answers = (await Promise.all(wrong)).map((res) => res.status).sort()
      expect(answers).toEqual([...Array<number>(lockThreshold - 1).fill(400), 401])
      expect(checks()).toBe(lockThreshold)
      expect(await failCount('cur', String(id))).toBe(lockThreshold + 1)
      const locked = (await signinLog(`${PREFIX}guess`, 4)).filter((r) => r.kind === 'locked')
      expect(locked).toHaveLength(2)
      expect(locked[0]).toMatchObject({ ok: 0, msg_key: 'signin.password_check_exceeded' })
    } finally {
      open()
    }
  })

  it('verify-password: at most 20 checks a minute per user and 60 per client IP (an IPv6 /64 is one IP)', async () => {
    const verify = (access: string, ip: string, password = PW) =>
      http()
        .post('/api/auth/verify-password')
        .set('X-Forwarded-For', ip)
        .set(bearer(access))
        .send({ password })
    const tooMany = (res: request.Response) => {
      expect(res.status).toBe(429)
      expect(res.body.code).toBe(Err.TOO_MANY_REQUESTS.code)
    }
    const id = await user('pace')
    const { access } = await signedIn('pace')
    for (let i = 0; i < 20; i++) await verify(access, nextIp()).expect(200)
    const [{ password_hash: hash }] = await ds.query<{ password_hash: string }[]>(
      'SELECT password_hash FROM iam_user WHERE id = ?',
      [id],
    )
    const compare = vi.spyOn(bcrypt, 'compare')
    tooMany(await verify(access, nextIp(), 'Wrong#pass1'))
    // refused before the password check: no attempt reserved, no bcrypt, a wrong guess not counted
    expect(compare.mock.calls.filter((c) => c[1] === hash)).toEqual([])
    expect(await failCount('cur', String(id))).toBe(0)
    // a one-minute window, not a lifetime budget
    const inWindow = async (key: string) => {
      const ttl = await redis.pTTL(key)
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(60_000)
    }
    await inWindow(redisKey('authFail', 'vp', 'u', id))

    const sameNet = (n: number) => `2001:db8:77:1::${n.toString(16)}`
    let n = 0
    for (const name of ['pace1', 'pace2', 'pace3']) {
      await user(name)
      const other = await signedIn(name)
      for (let i = 0; i < 20; i++) await verify(other.access, sameNet(++n)).expect(200)
    }
    await user('pace4')
    const fourth = await signedIn('pace4')
    tooMany(await verify(fourth.access, '2001:db8:77:1:ffff:ffff:ffff:ffff'))
    await inWindow(redisKey('authFail', 'vp', 'ip', smsIpBucket('2001:db8:77:1::1')))
    await verify(fourth.access, '2001:db8:77:2::1').expect(200)
  })
})

describe('mobile client', () => {
  const MOBILE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50'

  /** Signs `name` in as the `mobile` client; the refresh token comes back in the body. */
  async function mobileIn(name: string, keepSignedIn = true) {
    const res = await http()
      .post('/api/auth/login')
      .set('X-Forwarded-For', nextIp())
      .set('User-Agent', MOBILE_UA)
      .send({ username: PREFIX + name, password: PW, keepSignedIn, clientId: 'mobile' })
      .expect(200)
    const { accessToken, refreshToken } = res.body.data as Record<string, string>
    return { res, access: accessToken!, rt: refreshToken! }
  }

  /** POST /refresh with the token in the body and no Origin (a mini program sends none). */
  const bodyRefresh = (refreshToken: string, ua = MOBILE_UA) =>
    http()
      .post('/api/auth/refresh')
      .set('X-Forwarded-For', nextIp())
      .set('User-Agent', ua)
      .send({ refreshToken })

  const rejected = (res: request.Response) => {
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(Err.AUTH_REFRESH_REJECTED.code)
  }

  /** `kind`/`client_id` of the sign-in log rows of `name`, oldest first, once there are `count`. */
  const clientLog = (name: string, count: number) =>
    vi.waitFor(
      async () => {
        const rows = await ds.query<{ kind: string; client_id: string }[]>(
          'SELECT kind, client_id FROM aud_signin_log WHERE username = ? ORDER BY id',
          [PREFIX + name],
        )
        if (rows.length < count) throw new Error(`${rows.length}/${count} sign-in rows`)
        return rows
      },
      { timeout: 5000 },
    )

  it('sign-in: both tokens in the body and no cookie; a mobile session AuthGuard accepts; logged as mobile', async () => {
    const id = await user('mob')
    const { res, access } = await mobileIn('mob')
    expect(res.body.data).toEqual({
      accessToken: expect.stringMatching(/^[\w-]{43}$/),
      expiresIn: 1800,
      refreshToken: expect.stringMatching(/^[\w-]{43}$/),
      refreshExpiresIn: 604_800,
    })
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(await tokens.authenticate(access)).toMatchObject({
      userId: id,
      clientId: 'mobile',
      keepSignedIn: true,
    })
    const me = await http().get('/api/auth/me').set(bearer(access)).expect(200)
    expect(me.body.data.user.id).toBe(id)
    expect(await clientLog('mob', 1)).toEqual([{ kind: 'password', client_id: 'mobile' }])
    // only first-party clients sign in here: an OAuth2 client id is a 400
    const other = await http()
      .post('/api/auth/login')
      .set('X-Forwarded-For', nextIp())
      .send({ username: `${PREFIX}mob`, password: PW, clientId: 'probe-app' })
    expect(other.status).toBe(400)
  })

  it('refresh: the body token rotates without Origin; parallel refreshes share one pair; a replay after the window revokes the chain', async () => {
    await user('mrot')
    const m = await mobileIn('mrot')
    const [a, b] = await Promise.all([bodyRefresh(m.rt), bodyRefresh(m.rt)])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(b.body.data).toEqual(a.body.data)
    expect(a.body.data).toEqual({
      accessToken: expect.stringMatching(/^[\w-]{43}$/),
      expiresIn: 1800,
      refreshToken: expect.stringMatching(/^[\w-]{43}$/),
      refreshExpiresIn: expect.any(Number),
    })
    expect(a.body.data.refreshToken).not.toBe(m.rt)
    expect(a.headers['set-cookie']).toBeUndefined()
    expect(await alive(m.access)).toBe(false)
    const next = await bodyRefresh(a.body.data.refreshToken).expect(200)
    expect(await alive(next.body.data.accessToken)).toBe(true)

    freezeAt(Date.now() + REFRESH_GRACE_MS + 1000)
    rejected(await bodyRefresh(m.rt))
    vi.useRealTimers()
    expect(await alive(next.body.data.accessToken)).toBe(false)
    rejected(await bodyRefresh(next.body.data.refreshToken))
    const rows = await clientLog('mrot', 2)
    expect(rows.find((r) => r.kind === 'refresh_reuse')).toEqual({
      kind: 'refresh_reuse',
      client_id: 'mobile',
    })
  })

  it('the channels never cross: a console token in the body and a mobile token in the cookie are refused untouched', async () => {
    await user('cross')
    const c = await signedIn('cross')
    const consoleRt = c.cookie.split(';')[0]!.slice('qw_rt='.length)
    const inBody = await bodyRefresh(consoleRt, CHROME)
    rejected(inBody)
    // nothing to clear: the body channel never touches the cookie
    expect(cookieOf(inBody)).toBe('')
    expect(await alive(c.access)).toBe(true)
    const rotated = await refresh(c.cookie).expect(200)
    // within the grace window the rotated console token still unlocks nothing through the body
    rejected(await bodyRefresh(consoleRt, CHROME))
    expect(await alive(rotated.body.data.accessToken)).toBe(true)

    const m = await mobileIn('cross')
    rejected(await refresh(`qw_rt=${m.rt}`, { ua: MOBILE_UA }))
    expect(await alive(m.access)).toBe(true)
    await bodyRefresh(m.rt).expect(200)
  })

  it('absolute cap and revocation unchanged: past absoluteExpAt or after sign-out the body token is dead', async () => {
    await user('mcap')
    const short = await mobileIn('mcap', false)
    const session = (await tokens.authenticate(short.access))!
    expect(session.absoluteExpAt - session.loginAt).toBe(ABSOLUTE_MS.session)
    expect(short.res.body.data.refreshExpiresIn).toBe(ABSOLUTE_MS.session / 1000)
    freezeAt(session.absoluteExpAt + 1)
    rejected(await bodyRefresh(short.rt))
    vi.useRealTimers()

    const m = await mobileIn('mcap')
    await http().post('/api/auth/logout').set(bearer(m.access)).expect(200)
    rejected(await bodyRefresh(m.rt))
    const rows = await clientLog('mcap', 3)
    expect(rows.at(-1)).toEqual({ kind: 'signout', client_id: 'mobile' })
  })

  it('token isolation: mobile and console sessions pass AuthGuard, a third-party (OAuth2) session still gets 401', async () => {
    const id = await user('third')
    const u = (await app.get(PermVersion).load(id))!
    const opts = { keepSignedIn: false, ip: '127.0.0.1', ua: 'probe' }
    const other = await tokens.issue(u, { ...opts, clientId: 'probe-app', scopes: ['user.read'] })
    expect((await http().get('/api/auth/me').set(bearer(other.accessToken))).status).toBe(401)
    for (const clientId of ['mobile', 'console']) {
      const s = await tokens.issue(u, { ...opts, clientId })
      await http().get('/api/auth/me').set(bearer(s.accessToken)).expect(200)
    }
  })
})

describe('me', () => {
  const m: Record<string, number> = {}
  const roles: number[] = []

  const menu = (key: string, parentId: number, kind: string, extra: Record<string, unknown> = {}) =>
    insertRow(ds.manager, 'iam_menu', {
      parent_id: parentId,
      kind,
      name: `test.authE2e.${key}`,
      ...(kind === 'action'
        ? { perms: `test.authE2e.${key}` }
        : { route_name: `auth-e2e-${key}`, route_path: `/auth-e2e/${key}` }),
      ...extra,
    })

  async function role(code: string, menuIds: number[], extra: Record<string, unknown> = {}) {
    const id = await insertRow(ds.manager, 'iam_role', {
      code: PREFIX + code,
      name: PREFIX + code,
      data_scope: 'own_dept',
      sort_no: roles.length,
      ...extra,
    })
    roles.push(id)
    for (const menuId of menuIds)
      await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [id, menuId])
    return id
  }

  async function userWithRoles(name: string, roleIds: number[]) {
    const id = await user(name)
    for (const roleId of roleIds)
      await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, roleId])
    return id
  }

  const get = async (path: string, access: string) =>
    (await http().get(`/api/auth/${path}`).set(bearer(access)).expect(200)).body.data

  beforeAll(async () => {
    m.g = await menu('g', 0, 'group', { sort_no: 500, icon: 'folder' })
    m.p1 = await menu('p1', m.g, 'page', {
      sort_no: 2,
      component: 'test/p1/index',
      component_name: 'TestP1',
      keep_alive: 1,
    })
    m.a1 = await menu('a1', m.p1, 'action')
    m.p2 = await menu('p2', m.g, 'page', { sort_no: 1, visible: 0 })
    m.p4 = await menu('p4', m.g, 'page', { sort_no: 4, enabled: 0 })
    m.p5 = await menu('p5', m.g, 'page', { sort_no: 5 })
    m.gOff = await menu('goff', 0, 'group', { sort_no: 501, enabled: 0 })
    m.p3 = await menu('p3', m.gOff, 'page')
    const a = await role('a', [m.a1])
    const b = await role('b', [m.p2, m.p3, m.p4])
    const off = await role('off', [m.p5], { enabled: 0 })
    await userWithRoles('menu-a', [a])
    await userWithRoles('menu-b', [a, b, off])
  })

  afterAll(async () => {
    await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roles])
    await ds.query('DELETE FROM iam_user_roles WHERE role_id IN (?)', [roles])
    await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roles])
    await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [Object.values(m)])
  })

  it('GET /me: profile with dept and enabled role names, enabled role codes, perms, flags and the password policy; 401 without a session', async () => {
    const { access } = await signedIn('menu-b', { headers: { 'X-Timezone': 'Asia/Singapore' } })
    const me = await get('me', access)
    expect(me).toEqual({
      user: {
        id: expect.any(Number),
        username: `${PREFIX}menu-b`,
        displayName: 'menu-b',
        avatarUrl: null,
        deptId: null,
        deptName: null,
        // enabled roles only (`off` is disabled)
        roleNames: [`${PREFIX}a`, `${PREFIX}b`],
        locale: null,
        timezone: 'Asia/Singapore',
      },
      roles: [`${PREFIX}a`, `${PREFIX}b`],
      perms: ['test.authE2e.a1'],
      flags: { mustChangePassword: false, passwordExpired: false },
      policy: { minLength: 8, charClasses: 2, expireDays: 0 },
      lastSignInAt: null,
    })
    expect((await http().get('/api/auth/me')).status).toBe(401)
    expect((await http().get('/api/auth/menus')).status).toBe(401)
  })

  it('GET /me lastSignInAt: the latest successful password/SMS sign-in before this session; never its own, a failure, a sign-out, a deleted row, another user or a later session', async () => {
    const id = await user('last')
    const other = await user('last-other')
    const name = `${PREFIX}last`
    const log = (
      kind: string,
      ok: number,
      at: string,
      userId = id,
      deletedAt: Date | null = null,
    ) =>
      insertRow(ds.manager, 'aud_signin_log', {
        kind,
        user_id: userId,
        username: name,
        client_id: 'console',
        ok,
        msg_key: 'signin.ok',
        created_at: new Date(at),
        deleted_at: deletedAt,
      })
    // the app clock 0.5 s ahead of the DB's: the session's own row still is no earlier sign-in
    freezeAt(Date.now() + 500)
    const first = await signedIn('last')
    vi.useRealTimers()
    await signinLog(name, 1)
    expect((await get('me', first.access)).lastSignInAt).toBeNull()

    await log('password', 1, '2020-01-01T00:00:00Z')
    await log('sms', 1, '2020-01-02T08:00:00Z')
    await log('password', 0, '2020-01-03T00:00:00Z')
    await log('signout', 1, '2020-01-04T00:00:00Z')
    await log('password', 1, '2020-01-05T00:00:00Z', other)
    await log('password', 1, '2020-01-06T00:00:00Z', id, new Date())
    expect((await get('me', first.access)).lastSignInAt).toBe('2020-01-02T08:00:00.000Z')

    // a sign-in past the 1 s clock slack: its previous one is the first session's; the first
    // session's stays
    await new Promise((r) => setTimeout(r, 1100))
    const [own] = await ds.query<{ at: Date }[]>(
      `SELECT created_at AS at FROM aud_signin_log WHERE user_id = ? AND created_at > '2021-01-01'`,
      [id],
    )
    const second = await signedIn('last')
    await signinLog(name, 8)
    expect((await get('me', second.access)).lastSignInAt).toBe(own!.at.toISOString())
    expect((await get('me', first.access)).lastSignInAt).toBe('2020-01-02T08:00:00.000Z')

    // one lookup in the user's rows (idx user_id + created_at), not a walk back along created_at
    const [plan] = await ds.query<{ key: string | null }[]>(
      `EXPLAIN FORMAT=TRADITIONAL ${LAST_SIGNIN_SQL}`,
      [id, new Date()],
    )
    expect(plan!.key).toBe('idx_aud_signin_log_user_created')
  })

  it('GET /menus: a role granted one action sees the full group → page path; actions never appear', async () => {
    const { access } = await signedIn('menu-a')
    expect(await get('menus', access)).toEqual([
      expect.objectContaining({
        id: m.g,
        parentId: 0,
        kind: 'group',
        name: 'test.authE2e.g',
        icon: 'folder',
        visible: true,
        children: [
          {
            id: m.p1,
            parentId: m.g,
            kind: 'page',
            name: 'test.authE2e.p1',
            nameI18n: null,
            routePath: '/auth-e2e/p1',
            routeName: 'auth-e2e-p1',
            component: 'test/p1/index',
            componentName: 'TestP1',
            routeQuery: null,
            linkType: 'route',
            linkUrl: null,
            icon: null,
            visible: true,
            keepAlive: true,
            alwaysShow: false,
            sortNo: 2,
            children: [],
          },
        ],
      }),
    ])
  })

  it('GET /menus: union of enabled roles, hidden pages flagged, disabled menus/ancestors/roles excluded', async () => {
    const { access } = await signedIn('menu-b')
    const tree = await get('menus', access)
    expect(tree.map((n: { id: number }) => n.id)).toEqual([m.g])
    expect(
      tree[0].children.map((c: { id: number; visible: boolean }) => [c.id, c.visible]),
    ).toEqual([
      [m.p2, false],
      [m.p1, true],
    ])
  })

  it('GET /menus for root: every enabled menu, seeded ones included, with their ancestors', async () => {
    const [root] = await ds.query<{ id: number }[]>("SELECT id FROM iam_role WHERE code = 'root'")
    await userWithRoles('root', [root!.id])
    const { access } = await signedIn('root')
    const tree = (await get('menus', access)) as {
      id: number
      routeName: string | null
      children: { id: number; routeName: string | null }[]
    }[]
    const names = tree.map((n) => n.routeName)
    expect(names).toEqual(
      expect.arrayContaining(['home', 'system', 'monitor', 'devtools', 'auth-e2e-g']),
    )
    expect(names).not.toContain('auth-e2e-goff')
    const settings = tree.find((n) => n.routeName === 'system')!
    expect(settings.children.map((c) => c.routeName)).toContain('settings-dict')
    const g = tree.find((n) => n.id === m.g)!
    expect(g.children.map((c) => c.id)).toEqual([m.p2, m.p1, m.p5])
  })

  it('GET /menus: a menu of a switched-off feature is never delivered (the API docs page without SWAGGER_ENABLED)', async () => {
    const [root] = await ds.query<{ id: number }[]>("SELECT id FROM iam_role WHERE code = 'root'")
    await userWithRoles('root-docs', [root!.id])
    const { access } = await signedIn('root-docs')
    const devtools = async () =>
      ((await get('menus', access)) as MenuNode[]).find((n) => n.routeName === 'devtools')!.children
    // on in .env.test: the seeded iframe page on the Swagger UI
    expect(await devtools()).toContainEqual(
      expect.objectContaining({
        routeName: 'devtools-api-docs',
        linkType: 'iframe',
        linkUrl: '/api/docs',
      }),
    )
    const cfg = app.get(AppConfigService)
    const get0 = cfg.get.bind(cfg)
    vi.spyOn(cfg, 'get').mockImplementation(((key: Parameters<typeof cfg.get>[0]) =>
      key === 'SWAGGER_ENABLED' ? false : get0(key)) as typeof cfg.get)
    const off = await devtools()
    expect(off.map((c) => c.routeName)).not.toContain('devtools-api-docs')
    expect(off.map((c) => c.routeName)).toContain('codegen-table')
  })
})

describe('deleted rows grant nothing', () => {
  const made = { menus: [] as number[], roles: [] as number[] }

  afterAll(async () => {
    if (made.roles.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [made.roles])
      await ds.query('DELETE FROM iam_user_roles WHERE role_id IN (?)', [made.roles])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [made.roles])
    }
    if (made.menus.length) await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [made.menus])
  })

  it('a removed role link or menu grant, a deleted role or menu: gone from /me and /menus at the next reload', async () => {
    const menu = async (key: string, parentId: number, kind: string) => {
      const id = await insertRow(ds.manager, 'iam_menu', {
        parent_id: parentId,
        kind,
        name: `test.authE2e.${key}`,
        ...(kind === 'action'
          ? { perms: `test.authE2e.${key}` }
          : { route_name: `auth-e2e-${key}`, route_path: `/auth-e2e/${key}` }),
      })
      made.menus.push(id)
      return id
    }
    const group = await menu('del-g', 0, 'group')
    const page = await menu('del-p', group, 'page')
    const userId = await user('deleted-grants')
    // one role per case, each granted its own action
    const cases = ['del-link', 'del-grant', 'del-role', 'del-menu'] as const
    const role: Record<string, number> = {}
    const action: Record<string, number> = {}
    for (const key of cases) {
      action[key] = await menu(key, page, 'action')
      role[key] = await insertRow(ds.manager, 'iam_role', {
        code: PREFIX + key,
        name: PREFIX + key,
        data_scope: 'own_dept',
      })
      made.roles.push(role[key])
      await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
        role[key],
        action[key],
      ])
      await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [
        userId,
        role[key],
      ])
    }
    const { access } = await signedIn('deleted-grants')
    const get = async (path: string) =>
      (await http().get(`/api/auth/${path}`).set(bearer(access)).expect(200)).body.data
    const sorted = (xs: string[]) => [...xs].sort()
    expect(sorted((await get('me')).perms)).toEqual(sorted(cases.map((k) => `test.authE2e.${k}`)))
    expect((await get('menus')).map((n: MenuNode) => n.id)).toEqual([group])

    // each row soft-deleted the way the services delete: the link (revoke), the grant (menus replaced), the
    // role, the menu (older data: a menu deleted with a live grant, no foreign keys)
    await ds.query(
      'UPDATE iam_user_roles SET deleted_at = NOW(3) WHERE user_id = ? AND role_id = ?',
      [userId, role['del-link']],
    )
    await ds.query('UPDATE iam_role_menus SET deleted_at = NOW(3) WHERE role_id = ?', [
      role['del-grant'],
    ])
    await ds.query('UPDATE iam_role SET deleted_at = NOW(3) WHERE id = ?', [role['del-role']])
    await ds.query('UPDATE iam_menu SET deleted_at = NOW(3) WHERE id = ?', [action['del-menu']])
    await app.get(PermVersion).bumpUser(userId)
    const me = await get('me')
    expect(me.perms).toEqual([])
    const held = sorted([`${PREFIX}del-grant`, `${PREFIX}del-menu`])
    expect(sorted(me.roles)).toEqual(held)
    expect(sorted(me.user.roleNames)).toEqual(held)
    expect(await get('menus')).toEqual([])
  })
})

describe('password', () => {
  const NEW = 'Brand-new#2026'
  const change = (access: string, body: Record<string, unknown>, lang = 'en-US') =>
    http()
      .put('/api/iam/profile/password')
      .set('X-Forwarded-For', nextIp())
      .set('Accept-Language', lang)
      .set(bearer(access))
      .send(body)
  const me = (access: string) => http().get('/api/auth/me').set(bearer(access))
  const lockScreen = (access: string, password: string) =>
    http().post('/api/auth/verify-password').set(bearer(access)).send({ password })

  it('never-changed password (seed without SEED_ADMIN_PASSWORD): only me/menus/change/logout until changed; then other sessions are gone', async () => {
    const id = await user('fresh', { password_changed_at: null })
    const s1 = await signedIn('fresh')
    const s2 = await signedIn('fresh')
    expect((await me(s1.access).expect(200)).body.data.flags).toEqual({
      mustChangePassword: true,
      passwordExpired: false,
    })
    await http().get('/api/auth/menus').set(bearer(s1.access)).expect(200)
    const gated = await lockScreen(s1.access, PW)
    expect(gated.status).toBe(403)
    expect(gated.body.code).toBe(Err.AUTH_PASSWORD_CHANGE_REQUIRED.code)

    await change(s1.access, { oldPassword: PW, newPassword: NEW }).expect(200)
    // same session: flags cleared, gate lifted
    expect((await me(s1.access).expect(200)).body.data.flags).toEqual({
      mustChangePassword: false,
      passwordExpired: false,
    })
    await lockScreen(s1.access, NEW).expect(200)
    // other sessions: revoked (access and refresh)
    expect((await me(s2.access)).status).toBe(401)
    expect((await refresh(s2.cookie)).status).toBe(401)
    await refresh(s1.cookie).expect(200)

    const [row] = await ds.query<{ password_changed_at: Date; updated_by: number }[]>(
      'SELECT password_changed_at, updated_by FROM iam_user WHERE id = ?',
      [id],
    )
    expect(Date.now() - row!.password_changed_at.getTime()).toBeLessThan(10_000)
    expect(row!.updated_by).toBe(id)
    await login(`${PREFIX}fresh`, PW).expect(401)
    await login(`${PREFIX}fresh`, NEW).expect(200)
  })

  it('expired password (older than iam.password_expire_days) → passwordExpired gate', async () => {
    await user('old', { password_changed_at: new Date(Date.now() - 100 * 86_400_000) })
    await ds.query(
      "UPDATE cfg_param SET param_value = '90' WHERE param_key = 'iam.password_expire_days'",
    )
    await app.get(ParamService).invalidate('iam.password_expire_days')
    try {
      const { access } = await signedIn('old')
      const res = await me(access).expect(200)
      expect(res.body.data.flags).toEqual({ mustChangePassword: false, passwordExpired: true })
      expect(res.body.data.policy.expireDays).toBe(90)
      expect((await lockScreen(access, PW)).status).toBe(403)
      await change(access, { oldPassword: PW, newPassword: NEW }).expect(200)
      await lockScreen(access, NEW).expect(200)
    } finally {
      await ds.query(
        "UPDATE cfg_param SET param_value = '0' WHERE param_key = 'iam.password_expire_days'",
      )
      await app.get(ParamService).invalidate('iam.password_expire_days')
    }
  })

  it('two concurrent changes with the same old password: exactly one wins', async () => {
    await user('race')
    const a = await signedIn('race')
    const b = await signedIn('race')
    const res = await Promise.all([
      change(a.access, { oldPassword: PW, newPassword: 'Winner-one#2026' }),
      change(b.access, { oldPassword: PW, newPassword: 'Winner-two#2026' }),
    ])
    expect(res.map((r) => r.status).sort()).toEqual([200, 400])
    const loser = res.find((r) => r.status === 400)!
    expect(loser.body.code).toBe(Err.AUTH_OLD_PASSWORD_WRONG.code)
    const winner = res[0]!.status === 200 ? 'Winner-one#2026' : 'Winner-two#2026'
    await login(`${PREFIX}race`, winner).expect(200)
  })

  // A sign-in past its password check while another session changes the password: the hook runs the
  // change at a chosen point between the sign-in's bcrypt and its session write.
  describe.each([
    ['after the credver read (issue refuses atomically)', 'issue'],
    ['before the credver read (the second credentials read sees the new hash)', 'credVersion'],
  ] as const)('a sign-in racing a password change, %s', (_, hook) => {
    it('never starts a session with the old password; the change keeps only its own session', async () => {
      const name = `racing-${hook}`
      const id = await user(name)
      const changer = await signedIn(name)
      const original = tokens[hook].bind(tokens) as (...args: unknown[]) => Promise<unknown>
      vi.spyOn(tokens, hook).mockImplementationOnce((async (...args: unknown[]) => {
        await change(changer.access, { oldPassword: PW, newPassword: NEW }).expect(200)
        return original(...args)
      }) as never)

      const res = await login(`${PREFIX}${name}`, PW)
      expect(res.status).toBe(401)
      expect(res.body.code).toBe(Err.AUTH_BAD_CREDENTIALS.code)
      expect(cookieOf(res)).toBe('')
      // the changer's session is the user's only one
      const sid = (await tokens.authenticate(changer.access))!.sid
      const owned = await redis.mGet(await redis.sMembers(redisKey('authUser', id)))
      expect(new Set(owned.map((v) => (JSON.parse(v!) as { sid: string }).sid))).toEqual(
        new Set([sid]),
      )
      const rows = await signinLog(`${PREFIX}${name}`, 2)
      expect(rows[1]).toMatchObject({ ok: 0, msg_key: 'signin.credentials_changed' })
      // not a guess: no failure counted
      expect(await failCount('u', `${PREFIX}${name}`)).toBe(0)
      await login(`${PREFIX}${name}`, NEW).expect(200)
    })
  })

  it('Swagger documents the auth and password endpoints', async () => {
    const doc = (await http().get('/api/docs-json').expect(200)).body
    for (const path of ['login', 'refresh', 'logout', 'verify-password', 'me', 'menus'])
      expect(doc.paths).toHaveProperty([`/api/auth/${path}`])
    const put = doc.paths['/api/iam/profile/password'].put
    expect(put.requestBody.content['application/json'].schema.properties).toHaveProperty(
      'newPassword',
    )
  })

  it('policy violations, same-as-old and a wrong old password → 400 (translated), nothing changes', async () => {
    const id = await user('weak')
    const { access } = await signedIn('weak')
    const cases: [Record<string, unknown>, string, string][] = [
      [
        { oldPassword: PW, newPassword: 'Ab#1' },
        Err.VALIDATION_FAILED.code,
        'New password must be at least 8 characters',
      ],
      [
        { oldPassword: PW, newPassword: 'alllowercase' },
        Err.VALIDATION_FAILED.code,
        'New password must contain at least 2 of these character types: lowercase letters, uppercase letters, digits, symbols',
      ],
      [
        { oldPassword: PW, newPassword: `A${'é'.repeat(36)}` },
        Err.VALIDATION_FAILED.code,
        'New password must be at most 72 bytes',
      ],
      [
        { oldPassword: PW, newPassword: PW },
        Err.VALIDATION_FAILED.code,
        'The new password must differ from the old one',
      ],
      [
        { oldPassword: 'Not-the-old#1', newPassword: NEW },
        Err.AUTH_OLD_PASSWORD_WRONG.code,
        'The old password is incorrect',
      ],
    ]
    for (const [body, code, msg] of cases) {
      const res = await change(access, body)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe(code)
      expect(res.body.msg).toBe(msg)
      if (code === Err.VALIDATION_FAILED.code) expect(res.body.errors[0].path).toBe('newPassword')
    }
    const zh = await change(access, { oldPassword: PW, newPassword: 'Ab#1' }, 'zh-CN')
    expect(zh.body.msg).toMatch(/^新密码/)
    const [row] = await ds.query<{ password_hash: string }[]>(
      'SELECT password_hash FROM iam_user WHERE id = ?',
      [id],
    )
    expect(await bcrypt.compare(PW, row!.password_hash)).toBe(true)
    expect((await http().put('/api/iam/profile/password').send({})).status).toBe(401)
  })
})
