// WeChat mini program sign-in and binding (see docs/design-notes.md#auth-sessions) with a fake
// code2Session gateway. A fake code is `<openid>~<n>`; `refused~<n>` is one WeChat refuses. Every
// request picks its own client IP through X-Forwarded-For (trusted from loopback), so throttles and
// sign-in counters never cross tests.
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, WX_MP_ENABLED_PARAM } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { PASSWORD_RESET, SessionRevoker } from '../../src/core/auth/session-revoker.js'
import { TokenService } from '../../src/core/auth/token.service.js'
import { CaptchaTicketVerifier } from '../../src/core/captcha/captcha-ticket.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import {
  parseCode2Session,
  WxMpGateway,
  type WxMpIdentity,
} from '../../src/modules/platform/iam/social/wx-mp.gateway.js'
import { WxMpService } from '../../src/modules/platform/iam/social/wx-mp.service.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'wxmp-e2e-'
const PW = 'WxMp-e2e#2026'
const APPID = 'wx00e2e0000000000a'
/** what a real code2Session answers besides the identity: must never leave the server */
const SESSION_KEY = 'SK-must-never-leave-the-server'
const PARAMS = [WX_MP_ENABLED_PARAM, 'captcha.mode'] as const

const gateway = {
  appid: vi.fn((): string | null => APPID),
  code2Session: vi.fn(async (code: string): Promise<WxMpIdentity> => {
    const openid = code.split('~')[0]!
    if (openid === 'refused') throw new BizError(Err.AUTH_WX_MP_CODE_INVALID)
    return { openid, unionid: null, session_key: SESSION_KEY } as WxMpIdentity
  }),
}

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let params: ParamService
let ipSeq = 0
let codeSeq = 0
const original = new Map<string, string>()
const users = new Map<string, number>()
/** every response body, checked for the session_key at the end */
const bodies: unknown[] = []

const http = () => request(app.getHttpServer())
/** A fresh benchmarking-range client IP (RFC 2544) per call. */
const nextIp = () => `198.19.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`
const code = (openid: string) => `${openid}~${++codeSeq}`
const kept = (res: request.Response) => (bodies.push(res.body), res)
const wxLogin = async (c: string, ip = nextIp()) =>
  kept(await http().post('/api/auth/wx-mp/login').set('X-Forwarded-For', ip).send({ code: c }))
const bind = async (body: object, ip = nextIp()) =>
  kept(await http().post('/api/auth/wx-mp/bind').set('X-Forwarded-For', ip).send(body))
/** An unbound identity's bind ticket, issued to `ip`. */
const ticketFor = async (openid: string, ip: string) => {
  const res = await wxLogin(code(openid), ip)
  expect(res.status).toBe(200)
  return res.body.data.bindTicket as string
}
const withPassword = (ticket: string, name: string, password = PW) => ({
  ticket,
  username: PREFIX + name,
  password,
})
const binding = async (name: string) =>
  ds.query<{ provider: string; appid: string; openid: string; deleted_at: Date | null }[]>(
    'SELECT provider, appid, openid, deleted_at FROM iam_user_social WHERE user_id = ? ORDER BY id',
    [users.get(name)],
  )
const expectErr = (res: request.Response, status: number, err: { code: string }) => {
  expect(res.status).toBe(status)
  expect(res.body.code).toBe(err.code)
  expect(res.body.data).toBeNull()
}
const setParam = async (key: string, value: string) => {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await params.invalidate(key)
}
async function user(name: string, over: Record<string, unknown> = {}) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: await bcrypt.hash(PW, 4),
    password_changed_at: new Date(),
    ...over,
  })
  users.set(name, id)
  return id
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WxMpGateway)
    .useValue(gateway)
    .compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  params = app.get(ParamService)
  await cleanRedis(redis)
  const rows = await ds.query<{ param_key: string; param_value: string }[]>(
    'SELECT param_key, param_value FROM cfg_param WHERE param_key IN (?)',
    [PARAMS],
  )
  for (const r of rows) original.set(r.param_key, r.param_value)
  // seeded off (seed-idempotent checks the value)
  await setParam('captcha.mode', 'off')
  await setParam(WX_MP_ENABLED_PARAM, 'true')
  for (const name of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gone'] as const)
    await user(name)
  for (const name of ['pwself', 'pwadmin', 'kicked', 'unbinder', 'racer'] as const) await user(name)
  await user('pwsms', { mobile: '13800992004' })
  await user('off', { enabled: 0 })
  await user('fresh', { password_changed_at: null })
  await user('sms', { mobile: '13800992001' })
  await user('smsoff', { mobile: '13800992002', enabled: 0 })
})

