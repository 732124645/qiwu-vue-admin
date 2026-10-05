// Identity comes from trusted credentials / the issued or targeted session, never the body.
import { BlockList } from 'node:net'
import { Logger } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import { ClsService } from 'nestjs-cls'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AuditWriter, type ActionLogEntry } from '../../src/core/audit/audit-writer.js'
import { ipLocator } from '../../src/core/audit/ip-location.js'
import { AuthParams } from '../../src/core/auth/auth-params.js'
import { AuthService } from '../../src/core/auth/auth.service.js'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { type Issued, TokenService } from '../../src/core/auth/token.service.js'
import { CaptchaService } from '../../src/core/captcha/captcha.service.js'
import { CaptchaTicketVerifier } from '../../src/core/captcha/captcha-ticket.js'
import { clsSet } from '../../src/core/context/cls.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { USER_LOOKUP, type UserLookup } from '../../src/core/auth/user-lookup.js'
import { OtpService } from '../../src/modules/platform/messaging/sms-otp/sms-otp.service.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'sec-audit-'
const PW = 'Audit#Pass2026'
const UA = 'sec-audit/1.0'
let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let tokens: TokenService
let admin: Issued
let pwHash: string
let seq = 0
const userIds: number[] = []
const unique = () => `${PREFIX}${++seq}`
const http = () => request(app.getHttpServer())
const client = () => ({ ip: `198.51.100.${++seq}`, ua: UA })

async function user(userType = 'member') {
  const username = unique()
  const id = await insertRow(ds.manager, 'iam_user', {
    username,
    display_name: username,
    user_type: userType,
    password_hash: pwHash,
    password_changed_at: new Date(),
  })
  userIds.push(id)
  return { id, username }
}

/** Fire-and-forget inserts must actually land: a missing or failed insert times out and fails. */
async function signin(traceId: string, kind?: string) {
  return vi.waitFor(
    async () => {
      const rows = await ds.query('SELECT * FROM aud_signin_log WHERE trace_id = ? ORDER BY id', [
        traceId,
      ])
      const row = kind ? rows.find((r: { kind: string }) => r.kind === kind) : rows[0]
      expect(row).toBeDefined()
      return row
    },
    { timeout: 5000 },
  )
}

const login = (username: string, over: object = {}, ip = client().ip) => {
  const traceId = unique()
  const res = http()
    .post('/api/auth/login')
    .set({ 'X-Request-Id': traceId, 'X-Forwarded-For': ip, 'User-Agent': UA })
    .send({ username, password: PW, ...over })
  return { traceId, res }
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  tokens = app.get(TokenService)
  await cleanRedis(redis)
  pwHash = await bcrypt.hash(PW, 4)
  admin = await signIn(app)
})

