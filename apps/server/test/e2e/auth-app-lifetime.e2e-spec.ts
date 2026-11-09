// App sessions (see docs/design-notes.md#auth-sessions): only a `mobile` sign-in declaring `mobileKind: 'app'`
// gets the long term (`auth.mobile.session_days`, 0 = a 400-day term renewed by every refresh) and the
// single App session (`auth.app.single_session`: a new App sign-in ends the user's other App sessions with
// `app_replaced`, under a per-user sign-in lock). H5, the WeChat mini program, the console and OAuth keep
// their terms. No real time passes: specs rewrite the session JSON's `loginAt` and read key PTTLs.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { appSessionParams, Err, RT } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AuthService } from '../../src/core/auth/auth.service.js'
import { ownerIndexKey } from '../../src/core/auth/session-revoker.js'
import {
  ABSOLUTE_MS,
  APP_IDLE_MS,
  MAX_SESSION_MS,
  type Session,
  TokenService,
} from '../../src/core/auth/token.service.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { ValidationException } from '../../src/core/http/validation.pipe.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { BuiltinJobs } from '../../src/modules/platform/scheduler/builtin-jobs.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { closeSockets, connect, disconnected, inbox, socketOf } from '../setup/socket.js'
import {
  bootApp,
  createTenant,
  inTenant1,
  type PeopledTenant,
  TENANT_PASSWORD,
} from '../setup/tenants.js'

const PREFIX = 'app-sess-'
const PW = 'AppSess#2026'
const UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36'
const DAY = 86_400_000
const WEEK = ABSOLUTE_MS.keepSignedIn

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let tokens: TokenService
let root: string
let tenant: PeopledTenant
let ipSeq = 0

const http = () => request(app.getHttpServer())
/** A fresh client IP per request (RFC 5737 range), so the sign-in rate limit never trips. */
const nextIp = () => `198.51.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`

/** A user of the default tenant (cheap bcrypt cost). */
const user = (name: string, extra: Record<string, unknown> = {}) =>
  inTenant1(() =>
    insertRow(ds.manager, 'iam_user', {
      username: PREFIX + name,
      display_name: name,
      password_hash: bcrypt.hashSync(PW, 4),
      password_changed_at: new Date(),
      ...extra,
    }),
  )

type Kind = 'app' | 'h5'
/** POST /login as the mobile client (no `kind`: a client of before the field). */
const mobileLogin = (name: string, kind?: Kind, extra: Record<string, unknown> = {}) =>
  http()
    .post('/api/auth/login')
    .set('X-Forwarded-For', nextIp())
    .set('User-Agent', UA)
    .send({
      username: PREFIX + name,
      password: PW,
      keepSignedIn: true,
      clientId: 'mobile',
      ...(kind && { mobileKind: kind }),
      ...extra,
    })

interface Signed {
  access: string
  rt: string
  sid: string
  refreshExpiresIn: number
}
const signed = async (res: request.Response): Promise<Signed> => {
  expect(res.status).toBe(200)
  const { accessToken, refreshToken, refreshExpiresIn } = res.body.data
  const s = await tokens.authenticate(accessToken)
  return { access: accessToken, rt: refreshToken, sid: s!.sid, refreshExpiresIn }
}
const appIn = async (name: string) => signed(await mobileLogin(name, 'app'))

/** POST /refresh with the body token (the mobile channel). */
const bodyRefresh = (rt: string) =>
  http().post('/api/auth/refresh').set('X-Forwarded-For', nextIp()).set('User-Agent', UA).send({
    refreshToken: rt,
  })
const rejected = (res: request.Response) => {
  expect(res.status).toBe(401)
  expect(res.body.code).toBe(Err.AUTH_REFRESH_REJECTED.code)
}
const me = (access: string) => http().get('/api/auth/me').set(bearer(access))

