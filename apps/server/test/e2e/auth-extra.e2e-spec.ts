import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, signupParams, userPerms } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import type { AddressInfo } from 'node:net'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AuthParams } from '../../src/core/auth/auth-params.js'
import { CaptchaTicketVerifier } from '../../src/core/captcha/captcha-ticket.js'
import { NotifyDispatcher } from '../../src/core/notify/notify.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { OtpService } from '../../src/modules/platform/messaging/sms-otp/sms-otp.service.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'auth-extra-signup-'
const PASSWORD = 'Signup#Pass2026'
const PARAMS = [...Object.values(signupParams), 'captcha.mode', 'iam.password_min_length'] as const

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let params: ParamService
let tickets: CaptchaTicketVerifier
let memberRoleId: number
const original = new Map<string, string>()

const http = () => request(app.getHttpServer())
const name = (suffix: string) => PREFIX + suffix
const signup = (suffix: string, body: Record<string, unknown> = {}, language = 'en-US') =>
  http()
    .post('/api/auth/signup')
    .set('Accept-Language', language)
    .send({ username: name(suffix), password: PASSWORD, ...body })
const row = async (suffix: string) =>
  (
    await ds.query<{ id: number; dept_id: number | null; enabled: number; user_type: string }[]>(
      'SELECT id, dept_id, enabled, user_type FROM iam_user WHERE username = ?',
      [name(suffix)],
    )
  )[0]
const setParam = async (key: string, value: string) => {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await params.invalidate(key)
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  params = app.get(ParamService)
  tickets = app.get(CaptchaTicketVerifier)
  memberRoleId = Number(
    (await ds.query("SELECT id FROM iam_role WHERE code = 'member' AND deleted_at IS NULL"))[0].id,
  )
  await cleanRedis(redis)
  const rows = await ds.query<{ param_key: string; param_value: string }[]>(
    'SELECT param_key, param_value FROM cfg_param WHERE param_key IN (?)',
    [PARAMS],
  )
  for (const r of rows) original.set(r.param_key, r.param_value)
  if (!original.has('captcha.mode'))
    await ds.query(
      'INSERT INTO cfg_param (param_key, param_value, name, group_code) VALUES (?, ?, ?, ?)',
      ['captcha.mode', 'off', 'Captcha mode', 'captcha'],
    )
  await setParam('captcha.mode', 'off')
  await setParam(signupParams.enabled, 'false')
})

