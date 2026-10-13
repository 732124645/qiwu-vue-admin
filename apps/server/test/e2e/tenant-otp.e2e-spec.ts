// SMS codes, WeChat mini program sign-in and OAuth2 codes with tenants (see docs/design-notes.md#tenancy),
// with two apps on one database: `on` (APP_MULTI_TENANT=true) and `off`, tenant B (bound to HOST_B) whose
// `alice` shares her mobile with a default-tenant user, and HOST_A bound to the default tenant. SMS codes
// are issued, spent and voided in the sign-in tenant (the host's, else the typed code); an unknown code,
// a disabled and an expired tenant answer exactly like an unknown number, while the number's limits stay
// shared. A WeChat identity signs in to its binding's tenant; a bind ticket of a host bound to a tenant
// binds in that tenant only. An authorization code redeems in its user's tenant only. A disabled tenant
// signs nobody in through any of them.
import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Logger } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, masked, WX_MP_ENABLED_PARAM } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { SessionRevoker } from '../../src/core/auth/session-revoker.js'
import { TENANT_UNAVAILABLE, TokenService } from '../../src/core/auth/token.service.js'
import { NotifyDispatcher } from '../../src/core/notify/notify.js'
import { keyPattern } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import {
  WxMpGateway,
  type WxMpIdentity,
} from '../../src/modules/platform/iam/social/wx-mp.gateway.js'
import { OtpService } from '../../src/modules/platform/messaging/sms-otp/sms-otp.service.js'
import { secretDigest } from '../../src/modules/platform/oauth/provider/provider.service.js'
import { bearer } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import {
  addUser,
  bootApp,
  createTenant,
  inTenant1,
  type PeopledTenant,
  signInDirect,
  TENANT_PASSWORD,
  TWIN_MOBILE,
} from '../setup/tenants.js'

const HOST_A = 'a.tenant-otp.test'
const HOST_B = 'b.tenant-otp.test'
const UNKNOWN = 'zz-no-such-tenant'
/** the default tenant's twin of B's `alice`: same mobile (TWIN_MOBILE), same password */
const TWIN = 'to-alice'
/** B's `dave` */
const DAVE_MOBILE = '13900009105'
/** numbers nobody holds */
const SPARE = [
  '13900009101',
  '13900009102',
  '13900009103',
  '13900009104',
  '13900009106',
  '13900009107',
]
const MOBILES = [TWIN_MOBILE, DAVE_MOBILE, ...SPARE]
const APPID = 'wx00tenant0otp000a'
const CB = 'https://crm.tenant-otp.example/cb'
const SECRET = 'tenant-otp-secret-0123456789abcdef'
const CLIENT = 'to-crm'
const PARAMS = [WX_MP_ENABLED_PARAM, 'captcha.mode'] as const
const NEW_PASSWORD = 'Reset#Tenant-2026'

let on: NestExpressApplication
let off: NestExpressApplication
let ds: DataSource
let redis: Redis
let B: PeopledTenant
let twin = 0
let carol = 0
let dave = 0
let channelId = 0
let clientPk = 0
const before = { action: 0, signin: 0 }
const templateChannels: { id: number; channel_id: number | null }[] = []
const original = new Map<string, string>()

const http = (app: NestExpressApplication) => request(app.getHttpServer())
let ipSeq = 0
const nextIp = () => `198.51.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`
let codeSeq = 0
/** a fake `uni.login` code of `openid` (the stubbed gateway answers that openid) */
const wxCode = (openid: string) => `${openid}~${++codeSeq}`