const sessKey = (sid: string) => redisKey('authSession', sid)
const rtKey = async (rt: string) => {
  const { createHash } = await import('node:crypto')
  return redisKey('authRefresh', createHash('sha256').update(rt).digest('hex'))
}
const stored = async (sid: string) => JSON.parse((await redis.get(sessKey(sid)))!) as Session
/** Rewrites fields of a stored session, its TTL kept (time passing without waiting). */
const rewrite = async (sid: string, patch: Partial<Session>) => {
  await redis.set(sessKey(sid), JSON.stringify({ ...(await stored(sid)), ...patch }), {
    expiration: 'KEEPTTL',
  })
}

/** Sets a param through SQL and drops its cache (as the settings page does). */
async function setParam(key: string, value: string) {
  const res = await ds.query<{ affectedRows: number }>(
    'UPDATE cfg_param SET param_value = ? WHERE param_key = ? AND deleted_at IS NULL',
    [value, key],
  )
  expect(res.affectedRows).toBe(1)
  await app.get(ParamService).invalidate(key)
}
const days = (v: number) => setParam(appSessionParams.sessionDays, String(v))
const single = (on: boolean) => setParam(appSessionParams.singleSession, String(on))

/** The user's live App sessions (online list). */
const appSessionsOf = async (userId: number) =>
  (await tokens.online()).filter((s) => s.userId === userId && s.mobileKind === 'app')

/** A WeChat mini program sign-in of `userId` (the identity proof is the WeChat module's; here: given). */
const wxMpIn = (userId: number, mobileKind?: Kind) =>
  withTenant(1, () =>
    app.get(AuthService).signInVerified(
      userId,
      {
        kind: 'wx-mp',
        clientId: 'mobile',
        keepSignedIn: true,
        timezone: null,
        label: '',
        ...(mobileKind && { mobileKind }),
      },
      { ip: nextIp(), ua: UA },
    ),
  )

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  tokens = app.get(TokenService)
  await cleanRedis(redis)
  root = (await signIn(app)).accessToken
  tenant = await createTenant(app, { users: true })
  await days(0)
  await single(true)
})

afterEach(async () => {
  closeSockets()
  vi.restoreAllMocks()
  await days(0)
  await single(true)
})