afterAll(async () => {
  if (ds) {
    for (const [key, value] of original) await setParam(key, value)
    const ids = [...users.values()]
    if (ids.length) {
      await ds.query('DELETE FROM iam_user_social WHERE user_id IN (?)', [ids])
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [ids])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [ids])
    }
    await ds.query("DELETE FROM msg_sms_otp WHERE mobile LIKE '138009920%'")
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

afterEach(() => vi.clearAllMocks())

describe('code2Session answers (the real gateway, parsed)', () => {
  it('keeps only openid/unionid; refused codes 400, upstream failures 502', () => {
    expect(parseCode2Session(`{"openid":"o-1","session_key":"${SESSION_KEY}"}`)).toEqual({
      openid: 'o-1',
      unionid: null,
    })
    expect(parseCode2Session('{"openid":"o-2","unionid":"u-2","session_key":"k"}')).toEqual({
      openid: 'o-2',
      unionid: 'u-2',
    })
    const fails = (body: string) => {
      try {
        parseCode2Session(body)
      } catch (e) {
        return (e as BizError).err.code
      }
      return null
    }
    expect(fails('{"errcode":40029,"errmsg":"invalid code"}')).toBe(
      Err.AUTH_WX_MP_CODE_INVALID.code,
    )
    expect(fails('{"errcode":40163,"errmsg":"code been used"}')).toBe(
      Err.AUTH_WX_MP_CODE_INVALID.code,
    )
    expect(fails('{"errcode":-1,"errmsg":"busy"}')).toBe(Err.AUTH_WX_MP_UPSTREAM.code)
    expect(fails('{"errcode":45011}')).toBe(Err.AUTH_WX_MP_UPSTREAM.code)
    expect(fails('<html>')).toBe(Err.AUTH_WX_MP_UPSTREAM.code)
    expect(fails('{"session_key":"k"}')).toBe(Err.AUTH_WX_MP_UPSTREAM.code)
    expect(fails('{"openid":"a b"}')).toBe(Err.AUTH_WX_MP_UPSTREAM.code)
  })
})

it('Swagger documents the WeChat routes', async () => {
  const doc = (await http().get('/api/docs-json').expect(200)).body
  expect(doc.paths['/api/auth/wx-mp/login'].post.summary).toMatch(/uni\.login code/)
  expect(doc.paths['/api/auth/wx-mp/bind'].post.summary).toMatch(/Bind/)
  expect(doc.paths['/api/iam/profile/socials'].get).toBeDefined()
  expect(doc.paths['/api/iam/profile/socials/wx-mp'].delete).toBeDefined()
})

describe('switch', () => {
  it('param off, or no AppID/secret: sign-in and bind 404, WeChat is never asked; the own bindings stay listable and removable', async () => {
    const { accessToken } = await signIn(app, PREFIX + 'erin')
    const auth = bearer(accessToken)
    const row = await insertRow(ds.manager, 'iam_user_social', {
      provider: 'wx-mp',
      appid: APPID,
      openid: 'o-kept',
      user_id: users.get('erin'),
    })
    const signIns = async () => [
      await wxLogin(code('o-off')),
      await bind({ ticket: 'x'.repeat(32), username: 'a', password: 'b' }),
    ]
    await setParam(WX_MP_ENABLED_PARAM, 'false')
    try {
      for (const res of await signIns()) expectErr(res, 404, Err.NOT_FOUND)
      expect(kept(await http().get('/api/iam/profile/socials').set(auth)).body.data).toEqual([
        { provider: 'wx-mp', appid: APPID, boundAt: expect.any(String) },
      ])
      expect(kept(await http().delete('/api/iam/profile/socials/wx-mp').set(auth)).status).toBe(200)
    } finally {
      await setParam(WX_MP_ENABLED_PARAM, 'true')
    }
    expect(await binding('erin')).toMatchObject([
      { openid: 'o-kept', deleted_at: expect.any(Date) },
    ])
    gateway.appid.mockReturnValue(null)
    try {
      for (const res of await signIns()) expectErr(res, 404, Err.NOT_FOUND)
    } finally {
      gateway.appid.mockReturnValue(APPID)
    }
    expect(gateway.code2Session).not.toHaveBeenCalled()
    await ds.query('DELETE FROM iam_user_social WHERE id = ?', [row])
  })
})

describe('sign-in and binding', () => {
  it('unbound → a bind ticket, never a token; a code is single use (replay 400 before WeChat); a refused code 400', async () => {
    const c = code('o-new')
    const first = await wxLogin(c)
    expect(first.status).toBe(200)
    expect(first.body.data).toEqual({ bindTicket: expect.stringMatching(/^[\w-]{32}$/) })
    expectErr(await wxLogin(c), 400, Err.AUTH_WX_MP_CODE_INVALID)
    expect(gateway.code2Session).toHaveBeenCalledTimes(1)
    expectErr(await wxLogin(code('refused')), 400, Err.AUTH_WX_MP_CODE_INVALID)
    expectErr(await wxLogin(''), 400, Err.VALIDATION_FAILED)
    // the ticket holds the identity and the IP, nothing of WeChat's session
    const stored = await redis.get(
      redisKey(
        'wxMp',
        'ticket',
        createHash('sha256').update(first.body.data.bindTicket).digest('hex'),
      ),
    )
    expect(JSON.parse(stored!)).toEqual({
      appid: APPID,
      openid: 'o-new',
      unionid: null,
      ip: expect.any(String),
    })
  })

  it('bind by password → a mobile session (refresh via body works, a console cookie refresh does not); the next WeChat sign-in is direct; logged as wx-mp', async () => {
    const ip = nextIp()
    const res = await bind(withPassword(await ticketFor('o-alice', ip), 'alice'), ip)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      accessToken: expect.stringMatching(/^[\w-]{43}$/),
      expiresIn: 1800,
      refreshToken: expect.stringMatching(/^[\w-]{43}$/),
      refreshExpiresIn: 604_800,
    })
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(await app.get(TokenService).authenticate(res.body.data.accessToken)).toMatchObject({
      userId: users.get('alice'),
      clientId: 'mobile',
      keepSignedIn: true,
    })
    expect(await binding('alice')).toEqual([
      { provider: 'wx-mp', appid: APPID, openid: 'o-alice', deleted_at: null },
    ])

    const origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`
    const viaCookie = await http()
      .post('/api/auth/refresh')
      .set('X-Forwarded-For', nextIp())
      .set('Origin', origin)
      .set('Cookie', `qw_rt=${res.body.data.refreshToken}`)
    expectErr(viaCookie, 401, Err.AUTH_REFRESH_REJECTED)
    const viaBody = kept(
      await http()
        .post('/api/auth/refresh')
        .set('X-Forwarded-For', nextIp())
        .send({ refreshToken: res.body.data.refreshToken }),
    )
    expect(viaBody.status).toBe(200)
    expect(viaBody.body.data.refreshToken).not.toBe(res.body.data.refreshToken)

    const again = await wxLogin(code('o-alice'))
    expect(again.status).toBe(200)
    expect(again.body.data).toEqual({
      tokens: {
        accessToken: expect.stringMatching(/^[\w-]{43}$/),
        expiresIn: 1800,
        refreshToken: expect.stringMatching(/^[\w-]{43}$/),
        refreshExpiresIn: 604_800,
      },
    })
    const auth = bearer(again.body.data.tokens.accessToken)
    const me = await http().get('/api/auth/me').set(auth).expect(200)
    expect(me.body.data.user.username).toBe(`${PREFIX}alice`)
    const list = kept(await http().get('/api/iam/profile/socials').set(auth).expect(200))
    expect(list.body.data).toEqual([
      { provider: 'wx-mp', appid: APPID, boundAt: expect.stringMatching(/Z$/) },
    ])
    const log = await vi.waitFor(
      async () => {
        const rows = await ds.query<{ kind: string; client_id: string; ok: number }[]>(
          'SELECT kind, client_id, ok FROM aud_signin_log WHERE user_id = ? ORDER BY id',
          [users.get('alice')],
        )
        if (rows.length < 2) throw new Error('sign-in rows pending')
        return rows
      },
      { timeout: 5000 },
    )
    expect(log.map((r) => [r.kind, r.client_id, Number(r.ok)])).toEqual([
      ['wx-mp', 'mobile', 1],
      ['wx-mp', 'mobile', 1],
    ])
  })

  it('ticket: replayed, expired, from another IP or forged → 400 ticket_invalid; a wrong password spends it too', async () => {
    const ipA = nextIp()
    const t1 = await ticketFor('o-t1', ipA)
    expectErr(
      await bind(withPassword(t1, 'dave', 'wrong-Pass#1'), ipA),
      401,
      Err.AUTH_BAD_CREDENTIALS,
    )
    expectErr(await bind(withPassword(t1, 'dave'), ipA), 400, Err.AUTH_WX_MP_TICKET_INVALID)

    const t2 = await ticketFor('o-t2', ipA)
    expectErr(await bind(withPassword(t2, 'dave'), nextIp()), 400, Err.AUTH_WX_MP_TICKET_INVALID)
    expectErr(await bind(withPassword(t2, 'dave'), ipA), 400, Err.AUTH_WX_MP_TICKET_INVALID)

    const t3 = await ticketFor('o-t3', ipA)
    const key = redisKey('wxMp', 'ticket', createHash('sha256').update(t3).digest('hex'))
    expect(await redis.pTTL(key)).toBeGreaterThan(290_000)
    expect(await redis.pTTL(key)).toBeLessThanOrEqual(300_000)
    await redis.unlink(key) // what the 5 minutes do
    expectErr(await bind(withPassword(t3, 'dave'), ipA), 400, Err.AUTH_WX_MP_TICKET_INVALID)

    expectErr(
      await bind(withPassword('forged-ticket-0123456789abcdef', 'dave'), ipA),
      400,
      Err.AUTH_WX_MP_TICKET_INVALID,
    )
    // a ticket of another mini program (the AppID changed since)
    const t4 = await ticketFor('o-t4', ipA)
    gateway.appid.mockReturnValue('wx00e2e0000000000b')
    try {
      expectErr(await bind(withPassword(t4, 'dave'), ipA), 400, Err.AUTH_WX_MP_TICKET_INVALID)
    } finally {
      gateway.appid.mockReturnValue(APPID)
    }
    expect(await binding('dave')).toEqual([])
  })

  it('the binding write re-checks the proof: a password changed, a mobile moved, a user disabled or deleted meanwhile binds nothing', async () => {
    const wx = app.get(WxMpService) as unknown as {
      insert: (t: object, userId: number, proof: object) => Promise<void>
    }
    const t = { appid: APPID, openid: 'o-race', unionid: null, ip: '127.0.0.1' }
    const id = users.get('carol')!
    const [{ password_hash: hash }] = await ds.query<{ password_hash: string }[]>(
      'SELECT password_hash FROM iam_user WHERE id = ?',
      [id],
    )
    const refused = async (proof: object, err: { code: string }) =>
      expect(wx.insert(t, id, proof)).rejects.toMatchObject({ err: { code: err.code } })
    await ds.query('UPDATE iam_user SET mobile = ? WHERE id = ?', ['13800992003', id])
    await refused({ passwordHash: `${hash}x` }, Err.AUTH_BAD_CREDENTIALS)
    await refused({ mobile: '13800992999' }, Err.AUTH_SMS_CODE_INVALID)
    for (const change of ['enabled = 0', 'deleted_at = NOW(3)']) {
      await ds.query(`UPDATE iam_user SET ${change} WHERE id = ?`, [id])
      try {
        await refused({ passwordHash: hash }, Err.AUTH_BAD_CREDENTIALS)
        await refused({ mobile: '13800992003' }, Err.AUTH_SMS_CODE_INVALID)
      } finally {
        await ds.query('UPDATE iam_user SET enabled = 1, deleted_at = NULL WHERE id = ?', [id])
      }
    }
    await ds.query('UPDATE iam_user SET mobile = NULL WHERE id = ?', [id])
    expect(await binding('carol')).toEqual([])
  })

  it('a password binding passes /login’s gates: the username+IP lockout, the captcha (scene signin, this IP)', async () => {
    const ip = nextIp()
    const pair = redisKey('authFail', 'p', `${PREFIX}frank`, ip)
    await redis.set(pair, '99')
    try {
      expectErr(
        await bind(withPassword(await ticketFor('o-frank', ip), 'frank'), ip),
        429,
        Err.AUTH_LOCKED,
      )
    } finally {
      await redis.del(pair)
    }
    const verify = vi.spyOn(app.get(CaptchaTicketVerifier), 'verify')
    await setParam('captcha.mode', 'image')
    try {
      expectErr(
        await bind(withPassword(await ticketFor('o-frank', ip), 'frank'), ip),
        403,
        Err.AUTH_CAPTCHA_REQUIRED,
      )
      expect(await binding('frank')).toEqual([])
      verify.mockResolvedValueOnce(true)
      const t = await ticketFor('o-frank', ip)
      expect((await bind({ ...withPassword(t, 'frank'), captchaTicket: 'cap-1' }, ip)).status).toBe(
        200,
      )
      expect(verify).toHaveBeenLastCalledWith('signin', ip, 'cap-1')
    } finally {
      verify.mockRestore()
      await setParam('captcha.mode', 'off')
    }
    expect(await binding('frank')).toMatchObject([{ openid: 'o-frank', deleted_at: null }])
  })

  it('a disabled or deleted user is refused (password 401 as /login, SMS 400 as /sms/login); nothing bound', async () => {
    const ip = nextIp()
    expectErr(
      await bind(withPassword(await ticketFor('o-off', ip), 'off'), ip),
      401,
      Err.AUTH_BAD_CREDENTIALS,
    )
    await ds.query('UPDATE iam_user SET deleted_at = NOW(3) WHERE id = ?', [users.get('gone')])
    try {
      expectErr(
        await bind(withPassword(await ticketFor('o-gone', ip), 'gone'), ip),
        401,
        Err.AUTH_BAD_CREDENTIALS,
      )
    } finally {
      await ds.query('UPDATE iam_user SET deleted_at = NULL WHERE id = ?', [users.get('gone')])
    }
    await insertRow(ds.manager, 'msg_sms_otp', {
      mobile: '13800992002',
      scene: 'signin',
      code: '246810',
      daily_seq: 1,
      request_ip: '127.0.0.1',
    })
    const sms = { ticket: await ticketFor('o-smsoff', ip), mobile: '13800992002', code: '246810' }
    expectErr(await bind(sms, ip), 400, Err.AUTH_SMS_CODE_INVALID)
    expect([
      ...(await binding('off')),
      ...(await binding('gone')),
      ...(await binding('smsoff')),
    ]).toEqual([])
  })

  it('bind by SMS code → binding and session; a wrong code 400', async () => {
    const ip = nextIp()
    await insertRow(ds.manager, 'msg_sms_otp', {
      mobile: '13800992001',
      scene: 'signin',
      code: '135790',
      daily_seq: 1,
      request_ip: '127.0.0.1',
    })
    const wrong = { ticket: await ticketFor('o-sms', ip), mobile: '13800992001', code: '000000' }
    expectErr(await bind(wrong, ip), 400, Err.AUTH_SMS_CODE_INVALID)
    const res = await bind(
      { ticket: await ticketFor('o-sms', ip), mobile: '13800992001', code: '135790' },
      ip,
    )
    expect(res.status).toBe(200)
    expect(res.body.data.refreshToken).toMatch(/^[\w-]{43}$/)
    expect(await app.get(TokenService).authenticate(res.body.data.accessToken)).toMatchObject({
      userId: users.get('sms'),
      clientId: 'mobile',
      keepSignedIn: true,
    })
    expect(await binding('sms')).toMatchObject([{ openid: 'o-sms', deleted_at: null }])
  })

  it('one identity binds one user, one user one identity per app → 409', async () => {
    const ip = nextIp()
    const [tBob, tCarol] = [await ticketFor('o-bob', ip), await ticketFor('o-bob', ip)]
    expect((await bind(withPassword(tBob, 'bob'), ip)).status).toBe(200)
    expectErr(await bind(withPassword(tCarol, 'carol'), ip), 409, Err.AUTH_WX_MP_BOUND)
    expect(await binding('carol')).toEqual([])
    expectErr(
      await bind(withPassword(await ticketFor('o-bob-2', ip), 'bob'), ip),
      409,
      Err.AUTH_WX_MP_USER_BOUND,
    )
    expect(await binding('bob')).toMatchObject([{ openid: 'o-bob' }])
    // by SMS code too (sms holds o-sms since the test above)
    await insertRow(ds.manager, 'msg_sms_otp', {
      mobile: '13800992001',
      scene: 'signin',
      code: '975310',
      daily_seq: 1,
      request_ip: '127.0.0.1',
    })
    const bySms = { ticket: await ticketFor('o-sms-2', ip), mobile: '13800992001', code: '975310' }
    expectErr(await bind(bySms, ip), 409, Err.AUTH_WX_MP_USER_BOUND)

    // proven, then refused: a failed wx-mp sign-in of that user
    const refused = (name: string) =>
      vi.waitFor(
        async () => {
          const rows = await ds.query<{ kind: string; username: string; ok: number }[]>(
            `SELECT kind, username, ok FROM aud_signin_log
              WHERE user_id = ? AND msg_key = 'signin.bind_refused' ORDER BY id`,
            [users.get(name)],
          )
          if (!rows.length) throw new Error('sign-in rows pending')
          return rows.map((r) => [r.kind, r.username, Number(r.ok)])
        },
        { timeout: 5000 },
      )
    for (const name of ['carol', 'bob', 'sms'])
      expect(await refused(name)).toEqual([['wx-mp', PREFIX + name, 0]])
  })
})

describe('credential changes and unbinding', () => {
  const NEW_PW = 'WxMp-e2e#2027'
  /** `name` bound to WeChat `openid` by password: the bind's mobile session tokens. */
  const bound = async (name: string, openid: string) => {
    const ip = nextIp()
    const res = await bind(withPassword(await ticketFor(openid, ip), name), ip)
    expect(res.status).toBe(200)
    return res.body.data as { accessToken: string; refreshToken: string }
  }
  const refresh = async (refreshToken: string) =>
    kept(
      await http()
        .post('/api/auth/refresh')
        .set('X-Forwarded-For', nextIp())
        .send({ refreshToken }),
    )
  const updatedBy = async (name: string) =>
    (
      await ds.query<{ updated_by: number }[]>(
        'SELECT updated_by FROM iam_user_social WHERE user_id = ?',
        [users.get(name)],
      )
    ).map((r) => Number(r.updated_by))

  it('a password changed, reset by SMS or reset by an admin ends the WeChat binding: its openid gets a bind ticket', async () => {
    // own change, from the WeChat session itself
    const self = await bound('pwself', 'o-pwself')
    expect((await wxLogin(code('o-pwself'))).body.data).toHaveProperty('tokens')
    const changed = await http()
      .put('/api/iam/profile/password')
      .set('X-Forwarded-For', nextIp())
      .set(bearer(self.accessToken))
      .send({ oldPassword: PW, newPassword: NEW_PW })
    expect(kept(changed).status).toBe(200)

    await bound('pwsms', 'o-pwsms')
    await insertRow(ds.manager, 'msg_sms_otp', {
      mobile: '13800992004',
      scene: 'reset_password',
      code: '864209',
      daily_seq: 1,
      request_ip: '127.0.0.1',
    })
    const reset = await http()
      .post('/api/auth/password/reset-by-sms')
      .set('X-Forwarded-For', nextIp())
      .send({ mobile: '13800992004', code: '864209', newPassword: NEW_PW })
    expect(kept(reset).status).toBe(200)

    await bound('pwadmin', 'o-pwadmin')
    const admin = await signIn(app)
    const byAdmin = await http()
      .put(`/api/iam/users/${users.get('pwadmin')}/password`)
      .set(bearer(admin.accessToken))
      .send({ password: NEW_PW })
    expect(kept(byAdmin).status).toBe(200)

    for (const name of ['pwself', 'pwsms', 'pwadmin']) {
      expect(await binding(name)).toMatchObject([
        { openid: `o-${name}`, deleted_at: expect.any(Date) },
      ])
      expect((await wxLogin(code(`o-${name}`))).body.data).toEqual({
        bindTicket: expect.any(String),
      })
    }
    // who ended it: the admin, else the user
    expect(await updatedBy('pwadmin')).toEqual([admin.session.userId])
    expect(await updatedBy('pwsms')).toEqual([users.get('pwsms')])
  })

  it('a kick ends the sessions and keeps the binding', async () => {
    const tokens = await bound('kicked', 'o-kicked')
    const admin = await signIn(app)
    const kick = await http()
      .post('/api/iam/sessions/kick')
      .set(bearer(admin.accessToken))
      .send({ userId: users.get('kicked') })
    expect(kept(kick).body.data).toEqual({ kicked: 1 })
    expectErr(await refresh(tokens.refreshToken), 401, Err.AUTH_REFRESH_REJECTED)
    expect(await binding('kicked')).toMatchObject([{ openid: 'o-kicked', deleted_at: null }])
    expect((await wxLogin(code('o-kicked'))).body.data).toHaveProperty('tokens')
  })

  it('unbind ends the caller’s other mobile sessions: the current one and console sessions stay', async () => {
    const other = await bound('unbinder', 'o-unbinder')
    const current = (await wxLogin(code('o-unbinder'))).body.data.tokens as typeof other
    const console = await signIn(app, PREFIX + 'unbinder')
    const unbind = await http()
      .delete('/api/iam/profile/socials/wx-mp')
      .set(bearer(current.accessToken))
    expect(kept(unbind).status).toBe(200)
    expectErr(await refresh(other.refreshToken), 401, Err.AUTH_REFRESH_REJECTED)
    await http().get('/api/auth/me').set(bearer(current.accessToken)).expect(200)
    expect((await refresh(current.refreshToken)).status).toBe(200)
    await http().get('/api/auth/me').set(bearer(console.accessToken)).expect(200)
    expect((await wxLogin(code('o-unbinder'))).body.data).toEqual({
      bindTicket: expect.any(String),
    })
  })

  it('a password reset or an unbind racing a WeChat sign-in past its binding lookup refuses it: 403, logged', async () => {
    const tokens = app.get(TokenService)
    const credVersion = tokens.credVersion.bind(tokens)
    const id = users.get('racer')!
    const endings = [
      () => app.get(SessionRevoker).revokeUser(id, PASSWORD_RESET),
      () => app.get(WxMpService).unbind(id, undefined),
    ]
    const spy = vi.spyOn(tokens, 'credVersion')
    try {
      for (const end of endings) {
        await bound('racer', 'o-racer')
        // the binding ends after the sign-in found it, before it reads credver
        spy.mockImplementationOnce(async (userId) => {
          await end()
          return credVersion(userId)
        })
        expectErr(await wxLogin(code('o-racer')), 403, Err.AUTH_WX_MP_REFUSED)
      }
    } finally {
      spy.mockRestore()
    }
    const rows = await vi.waitFor(
      async () => {
        const r = await ds.query<{ kind: string; ok: number }[]>(
          `SELECT kind, ok FROM aud_signin_log WHERE user_id = ? AND msg_key = 'signin.bind_refused'`,
          [id],
        )
        if (r.length < 2) throw new Error('sign-in rows pending')
        return r.map((x) => [x.kind, Number(x.ok)])
      },
      { timeout: 5000 },
    )
    expect(rows).toEqual([
      ['wx-mp', 0],
      ['wx-mp', 0],
    ])
  })
})

describe('bound accounts', () => {
  it('an initial password carries the must-change flags into the WeChat session (403 elsewhere)', async () => {
    const ip = nextIp()
    const res = await bind(withPassword(await ticketFor('o-fresh', ip), 'fresh'), ip)
    expect(res.status).toBe(200)
    const signedIn = await wxLogin(code('o-fresh'))
    const auth = bearer(signedIn.body.data.tokens.accessToken)
    const me = await http().get('/api/auth/me').set(auth).expect(200)
    expect(me.body.data.flags).toEqual({ mustChangePassword: true, passwordExpired: false })
    expectErr(
      kept(await http().get('/api/iam/profile/socials').set(auth)),
      403,
      Err.AUTH_PASSWORD_CHANGE_REQUIRED,
    )
  })

  it('only this app’s binding of the exact openid signs in: another case or another app’s binding gets a ticket', async () => {
    expect((await wxLogin(code('o-alice'))).body.data).toHaveProperty('tokens')
    expect((await wxLogin(code('O-ALICE'))).body.data).toEqual({ bindTicket: expect.any(String) })
    const row = await insertRow(ds.manager, 'iam_user_social', {
      provider: 'wx-mp',
      appid: 'wx00e2e0000000000b',
      openid: 'o-other-app',
      user_id: users.get('carol'),
    })
    try {
      expect((await wxLogin(code('o-other-app'))).body.data).toEqual({
        bindTicket: expect.any(String),
      })
    } finally {
      await ds.query('DELETE FROM iam_user_social WHERE id = ?', [row])
    }
  })

  it('a disabled bound user → 403 refused; an unbound or deleted user’s identity gets a ticket again', async () => {
    const ip = nextIp()
    expect((await bind(withPassword(await ticketFor('o-erin', ip), 'erin'), ip)).status).toBe(200)
    await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [users.get('erin')])
    try {
      expectErr(await wxLogin(code('o-erin')), 403, Err.AUTH_WX_MP_REFUSED)
    } finally {
      await ds.query('UPDATE iam_user SET enabled = 1 WHERE id = ?', [users.get('erin')])
    }
    const { accessToken } = await signIn(app, PREFIX + 'erin')
    const unbind = () => http().delete('/api/iam/profile/socials/wx-mp').set(bearer(accessToken))
    expect(kept(await unbind()).status).toBe(200)
    expect(await binding('erin')).toMatchObject([
      { openid: 'o-erin', deleted_at: expect.any(Date) },
    ])
    expect((await wxLogin(code('o-erin'))).body.data).toEqual({ bindTicket: expect.any(String) })
    expectErr(kept(await unbind()), 404, Err.NOT_FOUND)

    // deleting the user deletes its binding (cascade)
    expect((await bind(withPassword(await ticketFor('o-gone', ip), 'gone'), ip)).status).toBe(200)
    const admin = await signIn(app)
    await http()
      .delete(`/api/iam/users/${users.get('gone')}`)
      .set(bearer(admin.accessToken))
      .expect(200)
    expect(await binding('gone')).toMatchObject([{ deleted_at: expect.any(Date) }])
    expect((await wxLogin(code('o-gone'))).body.data).toEqual({ bindTicket: expect.any(String) })
  })

  it('unbind acts on the caller only: another user cannot remove a binding; anonymous 401', async () => {
    const ip = nextIp()
    await bind(withPassword(await ticketFor('o-dave', ip), 'dave'), ip)
    const carol = await signIn(app, PREFIX + 'carol')
    expectErr(
      kept(await http().delete('/api/iam/profile/socials/wx-mp').set(bearer(carol.accessToken))),
      404,
      Err.NOT_FOUND,
    )
    expect(
      kept(await http().get('/api/iam/profile/socials').set(bearer(carol.accessToken))).body.data,
    ).toEqual([])
    expectErr(kept(await http().delete('/api/iam/profile/socials/wx-mp')), 401, Err.UNAUTHENTICATED)
    expect(await binding('dave')).toMatchObject([{ openid: 'o-dave', deleted_at: null }])
    expect((await wxLogin(code('o-dave'))).body.data).toHaveProperty('tokens')
  })

  it('rate limits: the 21st login or bind call within a minute from one IP → 429', async () => {
    for (const path of ['login', 'bind']) {
      const ip = nextIp()
      for (let i = 0; i < 20; i++)
        expect(
          (await http().post(`/api/auth/wx-mp/${path}`).set('X-Forwarded-For', ip).send({})).status,
        ).toBe(400)
      expectErr(
        await http().post(`/api/auth/wx-mp/${path}`).set('X-Forwarded-For', ip).send({}),
        429,
        Err.TOO_MANY_REQUESTS,
      )
    }
  })

  it('WeChat’s session_key is in no response', () => {
    expect(bodies.length).toBeGreaterThan(40)
    expect(JSON.stringify(bodies)).not.toContain(SESSION_KEY)
  })
})