/** POST /api`path` from `at` (default: a fresh client IP), on `host` when given. */
function post(
  app: NestExpressApplication,
  path: string,
  body: object,
  o: { host?: string; at?: string } = {},
) {
  const req = http(app)
    .post(`/api${path}`)
    .set('X-Forwarded-For', o.at ?? nextIp())
  return (o.host ? req.set('Host', o.host) : req).send(body)
}
/** What a client sees of an answer (the trace id aside). */
const answer = (res: request.Response) => {
  const body = { ...(res.body as Record<string, unknown>) }
  delete body.traceId
  return { status: res.status, body }
}
const expectErr = (
  res: { status: number; body: Record<string, unknown> },
  err: { code: string; status: number },
) => expect([res.status, res.body.code]).toEqual([err.status, err.code])
const idle = async () => {
  await on.get(NotifyDispatcher).idle()
  await off.get(NotifyDispatcher).idle()
}
const clearLimits = async () => {
  for (const pattern of [keyPattern('smsLimit'), keyPattern('throttle')])
    for await (const keys of redis.scanIterator({ MATCH: pattern, COUNT: 500 }))
      if (keys.length) await redis.unlink(keys)
}
interface OtpRow {
  id: number
  code: string
  scene: string
  tenant_id: number
  user_id: number | null
  consumed_at: Date | null
}
const otpRows = (mobile: string) =>
  ds.query<OtpRow[]>(
    'SELECT id, code, scene, tenant_id, user_id, consumed_at FROM msg_sms_otp WHERE mobile = ? ORDER BY id DESC',
    [mobile],
  )
/** Requests a code for `mobile` as the sign-in pages do (on `host`); the newest row of the number then. */
async function smsCode(
  scene: 'signin' | 'reset_password',
  mobile: string,
  tenantCode?: string,
  host?: string,
) {
  await post(on, '/auth/sms/code', { mobile, scene, tenantCode }, { host }).expect(200)
  await idle()
  return (await otpRows(mobile))[0]
}
/** A live sign-in code of `tenantId`, written straight (as an issue in that tenant leaves it). */
const plantCode = (tenantId: number, mobile: string, code: string) =>
  ds.query(
    `INSERT INTO msg_sms_otp (mobile, scene, code, attempts, daily_seq, request_ip, tenant_id)
     VALUES (?, 'signin', ?, 0, 1, '127.0.0.1', ?)`,
    [mobile, code, tenantId],
  )
const spendAll = (mobile: string) =>
  ds.query('UPDATE msg_sms_otp SET consumed_at = NOW(3) WHERE mobile = ?', [mobile])
const passwordHash = async (id: number) =>
  (
    await ds.query<{ password_hash: string }[]>('SELECT password_hash FROM iam_user WHERE id = ?', [
      id,
    ])
  )[0]!.password_hash
const sessionOf = (accessToken: string) => on.get(TokenService).authenticate(accessToken)
const setB = (enabled: 0 | 1) =>
  ds.query('UPDATE iam_tenant SET enabled = ? WHERE id = ?', [enabled, B.id])
const setParam = async (key: string, value: string) => {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await on.get(ParamService).invalidate(key)
}
/** Binds WeChat `openid` to `userId` of `tenantId`, as a finished bind leaves it. */
const bindWx = (tenantId: number, userId: number, openid: string) =>
  ds.query(
    `INSERT INTO iam_user_social (provider, appid, openid, user_id, created_by, updated_by, tenant_id)
     VALUES ('wx-mp', ?, ?, ?, ?, ?, ?)`,
    [APPID, openid, userId, userId, userId, tenantId],
  )
const bindings = (openid: string) =>
  ds.query<{ user_id: number; tenant_id: number }[]>(
    'SELECT user_id, tenant_id FROM iam_user_social WHERE openid = ? AND deleted_at IS NULL',
    [openid],
  )