afterAll(async () => {
  if (ds) {
    await ds.query('DELETE FROM aud_signin_log WHERE trace_id LIKE ? OR username LIKE ?', [
      `${PREFIX}%`,
      `${PREFIX}%`,
    ])
    await ds.query('DELETE FROM aud_action_log WHERE trace_id LIKE ?', [`${PREFIX}%`])
    if (userIds.length) await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

it.each(['console', 'mobile'])(
  'password login on %s records member despite a forged body identity',
  async (clientId) => {
    const u = await user()
    const { traceId, res } = login(u.username, { clientId, userType: 'admin' })
    const response = await res.expect(200)
    expect((await tokens.authenticate(response.body.data.accessToken))?.userType).toBe('member')
    expect(await signin(traceId)).toMatchObject({
      user_id: u.id,
      user_type: 'member',
      client_id: clientId,
      kind: 'password',
      ok: 1,
    })
  },
)

it('unknown login ignores a forged member type and mobile client and defaults to admin', async () => {
  const { traceId, res } = login(unique(), {
    userType: 'member',
    clientId: 'mobile',
    password: 'Wrong#Pass1',
  })
  await res.expect(401)
  expect(await signin(traceId)).toMatchObject({
    user_id: null,
    user_type: 'admin',
    client_id: 'mobile',
    ok: 0,
  })
})

it.each([true, false])(
  'known login failures use credential identity (enabled=%s)',
  async (enabled) => {
    const u = await user()
    if (!enabled) await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [u.id])
    const { traceId, res } = login(u.username, { password: 'Wrong#Pass1', userType: 'admin' })
    await res.expect(401)
    expect(await signin(traceId)).toMatchObject({ user_id: u.id, user_type: 'member', ok: 0 })
  },
)

it('captcha and username/IP lock refusals retain the known member identity', async () => {
  const u = await user()
  const mode = vi.spyOn(app.get(CaptchaService), 'mode').mockResolvedValue('image')
  const ticket = vi.spyOn(app.get(CaptchaTicketVerifier), 'verify').mockResolvedValue(false)
  try {
    const { traceId, res } = login(u.username)
    await res.expect(403)
    expect(await signin(traceId)).toMatchObject({
      user_type: 'member',
      msg_key: 'signin.captcha_required',
    })
  } finally {
    mode.mockRestore()
    ticket.mockRestore()
  }
  const ip = client().ip
  await redis.set(redisKey('authFail', 'p', u.username, ip), '100')
  const { traceId, res } = login(u.username, {}, ip)
  await res.expect(429)
  expect(await signin(traceId, 'locked')).toMatchObject({ user_type: 'member', ok: 0 })
})

it('an IP blacklist refusal uses known credentials even without a logged user id', async () => {
  const u = await user()
  const ip = client().ip
  const params = app.get(AuthParams)
  const settings = await params.load()
  const blocked = new BlockList()
  blocked.addAddress(ip)
  const load = vi.spyOn(params, 'load').mockResolvedValue({ ...settings, blocked })
  try {
    const { traceId, res } = login(u.username, {}, ip)
    await res.expect(403)
    expect(await signin(traceId)).toMatchObject({
      user_id: null,
      user_type: 'member',
      msg_key: 'signin.ip_blocked',
    })
  } finally {
    load.mockRestore()
  }
})

it('success records the issued snapshot when user type changes between credentials and issuance', async () => {
  const u = await user('admin')
  const lookup = app.get<UserLookup>(USER_LOOKUP)
  const load = lookup.load.bind(lookup)
  const changed = vi.spyOn(lookup, 'load').mockImplementation(async (id) => {
    if (id === u.id)
      await ds.query('UPDATE iam_user SET user_type = ? WHERE id = ?', ['member', id])
    return load(id)
  })
  try {
    const { traceId, res } = login(u.username)
    const response = await res.expect(200)
    expect((await tokens.authenticate(response.body.data.accessToken))?.userType).toBe('member')
    expect(await signin(traceId)).toMatchObject({ user_type: 'member', ok: 1 })
  } finally {
    changed.mockRestore()
  }
})

it.each(['sms', 'wx-mp'] as const)(
  '%s verified sign-in records the issued session and known failure identity',
  async (kind) => {
    const u = await user()
    const cls = app.get(ClsService)
    const auth = app.get(AuthService)
    const opts = { kind, label: 'verified', timezone: null, clientId: 'mobile' as const }
    const traceId = unique()
    const issued = await cls.run(() => {
      clsSet('traceId', traceId)
      return auth.signInVerified(u.id, opts, client())
    })
    expect((await tokens.authenticate(issued.accessToken))?.userType).toBe('member')
    expect(await signin(traceId)).toMatchObject({
      user_type: 'member',
      client_id: 'mobile',
      kind,
      ok: 1,
    })
    await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [u.id])
    const refused = unique()
    await expect(
      cls.run(() => {
        clsSet('traceId', refused)
        return auth.signInVerified(u.id, opts, client())
      }),
    ).rejects.toBeDefined()
    expect(await signin(refused)).toMatchObject({ user_type: 'member', kind, ok: 0 })
  },
)

it.each(['sms', 'wx-mp'] as const)(
  '%s verified success uses the issued type when credentials differ',
  async (kind) => {
    const u = await user('admin')
    const lookup = app.get<UserLookup>(USER_LOOKUP)
    const load = lookup.load.bind(lookup)
    const changed = vi.spyOn(lookup, 'load').mockImplementation(async (id) => {
      if (id === u.id)
        await ds.query('UPDATE iam_user SET user_type = ? WHERE id = ?', ['member', id])
      return load(id)
    })
    const traceId = unique()
    try {
      const issued = await app.get(ClsService).run(() => {
        clsSet('traceId', traceId)
        return app
          .get(AuthService)
          .signInVerified(
            u.id,
            { kind, label: 'verified', timezone: null, clientId: 'mobile' },
            client(),
          )
      })
      expect((await tokens.authenticate(issued.accessToken))?.userType).toBe('member')
      expect(await signin(traceId)).toMatchObject({ user_type: 'member', kind, ok: 1 })
    } finally {
      changed.mockRestore()
    }
  },
)

it('an invalid SMS proof is anonymous admin even for a claimed member', async () => {
  const consume = vi.spyOn(app.get(OtpService), 'consume').mockResolvedValue(false)
  const traceId = unique()
  try {
    await http()
      .post('/api/auth/sms/login')
      .set({ 'X-Request-Id': traceId, 'X-Forwarded-For': client().ip })
      .send({ mobile: '13800000000', code: '123456', clientId: 'mobile', userType: 'member' })
      .expect(400)
    expect(await signin(traceId)).toMatchObject({
      user_id: null,
      user_type: 'admin',
      kind: 'sms',
      ok: 0,
    })
  } finally {
    consume.mockRestore()
  }
})

it.each(['signout', 'locked', 'refresh_reuse', 'kicked'])(
  '%s keeps the target session snapshot after the account changes to admin',
  async (kind) => {
    const u = await user()
    const issued = await signIn(app, u.username, { clientId: 'mobile', ua: UA })
    await ds.query('UPDATE iam_user SET user_type = ? WHERE id = ?', ['admin', u.id])
    expect(
      (await app.get<UserLookup>(USER_LOOKUP).findCredentials({ userId: u.id }))?.userType,
    ).toBe('admin')
    const traceId = unique()
    if (kind === 'signout') {
      await http()
        .post('/api/auth/logout')
        .set(bearer(issued.accessToken))
        .set('X-Request-Id', traceId)
        .expect(200)
    } else if (kind === 'locked') {
      await redis.set(redisKey('authFail', 'cur', u.id), '100')
      const res = await http()
        .post('/api/auth/verify-password')
        .set(bearer(issued.accessToken))
        .set('X-Request-Id', traceId)
        .send({ password: 'Wrong#Pass1' })
        .expect(401)
      expect(res.body.code).toBe(Err.AUTH_SESSION_EXPIRED.code)
    } else if (kind === 'refresh_reuse') {
      await http()
        .post('/api/auth/refresh')
        .set('User-Agent', UA)
        .send({ refreshToken: issued.refreshToken })
        .expect(200)
      await http()
        .post('/api/auth/refresh')
        .set({ 'User-Agent': 'different-ua', 'X-Request-Id': traceId })
        .send({ refreshToken: issued.refreshToken })
        .expect(401)
    } else {
      await http()
        .delete(`/api/iam/sessions/${issued.session.sid}`)
        .set(bearer(admin.accessToken))
        .set('X-Request-Id', traceId)
        .expect(200)
    }
    expect(await signin(traceId, kind)).toMatchObject({
      user_id: u.id,
      user_type: 'member',
      client_id: 'mobile',
      kind,
    })
  },
)

it('member actions use the CLS session identity, preserve redaction, and survive account type changes', async () => {
  const u = await user()
  const issued = await signIn(app, u.username)
  await ds.query('UPDATE iam_user SET user_type = ? WHERE id = ?', ['admin', u.id])
  const traceId = unique()
  await http()
    .put('/api/iam/profile/password')
    .set(bearer(issued.accessToken))
    .set('X-Request-Id', traceId)
    .send({ oldPassword: 'Wrong#Pass1', newPassword: 'Audit#Pass2027', userType: 'admin' })
    .expect(400)
  const row = await logOf(ds, traceId)
  expect(row).toMatchObject({ user_id: u.id, user_type: 'member', domain: 'iam.profile', ok: 0 })
  expect(row.params).not.toContain('Wrong#Pass1')
  expect(row.params).not.toContain('Audit#Pass2027')
})

const action: ActionLogEntry = {
  domain: 'test.audit',
  verb: 'probe',
  bizId: null,
  method: 'POST',
  url: '/audit',
  ip: null,
  ua: '',
  params: { password: 'private-password' },
  result: null,
  costMs: 0,
}

it('action snapshots CLS before async location; no principal defaults to admin with null user id', async () => {
  const u = await user()
  const principal = { ...(await app.get(PermVersion).load(u.id))!, userId: u.id }
  const traceId = unique()
  let release!: (location: string | null) => void
  const location = vi.spyOn(ipLocator, 'location').mockReturnValue(
    new Promise((resolve) => {
      release = resolve
    }),
  )
  try {
    app.get(ClsService).run(() => {
      clsSet('traceId', traceId)
      clsSet('principal', principal)
      app.get(AuditWriter).action(action)
      principal.userType = 'admin'
      clsSet('principal', undefined)
    })
    release(null)
    const row = await logOf(ds, traceId)
    expect(row).toMatchObject({ user_id: u.id, user_type: 'member' })
    expect(row.params).not.toContain('private-password')
  } finally {
    location.mockRestore()
  }
  const anonymous = unique()
  app.get(ClsService).run(() => {
    clsSet('traceId', anonymous)
    app.get(AuditWriter).action(action)
  })
  expect(await logOf(ds, anonymous)).toMatchObject({ user_id: null, user_type: 'admin' })
})

it('a failing sign-in insert is logged without rejecting a successful login', async () => {
  const u = await user()
  const query = ds.query.bind(ds)
  const failed = vi.spyOn(ds, 'query').mockImplementation((sql, args, runner) => {
    if (sql.includes('INSERT INTO aud_signin_log'))
      return Promise.reject(new Error('audit insert unavailable'))
    return query(sql, args, runner)
  })
  const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  try {
    const { res } = login(u.username)
    await res.expect(200)
    await vi.waitFor(
      () => expect(logged).toHaveBeenCalledWith(expect.anything(), 'sign-in log insert failed'),
      { timeout: 5000 },
    )
  } finally {
    failed.mockRestore()
    logged.mockRestore()
  }
})