afterAll(async () => {
  if (ds) {
    for (const [key, value] of original) await setParam(key, value)
    if (!original.has('captcha.mode')) {
      await ds.query('DELETE FROM cfg_param WHERE param_key = ?', ['captcha.mode'])
      await params.invalidate('captcha.mode')
    }
    await ds.query(
      'DELETE ur FROM iam_user_roles ur JOIN iam_user u ON u.id = ur.user_id WHERE u.username LIKE ?',
      [`${PREFIX}%`],
    )
    await ds.query('DELETE FROM iam_user WHERE username LIKE ?', [`${PREFIX}%`])
    await ds.query(
      'DELETE FROM iam_role_menus WHERE role_id IN (SELECT id FROM iam_role WHERE code = ?)',
      [name('browse-role')],
    )
    await ds.query('DELETE FROM iam_role WHERE code = ?', [name('browse-role')])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

afterEach(() => vi.restoreAllMocks())

describe('signup', () => {
  it('switch off rejects before writing any user', async () => {
    const res = await signup('off').expect(403)
    expect(res.body.code).toBe(Err.AUTH_SIGNUP_DISABLED.code)
    expect(await row('off')).toBeUndefined()
  })

  it('creates only a member with the home and approval menus; login and profile work', async () => {
    await setParam(signupParams.enabled, 'true')
    const res = await signup('member', { displayName: 'Member A' }).expect(201)
    expect(res.body.data).toBeNull()
    const created = (await row('member'))!
    expect(created).toMatchObject({ dept_id: null, enabled: 1, user_type: 'admin' })
    const roles = await ds.query<{ id: number }[]>(
      'SELECT r.id FROM iam_user_roles ur JOIN iam_role r ON r.id = ur.role_id WHERE ur.user_id = ?',
      [created.id],
    )
    expect(roles.map((r) => Number(r.id))).toEqual([memberRoleId])
    const login = await http()
      .post('/api/auth/login')
      .send({ username: name('member'), password: PASSWORD })
      .expect(200)
    const auth = bearer(login.body.data.accessToken)
    const menus = (await http().get('/api/auth/menus').set(auth).expect(200)).body.data
    expect(menus.map((m: { routeName: string }) => m.routeName)).toEqual(['home', 'workflow'])
    await http().get('/api/iam/profile').set(auth).expect(200)
  })

  it('uses only a live enabled configured department; ignores request privilege fields', async () => {
    const [dept] = await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_dept WHERE name = ? AND enabled = 1 AND deleted_at IS NULL',
      ['seed.dept.support'],
    )
    expect(dept).toBeDefined()
    await setParam(signupParams.defaultDeptId, String(dept!.id))
    await signup('dept', {
      deptId: 1,
      roleIds: [1],
      enabled: false,
      userType: 'root',
    }).expect(201)
    expect((await row('dept'))?.dept_id).toBe(dept!.id)
    const [role] = await ds.query<{ code: string }[]>(
      'SELECT r.code FROM iam_user_roles ur JOIN iam_role r ON r.id = ur.role_id WHERE ur.user_id = ?',
      [(await row('dept'))!.id],
    )
    expect(role?.code).toBe('member')
    expect(await row('dept')).toMatchObject({ enabled: 1, user_type: 'admin' })
    try {
      await ds.query('UPDATE iam_dept SET enabled = 0 WHERE id = ?', [dept!.id])
      await signup('disabled-dept').expect(201)
      expect((await row('disabled-dept'))?.dept_id).toBeNull()
    } finally {
      await ds.query('UPDATE iam_dept SET enabled = 1 WHERE id = ?', [dept!.id])
    }
    await setParam(signupParams.defaultDeptId, '999999999')
    await signup('bad-dept').expect(201)
    expect((await row('bad-dept'))?.dept_id).toBeNull()
    await setParam(signupParams.defaultDeptId, '')
  })

  it('refuses a root default role and writes no user', async () => {
    const rootId = Number((await ds.query("SELECT id FROM iam_role WHERE code = 'root'"))[0].id)
    await setParam(signupParams.defaultRoleId, String(rootId))
    const res = await signup('root-role').expect(403)
    expect(res.body.code).toBe(Err.AUTH_SIGNUP_DISABLED.code)
    expect(await row('root-role')).toBeUndefined()
    await setParam(signupParams.defaultRoleId, String(memberRoleId))
  })

  it('refuses a disabled default role and writes no user', async () => {
    try {
      await ds.query('UPDATE iam_role SET enabled = 0 WHERE code = ?', ['member'])
      const res = await signup('disabled-role').expect(403)
      expect(res.body.code).toBe(Err.AUTH_SIGNUP_DISABLED.code)
      expect(await row('disabled-role')).toBeUndefined()
    } finally {
      await ds.query('UPDATE iam_role SET enabled = 1 WHERE code = ?', ['member'])
    }
  })

  it('refuses an all-scope default role without writing a user', async () => {
    try {
      await ds.query('UPDATE iam_role SET data_scope = ? WHERE id = ?', ['all', memberRoleId])
      const res = await signup('all-role').expect(403)
      expect(res.body.code).toBe(Err.AUTH_SIGNUP_DISABLED.code)
      expect(await row('all-role')).toBeUndefined()
    } finally {
      await ds.query('UPDATE iam_role SET data_scope = ? WHERE id = ?', ['own_rows', memberRoleId])
    }
  })

  it.each([
    ['empty', ''],
    ['unknown', '999999999'],
  ])('refuses %s role id without writing a user', async (suffix, value) => {
    try {
      await setParam(signupParams.defaultRoleId, value)
      const res = await signup(suffix).expect(403)
      expect(res.body.code).toBe(Err.AUTH_SIGNUP_DISABLED.code)
      expect(await row(suffix)).toBeUndefined()
    } finally {
      await setParam(signupParams.defaultRoleId, String(memberRoleId))
    }
  })

  it('applies the password policy with translated validation messages', async () => {
    const en = await signup('weak-en', { password: 'weak' }).expect(400)
    const zh = await signup('weak-zh', { password: 'weak' }, 'zh-CN').expect(400)
    expect(en.body.code).toBe(Err.VALIDATION_FAILED.code)
    expect(en.body.msg).toMatch(/password/i)
    expect(zh.body.msg).toMatch(/\p{Script=Han}/u)
    expect(await row('weak-en')).toBeUndefined()
  })

  it('returns 409 for duplicate username, including case-insensitive collation', async () => {
    await signup('dupe').expect(201)
    const exact = await signup('dupe', { displayName: 'Other' }).expect(409)
    const folded = await signup('DUPE').expect(409)
    expect(exact.body.code).toBe(Err.DUPLICATE.code)
    expect(folded.body.code).toBe(Err.DUPLICATE.code)
  })

  it('requires a scene and IP-bound ticket in image mode', async () => {
    await setParam('captcha.mode', 'image')
    const denied = await signup('no-ticket').expect(403)
    expect(denied.body.code).toBe(Err.AUTH_CAPTCHA_REQUIRED.code)
    expect(await row('no-ticket')).toBeUndefined()
    const spy = vi.spyOn(tickets, 'verify').mockResolvedValueOnce(true)
    await signup('ticket', { captchaTicket: 'test-ticket' }).expect(201)
    expect(spy).toHaveBeenCalledWith('signup', '127.0.0.1', 'test-ticket')
    await setParam('captcha.mode', 'off')
  })

  it('validates the body before consuming a signup ticket', async () => {
    await setParam('captcha.mode', 'image')
    try {
      const ticket = await tickets.issue('signup', '127.0.0.1')
      const denied = await signup('ticket-retry', {
        password: 'weak',
        captchaTicket: ticket,
      }).expect(400)
      expect(denied.body.code).toBe(Err.VALIDATION_FAILED.code)
      await signup('ticket-retry', { captchaTicket: ticket }).expect(201)
      expect(await row('ticket-retry')).toBeDefined()
    } finally {
      await setParam('captcha.mode', 'off')
    }
  })

  it('observes a settings API password-policy change without restart', async () => {
    const { accessToken } = await signIn(app)
    const [policy] = await ds.query<{ id: number }[]>(
      'SELECT id FROM cfg_param WHERE param_key = ?',
      ['iam.password_min_length'],
    )
    const res = await http()
      .put(`/api/settings/params/${policy!.id}`)
      .set(bearer(accessToken))
      .send({ paramValue: '20' })
    expect(res.status).toBe(200)
    const denied = await signup('new-policy').expect(400)
    expect(denied.body.code).toBe(Err.VALIDATION_FAILED.code)
    expect(await row('new-policy')).toBeUndefined()
  })

  it('first password change lifts the /iam/users gate in the same session', async () => {
    await setParam('iam.password_min_length', original.get('iam.password_min_length') ?? '8')
    const roleId = await insertRow(ds.manager, 'iam_role', {
      code: name('browse-role'),
      name: name('browse-role'),
      data_scope: 'own_rows',
    })
    const [menu] = await ds.query<{ id: number }[]>('SELECT id FROM iam_menu WHERE perms = ?', [
      userPerms.browse,
    ])
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
      roleId,
      menu!.id,
    ])
    const id = await insertRow(ds.manager, 'iam_user', {
      username: name('fresh'),
      display_name: 'Fresh',
      password_hash: await bcrypt.hash(PASSWORD, 4),
      password_changed_at: null,
    })
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, roleId])
    const login = await http()
      .post('/api/auth/login')
      .send({ username: name('fresh'), password: PASSWORD })
      .expect(200)
    const auth = bearer(login.body.data.accessToken)
    const blocked = await http().get('/api/iam/users').set(auth).expect(403)
    expect(blocked.body.code).toBe(Err.AUTH_PASSWORD_CHANGE_REQUIRED.code)
    await http()
      .put('/api/iam/profile/password')
      .set(auth)
      .send({ oldPassword: PASSWORD, newPassword: 'Changed#Pass2026' })
      .expect(200)
    await http().get('/api/iam/users').set(auth).expect(200)
  })
})