/** A bind ticket for unbound `openid`, issued to `at` on `host` (none: a host bound to no tenant). */
async function ticketFor(openid: string, at: string, host?: string) {
  const res = await post(on, '/auth/wx-mp/login', { code: wxCode(openid) }, { at, host }).expect(
    200,
  )
  return res.body.data.bindTicket as string
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}
interface Code {
  code: string
  verifier: string
}
/** An authorization code approved on the consent page by the holder of `accessToken`. */
async function approve(accessToken: string): Promise<Code> {
  const { verifier, challenge } = pkce()
  const res = await http(on)
    .post('/api/oauth2/authorize')
    .query({
      response_type: 'code',
      client_id: CLIENT,
      redirect_uri: CB,
      scope: 'user.read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    .set(bearer(accessToken))
    .send({ approve: true })
    .expect(200)
  return { code: new URL(res.body.data.redirectTo as string).searchParams.get('code')!, verifier }
}
const token = (form: Record<string, string>) =>
  http(on)
    .post('/api/oauth2/token')
    .type('form')
    .send({ client_id: CLIENT, client_secret: SECRET, ...form })
const exchange = ({ code, verifier }: Code) =>
  token({ grant_type: 'authorization_code', code, redirect_uri: CB, code_verifier: verifier })
const expectInvalidGrant = (res: request.Response) =>
  expect([res.status, res.body.error]).toEqual([400, 'invalid_grant'])
/** A code of `userId` saved straight, naming `tenantId` as its tenant. */
async function codeNaming(userId: number, tenantId: number): Promise<Code> {
  const { verifier, challenge } = pkce()
  const code = randomBytes(32).toString('base64url')
  const tokens = on.get(TokenService)
  await tokens.saveCode(
    code,
    {
      client: CLIENT,
      clientPk,
      userId,
      redirectUri: CB,
      scopes: ['user.read'],
      challenge,
      credVer: await tokens.credVersion(userId),
      tenantId,
      exp: Date.now() + 60_000,
    },
    60_000,
  )
  return { code, verifier }
}
const maxId = async (table: 'aud_action_log' | 'aud_signin_log') =>
  Number(
    // the table name is one of the two above
    (await ds.query<{ n: number }[]>(`SELECT COALESCE(MAX(id), 0) AS n FROM ${table}`))[0]!.n,
  )

beforeAll(async () => {
  on = await bootApp({ multiTenant: true })
  off = await bootApp({ multiTenant: false })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  await cleanRedis(redis)
  // both apps' WeChat gateway: an AppID configured, a code `<openid>~<n>` answering that openid
  for (const app of [on, off]) {
    const gateway = app.get(WxMpGateway)
    vi.spyOn(gateway, 'appid').mockReturnValue(APPID)
    vi.spyOn(gateway, 'code2Session').mockImplementation(
      async (c: string) => ({ openid: c.split('~')[0]!, unionid: null }) as WxMpIdentity,
    )
  }
  for (const r of await ds.query<{ param_key: string; param_value: string }[]>(
    'SELECT param_key, param_value FROM cfg_param WHERE param_key IN (?)',
    [PARAMS],
  ))
    original.set(r.param_key, r.param_value)
  await setParam('captcha.mode', 'off')
  await setParam(WX_MP_ENABLED_PARAM, 'true')

  B = await createTenant(on, { users: true, domains: [HOST_B] })
  const people = { deptId: B.deptId, roleId: B.roleId }
  carol = await addUser(on, B.id, 'carol', people)
  dave = await addUser(on, B.id, 'dave', { ...people, mobile: DAVE_MOBILE })
  twin = await addUser(on, 1, TWIN, { mobile: TWIN_MOBILE })
  await ds.query('INSERT INTO iam_tenant_domain (tenant_id, domain) VALUES (1, ?)', [HOST_A])
  before.action = await maxId('aud_action_log')
  before.signin = await maxId('aud_signin_log')

  const { insertId } = await ds.query<{ insertId: number }>(
    "INSERT INTO msg_sms_channel (driver, name, enabled) VALUES ('debug', 'to-debug', 1)",
  )
  channelId = Number(insertId)
  templateChannels.push(
    ...(await ds.query<{ id: number; channel_id: number | null }[]>(
      "SELECT id, channel_id FROM msg_sms_template WHERE code = 'auth.sms_code'",
    )),
  )
  await ds.query("UPDATE msg_sms_template SET channel_id = ? WHERE code = 'auth.sms_code'", [
    channelId,
  ])
  clientPk = await insertRow(ds.manager, 'oauth_client', {
    client_id: CLIENT,
    secret_hash: secretDigest(SECRET),
    name: CLIENT,
    grant_types: ['authorization_code', 'refresh_token', 'client_credentials'],
    redirect_uris: [CB],
    scopes: ['user.read'],
    auto_approve_scopes: [],
    access_ttl_sec: 600,
    refresh_ttl_sec: 3600,
  })
})

beforeEach(clearLimits)

afterAll(async () => {
  if (ds) {
    await idle()
    // sign-in and action log rows are written without awaiting
    await sleep(200)
    await B?.dispose()
    if (twin) {
      await ds.query('DELETE FROM iam_user_social WHERE user_id = ?', [twin])
      await ds.query('DELETE FROM iam_user WHERE id = ?', [twin])
    }
    await ds.query('DELETE FROM iam_tenant_domain WHERE domain = ?', [HOST_A])
    await ds.query('DELETE FROM msg_sms_otp WHERE mobile IN (?)', [MOBILES])
    if (channelId) await ds.query('DELETE FROM msg_sms_record WHERE channel_id = ?', [channelId])
    for (const t of templateChannels)
      await ds.query('UPDATE msg_sms_template SET channel_id = ? WHERE id = ?', [
        t.channel_id,
        t.id,
      ])
    if (channelId) await ds.query('DELETE FROM msg_sms_channel WHERE id = ?', [channelId])
    if (clientPk) {
      await ds.query('DELETE FROM oauth_consent WHERE client_id = ?', [clientPk])
      await ds.query('DELETE FROM oauth_client WHERE id = ?', [clientPk])
    }
    await ds.query('DELETE FROM aud_action_log WHERE id > ?', [before.action])
    await ds.query('DELETE FROM aud_signin_log WHERE id > ?', [before.signin])
    for (const [key, value] of original) await setParam(key, value)
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
  await off?.close()
})

describe('SMS codes', () => {
  it('a code is issued in the sign-in tenant and spent there only; the number’s cooldown is shared', async () => {
    const a = (await smsCode('signin', TWIN_MOBILE))!
    expect(a.tenant_id).toBe(1)
    // the same number in B at once: one phone, one cooldown
    expectErr(
      await post(on, '/auth/sms/code', {
        mobile: TWIN_MOBILE,
        scene: 'signin',
        tenantCode: B.code,
      }),
      Err.SMS_TOO_FREQUENT,
    )
    // A's code in B: no such code there, and A's stays unspent
    expectErr(
      await post(on, '/auth/sms/login', { mobile: TWIN_MOBILE, code: a.code, tenantCode: B.code }),
      Err.AUTH_SMS_CODE_INVALID,
    )

    // a code issued in B while A's is live voids none of A's
    await clearLimits()
    const b = (await smsCode('signin', TWIN_MOBILE, B.code))!
    expect(b.tenant_id).toBe(B.id)
    expectErr(
      await post(on, '/auth/sms/login', { mobile: TWIN_MOBILE, code: b.code }),
      Err.AUTH_SMS_CODE_INVALID,
    )
    const inA = await post(on, '/auth/sms/login', { mobile: TWIN_MOBILE, code: a.code }).expect(200)
    expect(await sessionOf(inA.body.data.accessToken)).toMatchObject({ userId: twin, tenantId: 1 })
    const inB = await post(on, '/auth/sms/login', {
      mobile: TWIN_MOBILE,
      code: b.code,
      tenantCode: B.code,
    }).expect(200)
    expect(await sessionOf(inB.body.data.accessToken)).toMatchObject({
      userId: B.users.alice,
      tenantId: B.id,
    })
  })

  it('on a host bound to a tenant, the host alone names it for the code and the sign-in', async () => {
    const row = (await smsCode('signin', TWIN_MOBILE, undefined, HOST_B))!
    expect(row.tenant_id).toBe(B.id)
    const res = await post(
      on,
      '/auth/sms/login',
      { mobile: TWIN_MOBILE, code: row.code },
      { host: HOST_B },
    ).expect(200)
    expect(await sessionOf(res.body.data.accessToken)).toMatchObject({
      userId: B.users.alice,
      tenantId: B.id,
    })
  })

  it('a reset by SMS changes the resolved tenant’s user only and is logged in that tenant', async () => {
    // the code asked for on `host`, the reset naming `tenantCode`, posted on `resetHost`
    const reset = async (host?: string, tenantCode?: string, resetHost?: string) => {
      const was = { a: await passwordHash(twin), b: await passwordHash(B.users.alice) }
      await clearLimits()
      const row = (await smsCode('reset_password', TWIN_MOBILE, undefined, host))!
      // the same password again: a new hash all the same
      const body = { mobile: TWIN_MOBILE, code: row.code, newPassword: TENANT_PASSWORD, tenantCode }
      await post(on, '/auth/password/reset-by-sms', body, { host: resetHost }).expect(200)
      return {
        tenant: row.tenant_id,
        a: (await passwordHash(twin)) !== was.a,
        b: (await passwordHash(B.users.alice)) !== was.b,
      }
    }
    expect(await reset(HOST_B, B.code)).toEqual({ tenant: B.id, a: false, b: true })
    // B's host alone, for the code and the reset
    expect(await reset(HOST_B, undefined, HOST_B)).toEqual({ tenant: B.id, a: false, b: true })
    expect(await reset()).toEqual({ tenant: 1, a: true, b: false })
    const rows = () =>
      ds.query<{ tenant_id: number; actor_tenant_id: number }[]>(
        "SELECT tenant_id, actor_tenant_id FROM aud_action_log WHERE id > ? AND verb = 'reset-password-sms' ORDER BY id",
        [before.action],
      )
    await vi.waitFor(async () => expect(await rows()).toHaveLength(3))
    expect(await rows()).toEqual([
      { tenant_id: B.id, actor_tenant_id: B.id },
      { tenant_id: B.id, actor_tenant_id: B.id },
      { tenant_id: 1, actor_tenant_id: 1 },
    ])
  })

  it('voiding a number’s codes reaches its own tenant only', async () => {
    await spendAll(TWIN_MOBILE)
    await plantCode(1, TWIN_MOBILE, '111111')
    await plantCode(B.id, TWIN_MOBILE, '222222')
    const live = async () =>
      (await otpRows(TWIN_MOBILE))
        .filter((r) => r.consumed_at === null)
        .map((r) => [r.tenant_id, r.code])
    // a revocation of the user (disable, password reset…) voids its number's codes in its tenant
    await on.get(SessionRevoker).revokeUser(B.users.alice, 'disabled')
    expect(await live()).toEqual([[1, '111111']])
    await plantCode(B.id, TWIN_MOBILE, '333333')
    // a mobile changed in the default tenant
    await inTenant1(() => on.get(OtpService).voidMobile(TWIN_MOBILE))
    expect(await live()).toEqual([[B.id, '333333']])
    await spendAll(TWIN_MOBILE)
  })

  it('an existing and an unknown tenant code answer alike on every SMS entry; nothing is sent or fails', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const since = await maxId('aud_signin_log')
    try {
      const both = async (call: (tenantCode: string) => Promise<request.Response>) => {
        const known = answer(await call(B.code))
        expect(answer(await call(UNKNOWN))).toEqual(known)
        return known
      }
      // B holds the number: a code for B; none for the unknown code
      const rows = (await otpRows(TWIN_MOBILE)).length
      const issued = await both(async (tenantCode) => {
        await clearLimits()
        return post(on, '/auth/sms/code', { mobile: TWIN_MOBILE, scene: 'signin', tenantCode })
      })
      expect([issued.status, issued.body.data]).toEqual([200, { cooldownSec: 60 }])
      await idle()
      const now = await otpRows(TWIN_MOBILE)
      expect(now.slice(0, now.length - rows).map((r) => r.tenant_id)).toEqual([B.id])
      await spendAll(TWIN_MOBILE)

      const login = await both((tenantCode) =>
        post(on, '/auth/sms/login', { mobile: TWIN_MOBILE, code: '000000', tenantCode }),
      )
      expectErr(login, Err.AUTH_SMS_CODE_INVALID)
      const reset = await both((tenantCode) =>
        post(on, '/auth/password/reset-by-sms', {
          mobile: TWIN_MOBILE,
          code: '000000',
          newPassword: NEW_PASSWORD,
          tenantCode,
        }),
      )
      expectErr(reset, Err.AUTH_SMS_CODE_INVALID)

      const at = nextIp()
      const viaPassword = await both(async (tenantCode) =>
        post(
          on,
          '/auth/wx-mp/bind',
          {
            ticket: await ticketFor('o-probe', at),
            username: 'carol',
            password: 'Wrong#2026',
            tenantCode,
          },
          { at },
        ),
      )
      expectErr(viaPassword, Err.AUTH_BAD_CREDENTIALS)
      const viaSms = await both(async (tenantCode) =>
        post(
          on,
          '/auth/wx-mp/bind',
          {
            ticket: await ticketFor('o-probe', at),
            mobile: DAVE_MOBILE,
            code: '000000',
            tenantCode,
          },
          { at },
        ),
      )
      expectErr(viaSms, Err.AUTH_SMS_CODE_INVALID)

      // the failed reset of B is logged in B, the one whose tenant did not resolve nowhere
      await sleep(200)
      const failed = await ds.query<{ tenant_id: number }[]>(
        "SELECT tenant_id FROM aud_action_log WHERE id > ? AND verb = 'reset-password-sms' AND ok = 0",
        [before.action],
      )
      expect(failed).toEqual([{ tenant_id: B.id }])
      // the SMS sign-ins (plain and the bind's) of the unknown code are logged in no tenant
      const smsSignins = () =>
        ds.query<{ kind: string; tenant_id: number | null; msg_key: string }[]>(
          'SELECT kind, tenant_id, msg_key FROM aud_signin_log WHERE id > ? AND username IN (?) ORDER BY id',
          [since, [masked.mobile(TWIN_MOBILE), masked.mobile(DAVE_MOBILE)]],
        )
      await vi.waitFor(async () => expect(await smsSignins()).toHaveLength(4))
      const unavailable = { tenant_id: null, msg_key: 'signin.tenant_unavailable' }
      const invalidInB = { tenant_id: B.id, msg_key: 'signin.sms_code_invalid' }
      expect(await smsSignins()).toEqual([
        { kind: 'sms', ...invalidInB },
        { kind: 'sms', ...unavailable },
        { kind: 'wx-mp', ...invalidInB },
        { kind: 'wx-mp', ...unavailable },
      ])
      await idle()
      expect(error).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('repeated wrong codes answer the same sequence for an existing and an unknown tenant code', async () => {
    const sequence = async (path: string, extra: object, tenantCode: string, mobile: string) => {
      const out: string[] = []
      for (let i = 0; i < 11; i++) {
        const res = await post(on, path, { mobile, code: '000000', tenantCode, ...extra })
        out.push(`${res.status} ${res.body.code}`)
      }
      return out
    }
    for (const [path, extra, known, unknown] of [
      ['/auth/sms/login', {}, SPARE[0]!, SPARE[1]!],
      ['/auth/password/reset-by-sms', { newPassword: NEW_PASSWORD }, SPARE[4]!, SPARE[5]!],
    ] as const) {
      const existing = await sequence(path, extra, B.code, known)
      expect(existing.at(-1)).toBe(`429 ${Err.SMS_TOO_FREQUENT.code}`)
      expect(await sequence(path, extra, UNKNOWN, unknown)).toEqual(existing)
    }
  })

  it('a signed-in bind request’s code belongs to the session’s tenant', async () => {
    const session = (await signInDirect(on, B.users.admin))!
    await http(on)
      .post('/api/iam/profile/mobile/code')
      .set('X-Forwarded-For', nextIp())
      .set(bearer(session.accessToken))
      .send({ mobile: SPARE[2] })
      .expect(200)
    await idle()
    expect((await otpRows(SPARE[2]!))[0]).toMatchObject({
      scene: 'bind_mobile',
      tenant_id: B.id,
      user_id: B.users.admin,
    })
  })
})

describe('WeChat mini program', () => {
  it('a bound identity signs in to its user’s tenant, with no tenant code', async () => {
    await bindWx(B.id, B.users.alice, 'o-b-alice')
    const res = await post(on, '/auth/wx-mp/login', { code: wxCode('o-b-alice') }).expect(200)
    expect(await sessionOf(res.body.data.tokens.accessToken)).toMatchObject({
      userId: B.users.alice,
      tenantId: B.id,
    })
  })

  it('a ticket of a host bound to a tenant binds in that tenant only', async () => {
    const inA = { username: TWIN, password: TENANT_PASSWORD }
    const inB = { username: 'admin', password: TENANT_PASSWORD, tenantCode: B.code }
    const bind = async (host: string, creds: object) => {
      const at = nextIp()
      const ticket = await ticketFor('o-cross', at, host)
      return post(on, '/auth/wx-mp/bind', { ticket, ...creds }, { at })
    }
    // issued in A (on A's host), redeemed in B; issued in B, redeemed in A
    expectErr(await bind(HOST_A, inB), Err.AUTH_WX_MP_TICKET_INVALID)
    expectErr(await bind(HOST_B, inA), Err.AUTH_WX_MP_TICKET_INVALID)
    expect(await bindings('o-cross')).toEqual([])
    // issued in B, redeemed in B by its code on a host bound to none
    const res = await bind(HOST_B, inB)
    expect(res.status).toBe(200)
    expect(await sessionOf(res.body.data.accessToken)).toMatchObject({
      userId: B.users.admin,
      tenantId: B.id,
    })
    expect(await bindings('o-cross')).toEqual([{ user_id: B.users.admin, tenant_id: B.id }])
  })

  it('a ticket of a host bound to none binds in the tenant the bind resolves, by password or SMS', async () => {
    let at = nextIp()
    const byPassword = { username: TWIN, password: TENANT_PASSWORD }
    await post(
      on,
      '/auth/wx-mp/bind',
      { ticket: await ticketFor('o-twin', at), ...byPassword },
      { at },
    ).expect(200)
    expect(await bindings('o-twin')).toEqual([{ user_id: twin, tenant_id: 1 }])

    await plantCode(B.id, DAVE_MOBILE, '424242')
    at = nextIp()
    const bySms = { mobile: DAVE_MOBILE, code: '424242', tenantCode: B.code }
    const res = await post(
      on,
      '/auth/wx-mp/bind',
      { ticket: await ticketFor('o-dave', at), ...bySms },
      { at },
    ).expect(200)
    expect(await sessionOf(res.body.data.accessToken)).toMatchObject({
      userId: dave,
      tenantId: B.id,
    })
    expect(await bindings('o-dave')).toEqual([{ user_id: dave, tenant_id: B.id }])
  })
})

describe('OAuth2 codes', () => {
  it('B’s user approves and redeems a code: a session of B; client_credentials sessions are the default tenant’s', async () => {
    const session = (await signInDirect(on, carol))!
    const res = await exchange(await approve(session.accessToken)).expect(200)
    expect(await sessionOf(res.body.access_token)).toMatchObject({ userId: carol, tenantId: B.id })

    const machine = await token({ grant_type: 'client_credentials', scope: 'user.read' }).expect(
      200,
    )
    expect((await sessionOf(machine.body.access_token))?.tenantId).toBe(1)
  })

  it('a code naming another tenant than its user’s redeems nothing', async () => {
    expectInvalidGrant(await exchange(await codeNaming(carol, 1)))
    expectInvalidGrant(await exchange(await codeNaming(twin, B.id)))
    await exchange(await codeNaming(carol, B.id)).expect(200)
  })
})

describe('a disabled tenant', () => {
  // obtained while B was available
  let code: Code
  const tickets = { onHost: { at: '', ticket: '' }, plain: { at: '', ticket: '' } }
  const creds = { username: 'carol', password: TENANT_PASSWORD }

  beforeAll(async () => {
    code = await approve((await signInDirect(on, carol))!.accessToken)
    for (const [kind, host] of [
      ['onHost', HOST_B],
      ['plain', undefined],
    ] as const) {
      const at = nextIp()
      tickets[kind] = { at, ticket: await ticketFor('o-late', at, host) }
    }
    // as the tenant pages will: the row, then its sessions, then every session's reload
    await setB(0)
    await on.get(SessionRevoker).revokeTenant(B.id, TENANT_UNAVAILABLE)
    await on.get(PermVersion).bumpAll()
  })

  afterAll(async () => {
    await setB(1)
    await on.get(PermVersion).bumpAll()
  })

  it('signs nobody in by WeChat', async () => {
    expectErr(
      await post(on, '/auth/wx-mp/login', { code: wxCode('o-b-alice') }),
      Err.AUTH_WX_MP_REFUSED,
    )
  })

  it('signs nobody in by SMS, disabled or expired; the attempt is logged in that tenant', async () => {
    const attempt = async () => {
      const since = await maxId('aud_signin_log')
      expectErr(
        await post(on, '/auth/sms/login', {
          mobile: DAVE_MOBILE,
          code: '000000',
          tenantCode: B.code,
        }),
        Err.AUTH_SMS_CODE_INVALID,
      )
      const logged = () =>
        ds.query<{ kind: string; tenant_id: number; msg_key: string }[]>(
          'SELECT kind, tenant_id, msg_key FROM aud_signin_log WHERE id > ? AND username = ?',
          [since, masked.mobile(DAVE_MOBILE)],
        )
      await vi.waitFor(async () => expect(await logged()).toHaveLength(1))
      expect(await logged()).toEqual([
        { kind: 'sms', tenant_id: B.id, msg_key: 'signin.tenant_unavailable' },
      ])
    }
    await attempt()
    // enabled again but past its end
    await ds.query(
      'UPDATE iam_tenant SET enabled = 1, expires_at = NOW(3) - INTERVAL 1 DAY WHERE id = ?',
      [B.id],
    )
    try {
      await attempt()
    } finally {
      await ds.query('UPDATE iam_tenant SET enabled = 0, expires_at = NULL WHERE id = ?', [B.id])
    }
  })

  it('redeems no code approved before', async () => {
    expectInvalidGrant(await exchange(code))
  })

  it('binds no ticket issued before, on its host or by its code', async () => {
    const { onHost, plain } = tickets
    expectErr(
      await post(
        on,
        '/auth/wx-mp/bind',
        { ticket: onHost.ticket, ...creds },
        { at: onHost.at, host: HOST_B },
      ),
      Err.AUTH_BAD_CREDENTIALS,
    )
    expectErr(
      await post(
        on,
        '/auth/wx-mp/bind',
        { ticket: plain.ticket, ...creds, tenantCode: B.code },
        { at: plain.at },
      ),
      Err.AUTH_BAD_CREDENTIALS,
    )
    expect(await bindings('o-late')).toEqual([])
  })

  it('with multi-tenancy off, an available tenant’s users sign in by WeChat nowhere either', async () => {
    await setB(1)
    try {
      expectErr(
        await post(off, '/auth/wx-mp/login', { code: wxCode('o-b-alice') }),
        Err.AUTH_WX_MP_REFUSED,
      )
    } finally {
      await setB(0)
    }
  })
})