afterAll(async () => {
  closeSockets()
  if (ds) {
    const like = `${PREFIX}%`
    await ds.query('DELETE FROM iam_user WHERE username LIKE ?', [like])
    await ds.query('DELETE FROM aud_signin_log WHERE username LIKE ?', [like])
    await days(0)
    await single(true)
  }
  await tenant?.dispose()
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('term', () => {
  it('an App session lives 400 days (0 = never expires) and its refresh token as long; H5, the mini program and the console keep 7 days', async () => {
    await user('term')
    const a = await appIn('term')
    const appSession = await stored(a.sid)
    expect(appSession).toMatchObject({ clientId: 'mobile', mobileKind: 'app' })
    expect(appSession.absoluteExpAt - appSession.loginAt).toBe(APP_IDLE_MS)
    expect(await redis.pTTL(sessKey(a.sid))).toBeGreaterThan(WEEK)
    expect(await redis.pTTL(await rtKey(a.rt))).toBeGreaterThan(WEEK)
    expect(a.refreshExpiresIn).toBeGreaterThan(WEEK / 1000)
    expect(await redis.pTTL(ownerIndexKey(appSession))).toBeGreaterThan(WEEK)

    const h5 = await signed(await mobileLogin('term', 'h5'))
    // a client that declares nothing keeps the rules it always had
    const legacy = await signed(await mobileLogin('term'))
    for (const s of [h5, legacy]) {
      const session = await stored(s.sid)
      expect(session.absoluteExpAt - session.loginAt).toBe(WEEK)
      expect(await redis.pTTL(sessKey(s.sid))).toBeLessThanOrEqual(WEEK)
      expect(s.refreshExpiresIn).toBe(WEEK / 1000)
    }
    expect((await stored(h5.sid)).mobileKind).toBe('h5')
    expect((await stored(legacy.sid)).mobileKind).toBeUndefined()

    const consoleRes = await http()
      .post('/api/auth/login')
      .set('X-Forwarded-For', nextIp())
      .send({ username: `${PREFIX}term`, password: PW, keepSignedIn: true })
      .expect(200)
    const web = (await tokens.authenticate(consoleRes.body.data.accessToken))!
    expect(web.absoluteExpAt - web.loginAt).toBe(WEEK)
    expect(web.mobileKind).toBeUndefined()
  })

  it('the mini program is fixed to mp-weixin by the server and keeps 7 days, whatever the client declares', async () => {
    const id = await user('wx')
    for (const declared of [undefined, 'app'] as const) {
      const t = await wxMpIn(id, declared)
      const s = (await tokens.authenticate(t.accessToken))!
      expect(s.mobileKind).toBe('mp-weixin')
      expect(s.absoluteExpAt - s.loginAt).toBe(WEEK)
      expect(t.refreshExpiresIn).toBe(WEEK / 1000)
    }
  })

  it('refresh slides the term: the session key and the owner index are extended, loginAt never changes', async () => {
    await user('slide')
    const a = await appIn('slide')
    const before = await stored(a.sid)
    // as if most of the term had passed: the keys about to expire
    await redis.pExpire(sessKey(a.sid), 8 * DAY)
    await redis.pExpire(ownerIndexKey(before), 8 * DAY)
    await rewrite(a.sid, { absoluteExpAt: Date.now() + 8 * DAY })

    const res = await bodyRefresh(a.rt).expect(200)
    const after = await stored(a.sid)
    expect(after.loginAt).toBe(before.loginAt)
    expect(after.absoluteExpAt).toBeGreaterThan(Date.now() + APP_IDLE_MS - 60_000)
    expect(await redis.pTTL(sessKey(a.sid))).toBeGreaterThan(APP_IDLE_MS - 60_000)
    expect(await redis.pTTL(ownerIndexKey(after))).toBeGreaterThan(APP_IDLE_MS - 60_000)
    expect(await redis.pTTL(await rtKey(res.body.data.refreshToken))).toBeGreaterThan(WEEK)
    expect(res.body.data.refreshExpiresIn).toBeGreaterThan(WEEK / 1000)
    await me(res.body.data.accessToken).expect(200)

    // an H5 session's rotation leaves its term alone
    const h = await signed(await mobileLogin('slide', 'h5'))
    const h5Before = await stored(h.sid)
    await bodyRefresh(h.rt).expect(200)
    expect((await stored(h.sid)).absoluteExpAt).toBe(h5Before.absoluteExpAt)
    expect(await redis.pTTL(sessKey(h.sid))).toBeLessThanOrEqual(WEEK)
  })

  it('a days term counts from the original sign-in: 0 → 30 ends a 40-day-old session at its refresh (old access dead too), 30 → 0 revives nothing', async () => {
    await user('days')
    const a = await appIn('days')
    await rewrite(a.sid, { loginAt: Date.now() - 40 * DAY })
    await days(30)
    rejected(await bodyRefresh(a.rt))
    await me(a.access).expect(401)
    expect(await redis.exists(sessKey(a.sid))).toBe(0)
    await days(0)
    rejected(await bodyRefresh(a.rt))

    // a young session under a days term: absolute from the sign-in, refresh does not slide it
    await days(30)
    const b = await appIn('days')
    const s = await stored(b.sid)
    expect(s.absoluteExpAt - s.loginAt).toBe(30 * DAY)
    const res = await bodyRefresh(b.rt).expect(200)
    expect((await stored(b.sid)).absoluteExpAt).toBe(s.absoluteExpAt)
    expect((await stored(b.sid)).loginAt).toBe(s.loginAt)
    expect(res.body.data.refreshExpiresIn).toBeGreaterThan(WEEK / 1000)
  })

  it('the sweep ends App sessions past the current term without waiting for a refresh; the online list hides them; last-seen times stay for the App term', async () => {
    await user('sweep')
    const a = await appIn('sweep')
    const h = await signed(await mobileLogin('sweep', 'h5'))
    await rewrite(a.sid, { loginAt: Date.now() - 40 * DAY })
    await rewrite(h.sid, { loginAt: Date.now() - 40 * DAY })
    await days(30)
    const listed = (await tokens.online()).map((s) => s.sid)
    expect(listed).not.toContain(a.sid)
    expect(listed).toContain(h.sid)

    const seen = redisKey('authSeen')
    await redis.zAdd(seen, { score: Date.now() - 100 * DAY, value: 'idle-app-sid' })
    await app.get(BuiltinJobs).sweep()
    expect(await redis.exists(sessKey(a.sid))).toBe(0)
    await me(a.access).expect(401)
    // an H5 session is no App session: the param is not its term
    await me(h.access).expect(200)
    expect(MAX_SESSION_MS).toBeGreaterThanOrEqual(APP_IDLE_MS)
    expect(await redis.zScore(seen, 'idle-app-sid')).not.toBeNull()
  })

  it("never past the tenant's end", async () => {
    const end = Date.now() + 2 * DAY
    await ds.query('UPDATE iam_tenant SET expires_at = ? WHERE id = ?', [new Date(end), tenant.id])
    try {
      const res = await http()
        .post('/api/auth/login')
        .set('X-Forwarded-For', nextIp())
        .set('User-Agent', UA)
        .send({
          username: 'alice',
          password: TENANT_PASSWORD,
          tenantCode: tenant.code,
          keepSignedIn: true,
          clientId: 'mobile',
          mobileKind: 'app',
        })
      const a = await signed(res)
      expect((await stored(a.sid)).absoluteExpAt).toBeLessThanOrEqual(end)
      expect(await redis.pTTL(sessKey(a.sid))).toBeLessThanOrEqual(2 * DAY)
      await bodyRefresh(a.rt).expect(200)
      expect((await stored(a.sid)).absoluteExpAt).toBeLessThanOrEqual(end)
      expect(await redis.pTTL(sessKey(a.sid))).toBeLessThanOrEqual(2 * DAY)
    } finally {
      await ds.query('UPDATE iam_tenant SET expires_at = NULL WHERE id = ?', [tenant.id])
    }
  })
})

describe('mobileKind', () => {
  it('only the mobile client may declare it: a console sign-in with it → 400 on the field, nothing issued', async () => {
    await user('kind')
    for (const extra of [{}, { clientId: 'console' }]) {
      const res = await http()
        .post('/api/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({ username: `${PREFIX}kind`, password: PW, mobileKind: 'app', ...extra })
      expect(res.status).toBe(400)
      expect(res.body.errors[0].path).toBe('mobileKind')
    }
    const bad = await mobileLogin('kind', undefined, { mobileKind: 'desktop' })
    expect(bad.status).toBe(400)
    // a verified sign-in (SMS) refuses it the same way
    const id = (await ds.query('SELECT id FROM iam_user WHERE username = ?', [`${PREFIX}kind`]))[0]
      .id as number
    await expect(
      withTenant(1, () =>
        app
          .get(AuthService)
          .signInVerified(
            id,
            { kind: 'sms', timezone: null, label: '', mobileKind: 'app' },
            { ip: nextIp(), ua: UA },
          ),
      ),
    ).rejects.toBeInstanceOf(ValidationException)
    // and on the mobile client it is recorded
    const sms = await withTenant(1, () =>
      app.get(AuthService).signInVerified(
        id,
        {
          kind: 'sms',
          clientId: 'mobile',
          keepSignedIn: true,
          timezone: null,
          label: '',
          mobileKind: 'app',
        },
        { ip: nextIp(), ua: UA },
      ),
    )
    expect((await tokens.authenticate(sms.accessToken))?.mobileKind).toBe('app')
  })

  it('TokenService never records a kind on another client, so no console session gets the App term', async () => {
    const id = await user('kind2')
    const user2 = await withTenant(1, async () => {
      const { PermVersion } = await import('../../src/core/auth/perm-version.js')
      return (await app.get(PermVersion).load(id))!
    })
    const t = await tokens.issue(user2, {
      keepSignedIn: true,
      ip: '127.0.0.1',
      ua: UA,
      mobileKind: 'app',
    })
    expect(t.session.mobileKind).toBeUndefined()
    expect(t.session.absoluteExpAt - t.session.loginAt).toBe(WEEK)
  })
})

describe('single App session', () => {
  it('a second App ends the first (refresh 401, socket hears app_replaced); H5, mini program, console sessions and OAuth codes stay', async () => {
    const id = await user('one')
    const first = await appIn('one')
    const socket = await connect(socketOf(app, { token: first.access }))
    const got = inbox(socket)
    const gone = disconnected(socket)
    const h5 = await signed(await mobileLogin('one', 'h5'))
    const wx = await wxMpIn(id)
    const web = await signIn(app, `${PREFIX}one`, { keepSignedIn: true })
    const code = `app-sess-code-${id}`
    const credVer = await tokens.credVersion(id)
    await tokens.saveCode(
      code,
      {
        client: 'probe',
        clientPk: 1,
        userId: id,
        redirectUri: 'https://example.com/cb',
        scopes: [],
        challenge: 'c',
        credVer,
        tenantId: 1,
        exp: Date.now() + 60_000,
      },
      60_000,
    )

    const second = await appIn('one')
    expect(await gone).toBe('io server disconnect')
    expect(got).toEqual([
      { type: RT.sessionKicked, payload: { sid: first.sid, reason: 'app_replaced' } },
    ])
    rejected(await bodyRefresh(first.rt))
    await me(first.access).expect(401)
    await me(second.access).expect(200)
    for (const access of [h5.access, wx.accessToken, web.accessToken]) await me(access).expect(200)
    // no credential changed: credver stays and the user's authorization code can still be redeemed
    expect(await tokens.credVersion(id)).toBe(credVer)
    expect(await tokens.takeCode(code)).toMatchObject({ userId: id })
    expect((await appSessionsOf(id)).map((s) => s.sid)).toEqual([second.sid])
  })

  it('the per-user sign-in lock: held → 429 for an App sign-in only; parallel App sign-ins leave exactly one', async () => {
    const id = await user('lock')
    const lock = redisKey('authAppLogin', id)
    await redis.set(lock, 'someone', { expiration: { type: 'PX', value: 10_000 } })
    try {
      const busy = await mobileLogin('lock', 'app')
      expect(busy.status).toBe(429)
      expect(busy.body.code).toBe(Err.TOO_MANY_REQUESTS.code)
      // the refused attempt was given back: the account is not on its way to a lock
      expect(Number(await redis.get(redisKey('authFail', 'u', `${PREFIX}lock`)))).toBe(0)
      await signed(await mobileLogin('lock', 'h5'))
    } finally {
      await redis.del(lock)
    }
    // a lock released within a few seconds: the App sign-in waits for it instead of answering 429
    await redis.set(lock, 'someone', { expiration: { type: 'PX', value: 500 } })
    const waited = await mobileLogin('lock', 'app')
    expect(waited.status).toBe(200)

    const all = await Promise.all(Array.from({ length: 4 }, () => mobileLogin('lock', 'app')))
    for (const r of all) expect([200, 429]).toContain(r.status)
    expect(all.some((r) => r.status === 200)).toBe(true)
    expect(await appSessionsOf(id)).toHaveLength(1)
    // the lock is released after each sign-in
    expect(await redis.exists(lock)).toBe(0)
  })

  it('an SMS sign-in of the App is an App session and ends the earlier one; declared on another client → 400 before the code is spent', async () => {
    const mobile = '13800994017'
    const id = await user('sms', { mobile })
    const first = await appIn('sms')
    await ds.query(
      `INSERT INTO msg_sms_otp (tenant_id, mobile, scene, code, attempts, daily_seq, request_ip)
       VALUES (1, ?, 'signin', '246810', 0, 1, '127.0.0.1')`,
      [mobile],
    )
    const sms = (extra: Record<string, unknown>) =>
      http()
        .post('/api/auth/sms/login')
        .set('X-Forwarded-For', nextIp())
        .set('User-Agent', UA)
        .send({ mobile, code: '246810', keepSignedIn: true, mobileKind: 'app', ...extra })
    try {
      const refused = await sms({})
      expect(refused.status).toBe(400)
      expect(refused.body.errors[0].path).toBe('mobileKind')
      // the same code still signs in: the refused request did not spend it
      const second = await signed(await sms({ clientId: 'mobile' }))
      expect((await stored(second.sid)).mobileKind).toBe('app')
      rejected(await bodyRefresh(first.rt))
      expect((await appSessionsOf(id)).map((s) => s.sid)).toEqual([second.sid])
    } finally {
      await ds.query('DELETE FROM msg_sms_otp WHERE mobile = ?', [mobile])
    }
  })

  it('switch off: several App sessions live; switched on again, the next App sign-in leaves one', async () => {
    const id = await user('multi')
    await single(false)
    const a = await appIn('multi')
    const b = await appIn('multi')
    await me(a.access).expect(200)
    await me(b.access).expect(200)
    expect(await appSessionsOf(id)).toHaveLength(2)
    await single(true)
    const c = await appIn('multi')
    expect((await appSessionsOf(id)).map((s) => s.sid)).toEqual([c.sid])
    await me(a.access).expect(401)
    await me(b.access).expect(401)
  })

  it('stays inside the user: an App sign-in of another tenant’s namesake or another user ends nothing of theirs', async () => {
    const id = await user('alice')
    const mine = await appIn('alice')
    const other = await signed(
      await http()
        .post('/api/auth/login')
        .set('X-Forwarded-For', nextIp())
        .set('User-Agent', UA)
        .send({
          username: 'alice',
          password: TENANT_PASSWORD,
          tenantCode: tenant.code,
          keepSignedIn: true,
          clientId: 'mobile',
          mobileKind: 'app',
        }),
    )
    await me(mine.access).expect(200)
    const again = await appIn('alice')
    await me(other.access).expect(200)
    await me(mine.access).expect(401)
    expect((await appSessionsOf(id)).map((s) => s.sid)).toEqual([again.sid])
    expect((await appSessionsOf(tenant.users.alice)).map((s) => s.sid)).toEqual([other.sid])
  })

  it('a member account follows the same rules and another user’s App sign-in leaves it alone', async () => {
    const id = await user('member', { user_type: 'member' })
    const m = await appIn('member')
    const s = await stored(m.sid)
    expect(s).toMatchObject({ userType: 'member', mobileKind: 'app' })
    expect(s.absoluteExpAt - s.loginAt).toBe(APP_IDLE_MS)
    await user('staff')
    await appIn('staff')
    await me(m.access).expect(200)
    expect((await appSessionsOf(id)).map((x) => x.sid)).toEqual([m.sid])
  })
})

describe('session ends still apply to App sessions', () => {
  it('own password change keeps the current App session and ends the others; an admin reset ends every one', async () => {
    const id = await user('pw')
    const a = await appIn('pw')
    const web = await signIn(app, `${PREFIX}pw`, { keepSignedIn: true })
    await http()
      .put('/api/iam/profile/password')
      .set(bearer(a.access))
      .send({ oldPassword: PW, newPassword: 'Changed#AppSess2' })
      .expect(200)
    await me(a.access).expect(200)
    await me(web.accessToken).expect(401)
    const rotated = await bodyRefresh(a.rt).expect(200)

    await http()
      .put(`/api/iam/users/${id}/password`)
      .set(bearer(root))
      .send({ password: 'Reset#AppSess3' })
      .expect(200)
    await me(rotated.body.data.accessToken).expect(401)
    rejected(await bodyRefresh(rotated.body.data.refreshToken))
  })

  it('an admin kick ends an App session', async () => {
    await user('kick')
    const a = await appIn('kick')
    await http()
      .post('/api/iam/sessions/kick')
      .set(bearer(root))
      .send({ sids: [a.sid] })
      .expect(200)
    await me(a.access).expect(401)
    rejected(await bodyRefresh(a.rt))
  })
})