describe('sms', () => {
  const mobiles = {
    login: '13800991001',
    disabled: '13800991002',
    fresh: '13800991003',
    reset: '13800991004',
    other: '13800991005',
    unknown: '13800991006',
  } as const
  type Who = keyof typeof mobiles
  let otp: OtpService
  let channelId: number
  let roleId: number
  const templateChannels: Array<{ id: number; channel_id: number | null }> = []
  const users = new Map<Who, number>()
  const code = async (who: Who, scene: 'signin' | 'reset_password') => {
    const mobile = mobiles[who]
    await redis.unlink(redisKey('smsLimit', 'cooldown', mobile))
    await otp.issue({ mobile, scene }, '127.0.0.1')
    await app.get(NotifyDispatcher).idle()
    const [row] = await ds.query<Array<{ code: string }>>(
      'SELECT code FROM msg_sms_otp WHERE mobile = ? AND scene = ? ORDER BY id DESC LIMIT 1',
      [mobile, scene],
    )
    if (!row) throw new Error('SMS OTP was not issued')
    return row!.code
  }
  const smsLogin = (who: Who, value: string, extra: object = {}) =>
    http()
      .post('/api/auth/sms/login')
      .send({ mobile: mobiles[who], code: value, ...extra })
  const resetSms = (who: Who, value: string, newPassword: string) =>
    http()
      .post('/api/auth/password/reset-by-sms')
      .send({ mobile: mobiles[who], code: value, newPassword })
  const badCode = async (res: Awaited<ReturnType<ReturnType<typeof http>['post']>>) => {
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(Err.AUTH_SMS_CODE_INVALID.code)
    expect(res.body.data).toBeNull()
    return { code: res.body.code, msg: res.body.msg, data: res.body.data }
  }

  beforeAll(async () => {
    otp = app.get(OtpService)
    channelId = await insertRow(ds.manager, 'msg_sms_channel', {
      driver: 'debug',
      name: name('sms-debug'),
      enabled: 1,
    })
    const templates = await ds.query<Array<{ id: number; channel_id: number | null }>>(
      'SELECT id, channel_id FROM msg_sms_template WHERE code = ? AND locale IN (?, ?)',
      ['auth.sms_code', 'en-US', 'zh-CN'],
    )
    if (templates.length !== 2) throw new Error('SMS OTP templates are missing')
    templateChannels.push(...templates)
    await ds.query(
      'UPDATE msg_sms_template SET channel_id = ? WHERE code = ? AND locale IN (?, ?)',
      [channelId, 'auth.sms_code', 'en-US', 'zh-CN'],
    )
    roleId = await insertRow(ds.manager, 'iam_role', {
      code: name('sms-browse-role'),
      name: name('sms-browse-role'),
      data_scope: 'own_rows',
    })
    const [menu] = await ds.query<Array<{ id: number }>>(
      'SELECT id FROM iam_menu WHERE perms = ?',
      [userPerms.browse],
    )
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
      roleId,
      menu!.id,
    ])
    for (const who of ['login', 'disabled', 'fresh', 'reset', 'other'] as const) {
      const id = await insertRow(ds.manager, 'iam_user', {
        username: name(`sms-${who}`),
        display_name: `SMS ${who}`,
        mobile: mobiles[who],
        password_hash: await bcrypt.hash(PASSWORD, 4),
        password_changed_at: who === 'fresh' ? null : new Date(),
      })
      users.set(who, id)
      await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, roleId])
    }
  })

  afterAll(async () => {
    if (!ds) return
    await ds.query('DELETE FROM msg_sms_otp WHERE mobile IN (?)', [Object.values(mobiles)])
    await ds.query('DELETE FROM msg_sms_record WHERE channel_id = ?', [channelId])
    for (const template of templateChannels)
      await ds.query('UPDATE msg_sms_template SET channel_id = ? WHERE id = ?', [
        template.channel_id,
        template.id,
      ])
    await ds.query('DELETE FROM msg_sms_channel WHERE id = ?', [channelId])
    for (const id of users.values())
      await ds.query('DELETE FROM iam_user_roles WHERE user_id = ?', [id])
    for (const id of users.values()) await ds.query('DELETE FROM iam_user WHERE id = ?', [id])
    if (roleId) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
    }
  })

  it('sms login issues tokens, refresh cookie and a sign-in audit row', async () => {
    const value = await code('login', 'signin')
    const res = await smsLogin('login', value, { keepSignedIn: true }).expect(200)
    expect(res.body.data).toEqual({
      accessToken: expect.any(String),
      expiresIn: expect.any(Number),
    })
    expect(res.headers['set-cookie']?.[0]).toMatch(/qw_rt=.*Max-Age=/i)
    const me = await http().get('/api/auth/me').set(bearer(res.body.data.accessToken)).expect(200)
    expect(me.body.data.user.username).toBe(name('sms-login'))
    await vi.waitFor(
      async () => {
        const [audit] = await ds.query<Array<{ kind: string; ok: number; username: string }>>(
          'SELECT kind, ok, username FROM aud_signin_log WHERE user_id = ? ORDER BY id DESC LIMIT 1',
          [users.get('login')],
        )
        expect(audit).toMatchObject({ kind: 'sms', ok: 1, username: name('sms-login') })
      },
      { timeout: 5000 },
    )
    const [user] = await ds.query<Array<{ last_login_at: Date | null }>>(
      'SELECT last_login_at FROM iam_user WHERE id = ?',
      [users.get('login')],
    )
    expect(user?.last_login_at).not.toBeNull()
    await badCode(await smsLogin('login', value))
  })

  it('sms login as the mobile client: refresh token in the body, no cookie, logged as mobile', async () => {
    const value = await code('other', 'signin')
    const res = await smsLogin('other', value, { keepSignedIn: true, clientId: 'mobile' }).expect(
      200,
    )
    expect(res.body.data).toEqual({
      accessToken: expect.any(String),
      expiresIn: expect.any(Number),
      refreshToken: expect.any(String),
      refreshExpiresIn: expect.any(Number),
    })
    expect(res.headers['set-cookie']).toBeUndefined()
    await http().get('/api/auth/me').set(bearer(res.body.data.accessToken)).expect(200)
    await http()
      .post('/api/auth/refresh')
      .send({ refreshToken: res.body.data.refreshToken })
      .expect(200)
    await vi.waitFor(
      async () => {
        const [audit] = await ds.query<Array<{ kind: string; ok: number; client_id: string }>>(
          'SELECT kind, ok, client_id FROM aud_signin_log WHERE user_id = ? ORDER BY id DESC LIMIT 1',
          [users.get('other')],
        )
        expect(audit).toMatchObject({ kind: 'sms', ok: 1, client_id: 'mobile' })
      },
      { timeout: 5000 },
    )
  })

  it('sms wrong code and scene binding reject without creating a session', async () => {
    const signin = await code('login', 'signin')
    const wrong = await smsLogin('login', '999999')
    await badCode(wrong)
    expect(wrong.headers['set-cookie']).toBeUndefined()
    await badCode(await resetSms('login', signin, 'Changed#Pass2026'))
    await smsLogin('login', signin).expect(200)
    const reset = await code('login', 'reset_password')
    await badCode(await smsLogin('login', reset))
  })

  it('sms unknown and disabled accounts answer like a wrong code', async () => {
    const valid = await code('disabled', 'signin')
    const wrong = await badCode(await smsLogin('disabled', '000000'))
    await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [users.get('disabled')])
    const disabled = await badCode(await smsLogin('disabled', valid))
    expect(disabled).toEqual(wrong)
    await ds.query(
      `INSERT INTO msg_sms_otp (mobile, scene, code, attempts, daily_seq, request_ip)
       VALUES (?, 'signin', ?, 0, 1, ?)`,
      [mobiles.unknown, '123456', '127.0.0.1'],
    )
    const unknown = await badCode(await smsLogin('unknown', '123456'))
    expect(unknown).toEqual(wrong)
    expect((await smsLogin('unknown', '123456')).headers['set-cookie']).toBeUndefined()
  })

  it('sms sign-in keeps the first-change password gate', async () => {
    const value = await code('fresh', 'signin')
    const res = await smsLogin('fresh', value).expect(200)
    const auth = bearer(res.body.data.accessToken)
    const me = await http().get('/api/auth/me').set(auth).expect(200)
    expect(me.body.data.flags.mustChangePassword).toBe(true)
    const denied = await http().get('/api/iam/users').set(auth).expect(403)
    expect(denied.body.code).toBe(Err.AUTH_PASSWORD_CHANGE_REQUIRED.code)
  })

  it('sms reset validates before consuming, changes password and revokes only its user', async () => {
    const old = await http()
      .post('/api/auth/login')
      .send({ username: name('sms-reset'), password: PASSWORD })
      .expect(200)
    const other = await http()
      .post('/api/auth/login')
      .send({ username: name('sms-other'), password: PASSWORD })
      .expect(200)
    const oldAuth = bearer(old.body.data.accessToken)
    const otherAuth = bearer(other.body.data.accessToken)
    const unusedSignin = await code('reset', 'signin')
    const reset = await code('reset', 'reset_password')
    const [before] = await ds.query<Array<{ password_hash: string }>>(
      'SELECT password_hash FROM iam_user WHERE id = ?',
      [users.get('reset')],
    )
    const weak = await resetSms('reset', reset, 'weak').expect(400)
    expect(weak.body.code).toBe(Err.VALIDATION_FAILED.code)
    await badCode(await resetSms('reset', '999999', 'Reset#Pass2026'))
    const [still] = await ds.query<Array<{ password_hash: string }>>(
      'SELECT password_hash FROM iam_user WHERE id = ?',
      [users.get('reset')],
    )
    expect(still?.password_hash).toBe(before?.password_hash)
    const done = await resetSms('reset', reset, 'Reset#Pass2026').expect(200)
    expect(done.body.data).toBeNull()
    const [changed] = await ds.query<
      Array<{ password_hash: string; password_changed_at: Date | null }>
    >('SELECT password_hash, password_changed_at FROM iam_user WHERE id = ?', [users.get('reset')])
    expect(changed?.password_changed_at).not.toBeNull()
    expect(changed?.password_hash).not.toBe(before?.password_hash)
    await http()
      .post('/api/auth/login')
      .send({ username: name('sms-reset'), password: PASSWORD })
      .expect(401)
    await http()
      .post('/api/auth/login')
      .send({ username: name('sms-reset'), password: 'Reset#Pass2026' })
      .expect(200)
    await http().get('/api/auth/me').set(oldAuth).expect(401)
    const origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`
    const refreshed = await http()
      .post('/api/auth/refresh')
      .set('Origin', origin)
      .set('Cookie', old.headers['set-cookie'][0].split(';')[0])
      .expect(401)
    expect(refreshed.body.code).toBe(Err.AUTH_REFRESH_REJECTED.code)
    await http().get('/api/auth/me').set(otherAuth).expect(200)
    const [otpRow] = await ds.query<Array<{ consumed_at: Date | null }>>(
      'SELECT consumed_at FROM msg_sms_otp WHERE mobile = ? AND scene = ? AND code = ? ORDER BY id DESC LIMIT 1',
      [mobiles.reset, 'signin', unusedSignin],
    )
    expect(otpRow?.consumed_at).not.toBeNull()
    await badCode(await smsLogin('reset', unusedSignin))
  })

  it('sms sign-in clears the current-password counter: a locked-out user unlocks the screen again', async () => {
    const { lockThreshold } = (await app.get(AuthParams).load()).security
    const verify = (access: string, password: string) =>
      http().post('/api/auth/verify-password').set(bearer(access)).send({ password })
    const signedIn = async () =>
      (await smsLogin('login', await code('login', 'signin')).expect(200)).body.data
        .accessToken as string
    const first = await signedIn()
    for (let i = 1; i < lockThreshold; i++) await verify(first, 'Wrong#pass1').expect(400)
    const locked = await verify(first, 'Wrong#pass1').expect(401)
    expect(locked.body.code).toBe(Err.AUTH_SESSION_EXPIRED.code)
    await http().get('/api/auth/me').set(bearer(first)).expect(401)
    const again = await signedIn()
    await verify(again, PASSWORD).expect(200)
    await http().get('/api/auth/me').set(bearer(again)).expect(200)
    expect(await redis.exists(redisKey('authFail', 'cur', users.get('login')!))).toBe(0)
  })
})
