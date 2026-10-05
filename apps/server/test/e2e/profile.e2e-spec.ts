// iam/profile, the personal center (`/profile`, acceptance; see docs/design-notes.md#layering, #storage): own profile with the
// read-only dept/role/position names; changing mobile needs reauthentication and a bound SMS code;
// language persisted and followed by the session; avatar → 256×256 public WebP (the
// previous one removed); the password change ends the other sessions; no permission needed, 401
// without a session; action log; Swagger.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import sharp from 'sharp'
import request from 'supertest'
import { AuthParams } from '../../src/core/auth/auth-params.js'
import { NotifyDispatcher } from '../../src/core/notify/notify.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { uploadRoot } from '../../src/core/paths.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'profile-e2e-'
const URL = '/api/iam/profile'
const PW = 'Profile#Pass1'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const users: Record<string, { id: number; token: string }> = {}
const roleIds: number[] = []

const http = () => request(app.getHttpServer())
const as = (who: string) => bearer(users[who]!.token)
const get = (who: string) => http().get(URL).set(as(who))
const put = (who: string, body: object, path = '', ip?: string) =>
  http()
    .put(`${URL}${path}`)
    .set(as(who))
    .set('Accept-Language', 'en-US')
    .set('X-Forwarded-For', ip ?? '198.18.0.1')
    .send(body)
const avatar = (who: string, file: Buffer, name = 'me.png') =>
  http().post(`${URL}/avatar`).set(as(who)).attach('file', file, name)
/** Binary body as a Buffer whatever the content type. */
const binary = (req: request.Test) =>
  req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = []
    res.on('data', (c: Buffer) => chunks.push(c))
    res.on('end', () => cb(null, Buffer.concat(chunks)))
  })
const image = (width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer()

/** A signed-in user without any permission: the personal center needs none. */
async function user(name: string, row: Record<string, unknown> = {}) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: await bcrypt.hash(PW, 4),
    password_changed_at: new Date(),
    ...row,
  })
  users[name] = { id, token: (await signIn(app, PREFIX + name)).accessToken }
  return id
}

async function role(code: string, enabled: number) {
  const id = await insertRow(ds.manager, 'iam_role', {
    code: PREFIX + code,
    name: `${PREFIX}${code}-name`,
    data_scope: 'own_rows',
    enabled,
  })
  roleIds.push(id)
  return id
}

const objectsOf = (userId: number) =>
  ds.query<{ id: number; object_key: string; public_url: string; is_public: number }[]>(
    "SELECT id, object_key, public_url, is_public FROM fs_object WHERE uploader_id = ? AND biz_tag = 'avatar' AND deleted_at IS NULL ORDER BY id",
    [userId],
  )

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  const platform = await findId(ds.manager, 'iam_dept', { name: 'seed.dept.platform' })
  const [on, off] = [await role('on', 1), await role('off', 0)]
  const ann = await user('ann', {
    dept_id: platform,
    mobile: '13900000001',
    email: 'ann@profile.test',
    gender: 'female',
  })
  for (const r of [on, off])
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [ann, r])
  const positions = await ds.query<{ id: number }[]>(
    'SELECT id FROM iam_position ORDER BY sort_no, id LIMIT 2',
  )
  for (const p of positions)
    await ds.query('INSERT INTO iam_user_positions (user_id, position_id) VALUES (?, ?)', [
      ann,
      p.id,
    ])
  await user('bob', { mobile: '13900000002', email: 'bob@profile.test' })
})

afterAll(async () => {
  if (ds) {
    const ids = Object.values(users).map((u) => u.id)
    if (ids.length) {
      await ds.query('DELETE FROM msg_sms_otp WHERE user_id IN (?) OR mobile IN (?)', [
        ids,
        [
          '13877700001',
          '13877700002',
          '13877700003',
          '13877700004',
          '13877700005',
          '13877700006',
          '13877700007',
          '13877700008',
          '13877700009',
          '13877700010',
          '13877700011',
          '13877700028',
          '13877700029',
        ],
      ])
      const objects = await ds.query<{ object_key: string; is_public: number }[]>(
        'SELECT object_key, is_public FROM fs_object WHERE uploader_id IN (?)',
        [ids],
      )
      for (const o of objects)
        await rm(join(uploadRoot(), o.is_public ? 'public' : 'private', o.object_key), {
          force: true,
        })
      await ds.query('DELETE FROM fs_object WHERE uploader_id IN (?)', [ids])
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [ids])
      await ds.query('DELETE FROM iam_user_positions WHERE user_id IN (?)', [ids])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [ids])
    }
    if (roleIds.length) await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roleIds])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('profile', () => {
  it('GET: own row unmasked with dept, enabled role and position names; no permission needed', async () => {
    const positions = await ds.query<{ name: string }[]>(
      'SELECT name FROM iam_position ORDER BY sort_no, id LIMIT 2',
    )
    const res = await get('ann').expect(200)
    expect(res.body.data).toEqual({
      id: users.ann!.id,
      username: `${PREFIX}ann`,
      displayName: 'ann',
      gender: 'female',
      mobile: '13900000001',
      email: 'ann@profile.test',
      avatarUrl: null,
      locale: null,
      deptName: 'seed.dept.platform',
      roleNames: [`${PREFIX}on-name`],
      positionNames: positions.map((p) => p.name),
    })
    expect((await get('bob').expect(200)).body.data).toMatchObject({
      username: `${PREFIX}bob`,
      deptName: null,
      roleNames: [],
      positionNames: [],
    })
  })

  it('401 without a session, on every route', async () => {
    await http().get(URL).expect(401)
    await http().put(URL).send({ displayName: 'x' }).expect(401)
    await http().post(`${URL}/mobile/code`).send({ mobile: '13877700003' }).expect(401)
    await http().put(`${URL}/locale`).send({ locale: 'en-US' }).expect(401)
    await http().post(`${URL}/avatar`).expect(401)
  })

  it('PUT: sent fields change, blank contacts become null, updated_by = self, action log', async () => {
    const res = await put('bob', {
      displayName: ' Bob B ',
      gender: 'male',
      mobile: '',
      currentPassword: PW,
      email: 'bob.b@profile.test',
    }).expect(200)
    expect(res.body.data).toMatchObject({
      displayName: 'Bob B',
      gender: 'male',
      mobile: null,
      email: 'bob.b@profile.test',
    })
    const [row] = await ds.query(
      'SELECT display_name, mobile, updated_by FROM iam_user WHERE id = ?',
      [users.bob!.id],
    )
    expect(row).toEqual({ display_name: 'Bob B', mobile: null, updated_by: users.bob!.id })
    // a partial body leaves the rest alone
    await put('bob', { displayName: 'Bob' }).expect(200)
    expect((await get('bob')).body.data).toMatchObject({
      displayName: 'Bob',
      email: 'bob.b@profile.test',
    })
    const log = await logOf(ds, res.headers['x-request-id'])
    expect(log).toMatchObject({
      domain: 'iam.profile',
      verb: 'modify',
      user_id: users.bob!.id,
      ok: 1,
    })
  })

  it("PUT: another user's email → 409 duplicate; keeping one's own mobile is fine", async () => {
    const dupEmail = await put('bob', { email: 'ann@profile.test' }).expect(409)
    expect(dupEmail.body.code).toBe(Err.DUPLICATE.code)
    await put('ann', { mobile: '13900000001', email: 'ann@profile.test' }).expect(200)
  })

  it('PUT: only profile fields; other columns in the body are ignored; invalid → 400 translated', async () => {
    await put('bob', {
      username: 'admin2',
      deptId: 1,
      enabled: false,
      avatarUrl: 'https://evil.example/x.png',
      roleIds: [1],
    }).expect(200)
    const [row] = await ds.query(
      'SELECT username, dept_id, enabled, avatar_url FROM iam_user WHERE id = ?',
      [users.bob!.id],
    )
    expect(row).toEqual({
      username: `${PREFIX}bob`,
      dept_id: null,
      enabled: 1,
      avatar_url: null,
    })
    expect(
      await ds.query('SELECT role_id FROM iam_user_roles WHERE user_id = ?', [users.bob!.id]),
    ).toEqual([])
    const bad = await put('bob', { email: 'not-an-email', displayName: '' }).expect(400)
    expect(bad.body.code).toBe(Err.VALIDATION_FAILED.code)
    expect(bad.body.errors.map((e: { path: string }) => e.path).sort()).toEqual([
      'displayName',
      'email',
    ])
  })
})

describe('mobile', () => {
  let channelId: number
  let templates: Array<{ id: number; locale: string; channel_id: number | null }>
  const code = (who: string, mobile: string, ip?: string) => {
    const req = http().post(`${URL}/mobile/code`).set(as(who)).send({ mobile })
    return ip ? req.set('X-Forwarded-For', ip) : req
  }
  const otp = async (mobile: string, scene = 'bind_mobile') =>
    ds.query<Array<{ code: string; user_id: number; consumed_at: Date | null }>>(
      'SELECT code, user_id, consumed_at FROM msg_sms_otp WHERE mobile = ? AND scene = ? ORDER BY id DESC',
      [mobile, scene],
    )
  const idle = () => app.get(NotifyDispatcher).idle()
  const clearUserCooldown = (who: string) =>
    redis.unlink(redisKey('smsLimit', 'user', 'cooldown', users[who]!.id))

  beforeAll(async () => {
    await user('mobileA', { mobile: '13877700001' })
    await user('mobileB', { mobile: '13877700002' })
    channelId = await insertRow(ds.manager, 'msg_sms_channel', {
      driver: 'debug',
      name: `${PREFIX}sms-debug`,
      enabled: 1,
    })
    templates = await ds.query(
      'SELECT id, locale, channel_id FROM msg_sms_template WHERE code = ?',
      ['auth.sms_code'],
    )
    if (templates.length !== 2) throw new Error('SMS OTP templates are missing')
    await ds.query('UPDATE msg_sms_template SET channel_id = ? WHERE code = ?', [
      channelId,
      'auth.sms_code',
    ])
  })

  afterAll(async () => {
    await idle()
    await ds.query('DELETE FROM msg_sms_record WHERE channel_id = ?', [channelId])
    for (const t of templates)
      await ds.query('UPDATE msg_sms_template SET channel_id = ? WHERE id = ?', [
        t.channel_id,
        t.id,
      ])
    await ds.query('DELETE FROM msg_sms_channel WHERE id = ?', [channelId])
  })

  it('bind cooldown stays separate from public signin and reset codes', async () => {
    const number = '13877700028'
    await user('bindVictim', { mobile: number })
    await user('bindAttackerA')
    await user('bindAttackerB')
    await code('bindAttackerA', number, '198.51.100.181').expect(200)
    const blocked = await code('bindAttackerB', number, '198.51.100.182').expect(429)
    expect(blocked.body.code).toBe(Err.SMS_TOO_FREQUENT.code)
    for (const scene of ['signin', 'reset_password']) {
      await http().post('/api/auth/sms/code').send({ mobile: number, scene }).expect(200)
      await redis.unlink(redisKey('smsLimit', 'cooldown', number))
    }
    expect(await redis.exists(redisKey('smsLimit', 'bind', 'cooldown', number))).toBe(1)
    await idle()
  })

  it('bind daily cap stays separate from public signin and reset codes', async () => {
    const number = '13877700029'
    await user('bindVictimCap', { mobile: number })
    for (const who of ['bindCap1', 'bindCap2', 'bindCap3']) await user(who)
    const params = app.get(ParamService)
    const key = 'sms.otp.mobile_daily_max'
    const original = await params.get(key)
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', ['2', key])
    await params.invalidate(key)
    try {
      for (const who of ['bindCap1', 'bindCap2']) {
        await code(who, number, '198.51.100.183').expect(200)
        await redis.unlink(redisKey('smsLimit', 'bind', 'cooldown', number))
        await redis.unlink(redisKey('smsLimit', 'cooldown', number))
      }
      const refused = await code('bindCap3', number, '198.51.100.184').expect(429)
      expect(refused.body.code).toBe(Err.SMS_TOO_FREQUENT.code)
      for (const scene of ['signin', 'reset_password']) {
        await http().post('/api/auth/sms/code').send({ mobile: number, scene }).expect(200)
        await redis.unlink(redisKey('smsLimit', 'cooldown', number))
      }
      expect(
        await redis.get(
          redisKey('smsLimit', 'bind', new Date().toISOString().slice(0, 10), number),
        ),
      ).toBe('2')
    } finally {
      await idle()
      await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [original, key])
      await params.invalidate(key)
    }
  })

  it('requires the current password before any write, then a valid own bind code', async () => {
    const number = '13877700003'
    const missing = await put('mobileA', { mobile: number, displayName: 'Changed' }).expect(400)
    expect(missing.body.errors[0].path).toBe('currentPassword')
    expect((await get('mobileA')).body.data).toMatchObject({
      mobile: '13877700001',
      displayName: 'mobileA',
    })
    expect(
      (await put('mobileA', { mobile: number, currentPassword: 'wrong' }).expect(400)).body.code,
    ).toBe(Err.AUTH_OLD_PASSWORD_WRONG.code)
    expect(
      (await put('mobileA', { mobile: number, currentPassword: PW }).expect(400)).body.code,
    ).toBe(Err.AUTH_SMS_CODE_INVALID.code)
    expect(
      (
        await put('mobileA', { mobile: number, currentPassword: PW, mobileCode: '999999' }).expect(
          400,
        )
      ).body.code,
    ).toBe(Err.AUTH_SMS_CODE_INVALID.code)
    expect((await get('mobileA')).body.data.mobile).toBe('13877700001')
  })

  it('bind codes are user-bound and scene-bound', async () => {
    const number = '13877700004'
    await code('mobileB', number).expect(200)
    await idle()
    const [issued] = await otp(number)
    expect(issued.user_id).toBe(users.mobileB!.id)
    expect(
      (
        await put('mobileA', {
          mobile: number,
          currentPassword: PW,
          mobileCode: issued.code,
        }).expect(400)
      ).body.code,
    ).toBe(Err.AUTH_SMS_CODE_INVALID.code)
    await ds.query(
      "INSERT INTO msg_sms_otp (mobile, scene, code, attempts, daily_seq, request_ip) VALUES (?, 'signin', '123456', 0, 1, '127.0.0.1')",
      ['13877700005'],
    )
    expect(
      (
        await put('mobileA', {
          mobile: '13877700005',
          currentPassword: PW,
          mobileCode: '123456',
        }).expect(400)
      ).body.code,
    ).toBe(Err.AUTH_SMS_CODE_INVALID.code)
  })

  it('another user cannot void a pending bind code for the same number', async () => {
    const number = '13877700026'
    await user('bindIsolationA')
    await user('bindIsolationB')
    await code('bindIsolationA', number, '198.51.100.171').expect(200)
    await idle()
    const [a] = await otp(number)
    expect(a.user_id).toBe(users.bindIsolationA!.id)

    await redis.unlink(redisKey('smsLimit', 'bind', 'cooldown', number))
    await clearUserCooldown('bindIsolationB')
    await code('bindIsolationB', number, '198.51.100.172').expect(200)
    await idle()
    const [b, stillA] = await otp(number)
    expect(b.user_id).toBe(users.bindIsolationB!.id)
    expect(stillA).toMatchObject({ user_id: users.bindIsolationA!.id, consumed_at: null })

    const changed = await put('bindIsolationA', {
      mobile: number,
      currentPassword: PW,
      mobileCode: a.code,
    })
      .set('X-Forwarded-For', '198.51.100.171')
      .expect(200)
    expect(changed.body.data.mobile).toBe(number)
    expect((await otp(number))[0].consumed_at).not.toBeNull()
    expect(
      (
        await put('bindIsolationB', {
          mobile: number,
          currentPassword: PW,
          mobileCode: b.code,
        })
          .set('X-Forwarded-For', '198.51.100.172')
          .expect(400)
      ).body.code,
    ).toBe(Err.AUTH_SMS_CODE_INVALID.code)
  })

  it("a second bind request voids only the same user's older code", async () => {
    const number = '13877700027'
    await user('bindRenew')
    await code('bindRenew', number, '198.51.100.173').expect(200)
    await idle()
    const [older] = await otp(number)

    await redis.unlink(redisKey('smsLimit', 'bind', 'cooldown', number))
    await clearUserCooldown('bindRenew')
    await code('bindRenew', number, '198.51.100.173').expect(200)
    await idle()
    const [newer, voided] = await otp(number)
    expect(voided.consumed_at).not.toBeNull()
    expect(newer.consumed_at).toBeNull()
    expect(
      (
        await put('bindRenew', {
          mobile: number,
          currentPassword: PW,
          mobileCode: older.code,
        })
          .set('X-Forwarded-For', '198.51.100.173')
          .expect(400)
      ).body.code,
    ).toBe(Err.AUTH_SMS_CODE_INVALID.code)
    expect(
      (
        await put('bindRenew', {
          mobile: number,
          currentPassword: PW,
          mobileCode: newer.code,
        })
          .set('X-Forwarded-For', '198.51.100.173')
          .expect(200)
      ).body.data.mobile,
    ).toBe(number)
  })

  it('successful bind consumes the code, ends other sessions, voids old codes and keeps this one', async () => {
    const old = '13877700001'
    const number = '13877700006'
    const other = (await signIn(app, `${PREFIX}mobileA`)).accessToken
    await ds.query(
      "INSERT INTO msg_sms_otp (mobile, scene, code, attempts, daily_seq, request_ip) VALUES (?, 'signin', '555555', 0, 1, '127.0.0.1')",
      [old],
    )
    await code('mobileA', '13877700007').expect(200)
    await idle()
    expect((await otp('13877700007'))[0].consumed_at).toBeNull()
    await clearUserCooldown('mobileA')
    await code('mobileA', number).expect(200)
    await idle()
    const [issued] = await otp(number)
    const res = await put('mobileA', {
      mobile: number,
      currentPassword: PW,
      mobileCode: issued.code,
    }).expect(200)
    expect(res.body.data.mobile).toBe(number)
    expect((await otp(number))[0].consumed_at).not.toBeNull()
    expect((await otp('13877700007'))[0].consumed_at).not.toBeNull()
    expect((await otp(old, 'signin'))[0].consumed_at).not.toBeNull()
    await http().get(URL).set(bearer(other)).expect(401)
    await get('mobileA').expect(200)
    expect(
      (
        await put('mobileA', {
          mobile: '13877700007',
          currentPassword: PW,
          mobileCode: issued.code,
        }).expect(400)
      ).body.code,
    ).toBe(Err.AUTH_SMS_CODE_INVALID.code)
    const log = await logOf(ds, res.headers['x-request-id'])
    expect(log?.params).not.toContain(issued.code)
  })

  it('code endpoint does not enumerate registered numbers and applies cooldown', async () => {
    const held = '13877700002'
    const free = '13877700008'
    await clearUserCooldown('mobileA')
    const before = (
      await ds.query<Array<{ n: number }>>(
        'SELECT COUNT(*) AS n FROM msg_sms_record WHERE mobile = ?',
        [held],
      )
    )[0].n
    const a = await code('mobileA', held).expect(200)
    await clearUserCooldown('mobileA')
    const b = await code('mobileA', free).expect(200)
    expect(a.body).toEqual(b.body)
    await idle()
    expect(await otp(held)).toEqual([])
    expect(
      (
        await ds.query<Array<{ n: number }>>(
          'SELECT COUNT(*) AS n FROM msg_sms_record WHERE mobile = ?',
          [held],
        )
      )[0].n,
    ).toBe(before)
    await code('mobileA', free).expect(429)
    expect(
      (
        await put('mobileA', { mobile: held, currentPassword: PW, mobileCode: '123456' }).expect(
          400,
        )
      ).body.code,
    ).toBe(Err.AUTH_SMS_CODE_INVALID.code)
  })

  it('limits bind-code requests across numbers per user without charging rejected requests', async () => {
    const owner = 'bindCapA'
    const other = 'bindCapB'
    await user(owner)
    await user(other)
    const params = app.get(ParamService)
    const key = 'sms.otp.user_daily_max'
    const original = await params.get(key)
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', ['2', key])
    await params.invalidate(key)
    try {
      await code(owner, '13877700020', '198.51.100.151').expect(200)
      await clearUserCooldown(owner)
      await code(owner, '13877700021', '198.51.100.152').expect(200)
      await clearUserCooldown(owner)
      const refused = await code(owner, '13877700022', '198.51.100.153').expect(429)
      expect(refused.body.code).toBe(Err.SMS_TOO_FREQUENT.code)
      expect(await redis.exists(redisKey('smsLimit', 'bind', 'cooldown', '13877700022'))).toBe(0)
      expect(
        await redis.get(
          redisKey('smsLimit', 'user', new Date().toISOString().slice(0, 10), users[owner]!.id),
        ),
      ).toBe('2')
      expect(
        await redis.exists(
          redisKey('smsLimit', 'ip', new Date().toISOString().slice(0, 10), '198.51.100.153'),
        ),
      ).toBe(0)
      await code(other, '13877700023', '198.51.100.154').expect(200)
    } finally {
      await idle()
      await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [original, key])
      await params.invalidate(key)
    }
  })

  it('applies a user cooldown across different bind numbers', async () => {
    const owner = 'bindCooldown'
    await user(owner)
    await code(owner, '13877700024', '198.51.100.155').expect(200)
    const refused = await code(owner, '13877700025', '198.51.100.156').expect(429)
    expect(refused.body.code).toBe(Err.SMS_TOO_FREQUENT.code)
    expect(await redis.exists(redisKey('smsLimit', 'bind', 'cooldown', '13877700025'))).toBe(0)
    await idle()
  })

  it('uses the zh-CN sender for en-US requests when only zh-CN has a channel', async () => {
    const number = '13877700009'
    const zh = templates.find((t) => t.locale === 'zh-CN')!
    const en = templates.find((t) => t.locale === 'en-US')!
    await ds.query('UPDATE msg_sms_template SET channel_id = NULL WHERE id = ?', [en.id])
    try {
      expect(
        (await put('mobileB', { mobile: number, currentPassword: PW }, '?lang=en-US').expect(400))
          .body.code,
      ).toBe(Err.AUTH_SMS_CODE_INVALID.code)
      expect(
        (
          await put('mobileB', {
            mobile: number,
            currentPassword: PW,
            mobileCode: '000000',
          }).expect(400)
        ).body.code,
      ).toBe(Err.AUTH_SMS_CODE_INVALID.code)
      await clearUserCooldown('mobileB')
      await http()
        .post(`${URL}/mobile/code?lang=en-US`)
        .set(as('mobileB'))
        .send({ mobile: number })
        .expect(200)
      await idle()
      const [issued] = await otp(number)
      expect(issued.user_id).toBe(users.mobileB!.id)
      const [record] = await ds.query<
        Array<{ channel_id: number; params: { templateId: number } }>
      >(
        "SELECT channel_id, params FROM msg_sms_record WHERE mobile = ? AND template_code = 'auth.sms_code' ORDER BY id DESC",
        [number],
      )
      expect(record?.channel_id).toBe(channelId)
      expect(record?.params.templateId).toBe(zh.id)
      expect(
        (
          await put(
            'mobileB',
            { mobile: number, currentPassword: PW, mobileCode: issued.code },
            '?lang=en-US',
          ).expect(200)
        ).body.data.mobile,
      ).toBe(number)
    } finally {
      await ds.query('UPDATE msg_sms_template SET channel_id = ? WHERE id = ?', [channelId, en.id])
    }
  })

  it('reports a taken number only after the correct password and own bind code', async () => {
    const number = '13877700010'
    await clearUserCooldown('mobileA')
    await code('mobileA', number).expect(200)
    await idle()
    const [issued] = await otp(number)
    expect(issued.user_id).toBe(users.mobileA!.id)
    await ds.query('UPDATE iam_user SET mobile = ? WHERE id = ?', [number, users.mobileB!.id])
    const wrongCode = issued.code === '000000' ? '000001' : '000000'
    expect(
      (
        await put('mobileA', { mobile: number, currentPassword: PW, mobileCode: wrongCode }).expect(
          400,
        )
      ).body.code,
    ).toBe(Err.AUTH_SMS_CODE_INVALID.code)
    expect(
      (
        await put('mobileA', {
          mobile: number,
          currentPassword: 'wrong',
          mobileCode: issued.code,
        }).expect(400)
      ).body.code,
    ).toBe(Err.AUTH_OLD_PASSWORD_WRONG.code)
    expect(
      (
        await put('mobileA', {
          mobile: number,
          currentPassword: PW,
          mobileCode: issued.code,
        }).expect(409)
      ).body.code,
    ).toBe(Err.DUPLICATE.code)
    expect((await get('mobileA')).body.data.mobile).toBe('13877700006')
  })

  it('refuses a new mobile when SMS is unavailable, even if taken; clearing still needs only the password', async () => {
    await ds.query("UPDATE msg_sms_template SET enabled = 0 WHERE code = 'auth.sms_code'")
    try {
      for (const currentPassword of [undefined, 'wrong']) {
        const res = await put('mobileA', { mobile: '13877700011', currentPassword }).expect(422)
        expect(res.body.code).toBe(Err.IAM_MOBILE_CHANGE_UNAVAILABLE.code)
      }
      for (const mobile of ['13877700011', '13877700010']) {
        const res = await put('mobileA', { mobile, currentPassword: PW }).expect(422)
        expect(res.body.code).toBe(Err.IAM_MOBILE_CHANGE_UNAVAILABLE.code)
        expect(res.body.msg).toBe(
          'SMS codes are not set up, so the mobile number cannot be changed here; ask an administrator to change it',
        )
        expect((await get('mobileA')).body.data.mobile).toBe('13877700006')
      }
      const cleared = await put('mobileA', { mobile: null, currentPassword: PW }).expect(200)
      expect(cleared.body.data.mobile).toBeNull()
      const blank = await put('mobileB', { mobile: '', currentPassword: PW }).expect(200)
      expect(blank.body.data.mobile).toBeNull()
    } finally {
      await ds.query("UPDATE msg_sms_template SET enabled = 1 WHERE code = 'auth.sms_code'")
    }
  })
})

describe('locale', () => {
  it('PUT /locale persists it; the session follows (messages without Accept-Language)', async () => {
    await put('ann', { locale: 'en-US' }, '/locale').expect(200)
    expect((await get('ann')).body.data.locale).toBe('en-US')
    const bad = () => http().put(URL).set(as('ann')).send({ email: 'x' }).expect(400)
    expect((await bad()).body.msg).toBe('Email must be a valid email address')
    await put('ann', { locale: 'zh-CN' }, '/locale').expect(200)
    expect((await get('ann')).body.data.locale).toBe('zh-CN')
    expect((await bad()).body.msg).toMatch(/[\u4e00-\u9fff]/)
    const unknown = await put('ann', { locale: 'fr-FR' }, '/locale').expect(400)
    expect(unknown.body.errors[0].path).toBe('locale')
  })
})

describe('avatar', () => {
  it('png → 201 256×256 webp at /files without a token; avatar_url set; a new one removes the old', async () => {
    const first = await avatar('ann', await image(600, 400, '#1f6feb')).expect(201)
    const url: string = first.body.data.avatarUrl
    expect(url).toMatch(/^\/files\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.webp$/)
    const file = await binary(http().get(url)).expect(200)
    expect(file.headers['content-type']).toBe('image/webp')
    expect(await sharp(file.body).metadata()).toMatchObject({
      format: 'webp',
      width: 256,
      height: 256,
    })
    expect((await get('ann')).body.data.avatarUrl).toBe(url)
    expect(
      (await http().get('/api/auth/me').set(as('ann')).expect(200)).body.data.user.avatarUrl,
    ).toBe(url)
    expect(await objectsOf(users.ann!.id)).toMatchObject([{ public_url: url, is_public: 1 }])
    const log = await logOf(ds, first.headers['x-request-id'])
    expect(log).toMatchObject({ domain: 'iam.profile', verb: 'change-avatar', ok: 1 })

    const second = await avatar('ann', await image(300, 300, '#0b1a33'), 'other.jpg').expect(201)
    const next: string = second.body.data.avatarUrl
    expect(next).not.toBe(url)
    expect(await objectsOf(users.ann!.id)).toMatchObject([{ public_url: next }])
    // the old object is deleted (soft): its URL stops answering at once (body kept in private/ until the purge)
    await http().get(url).expect(404)
    await http().get(next).expect(200)
  })

  it('a small valid png over 25 MP → 422 (never decoded); the avatar and its objects stay', async () => {
    await user('dora')
    const kept: string = (await avatar('dora', await image(64, 64, '#1f6feb')).expect(201)).body
      .data.avatarUrl
    const objects = await objectsOf(users.dora!.id)
    // 5001 × 5001 = 25 010 001 px: a few KB as a one-colour palette png, decodable without the limit
    const huge = await sharp({
      create: { width: 5001, height: 5001, channels: 3, background: '#ffffff' },
    })
      .png({ palette: true })
      .toBuffer()
    expect(huge.length).toBeLessThan(256 * 1024)
    const res = await avatar('dora', huge).expect(422)
    expect(res.body.code).toBe(Err.STORAGE_PUBLIC_IMAGE_ONLY.code)
    expect((await get('dora')).body.data.avatarUrl).toBe(kept)
    expect(await objectsOf(users.dora!.id)).toEqual(objects)
    await http().get(kept).expect(200)
  })

  it('anything but a png/jpeg/gif/webp image → 422, nothing stored; no file → 400', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    )
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
    const tiff = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#ffffff' },
    })
      .tiff()
      .toBuffer()
    // a png signature on garbage: sniffed as png, the decoder refuses it
    const broken = Buffer.concat([(await image(8, 8, '#000000')).subarray(0, 40), Buffer.alloc(64)])
    for (const [file, name] of [
      [svg, 'a.svg'],
      [pdf, 'a.png'],
      [tiff, 'a.tif'],
      [broken, 'a.png'],
    ] as const) {
      const res = await avatar('bob', file, name).expect(422)
      expect(res.body.code).toBe(Err.STORAGE_PUBLIC_IMAGE_ONLY.code)
    }
    const none = await http().post(`${URL}/avatar`).set(as('bob')).field('x', '1').expect(400)
    expect(none.body.code).toBe(Err.STORAGE_FILE_REQUIRED.code)
    expect(await objectsOf(users.bob!.id)).toEqual([])
    expect((await get('bob')).body.data.avatarUrl).toBeNull()
  })
})

describe('password', () => {
  it('PUT /password: the other sessions end, this one goes on', async () => {
    const id = await user('carl')
    const other = (await signIn(app, `${PREFIX}carl`)).accessToken
    await put('carl', { oldPassword: PW, newPassword: 'Changed#Pass2' }, '/password').expect(200)
    await http().get(URL).set(bearer(other)).expect(401)
    await get('carl').expect(200)
    const [row] = await ds.query('SELECT password_hash FROM iam_user WHERE id = ?', [id])
    expect(await bcrypt.compare('Changed#Pass2', row.password_hash)).toBe(true)
  })

  it('wrong currentPassword on profile locks every session on the threshold failure', async () => {
    const id = await user('profileLock', { mobile: '13900000003' })
    const other = (await signIn(app, `${PREFIX}profileLock`)).accessToken
    const threshold = (await app.get(AuthParams).load()).security.lockThreshold
    for (let i = 1; i < threshold; i++) {
      const res = await put(
        'profileLock',
        { mobile: null, currentPassword: 'wrong' },
        '',
        `198.18.1.${i}`,
      ).expect(400)
      expect(res.body.code).toBe(Err.AUTH_OLD_PASSWORD_WRONG.code)
    }
    const last = await put(
      'profileLock',
      { mobile: null, currentPassword: 'wrong' },
      '',
      '198.18.1.200',
    ).expect(401)
    expect(last.body.code).toBe(Err.AUTH_SESSION_EXPIRED.code)
    await get('profileLock').expect(401)
    await http().get(URL).set(bearer(other)).expect(401)
    await vi.waitFor(
      async () => {
        const rows = await ds.query<{ kind: string; ok: number; msg_key: string }[]>(
          'SELECT kind, ok, msg_key FROM aud_signin_log WHERE user_id = ? AND kind = ? ORDER BY id DESC LIMIT 1',
          [id, 'locked'],
        )
        expect(rows[0]).toMatchObject({
          kind: 'locked',
          ok: 0,
          msg_key: 'signin.password_check_exceeded',
        })
      },
      { timeout: 5000 },
    )
  })

  it('verify-password, password change and profile update share the current-password counter', async () => {
    const id = await user('sharedLock', { mobile: '13900000004' })
    const threshold = (await app.get(AuthParams).load()).security.lockThreshold
    for (let i = 0; i < 2; i++) {
      const res = await http()
        .post('/api/auth/verify-password')
        .set(as('sharedLock'))
        .set('X-Forwarded-For', `198.18.2.${i + 1}`)
        .send({ password: 'wrong' })
        .expect(400)
      expect(res.body.code).toBe(Err.AUTH_PASSWORD_WRONG.code)
    }
    const change = await put(
      'sharedLock',
      { oldPassword: 'wrong', newPassword: 'Changed#Pass2' },
      '/password',
      '198.18.2.3',
    ).expect(400)
    expect(change.body.code).toBe(Err.AUTH_OLD_PASSWORD_WRONG.code)
    for (let i = 4; i < threshold; i++) {
      const res = await put(
        'sharedLock',
        { mobile: null, currentPassword: 'wrong' },
        '',
        `198.18.2.${i}`,
      ).expect(400)
      expect(res.body.code).toBe(Err.AUTH_OLD_PASSWORD_WRONG.code)
    }
    const last = await put(
      'sharedLock',
      { mobile: null, currentPassword: 'wrong' },
      '',
      '198.18.2.200',
    ).expect(401)
    expect(last.body.code).toBe(Err.AUTH_SESSION_EXPIRED.code)
    expect(Number(await redis.get(redisKey('authFail', 'cur', id)))).toBe(threshold)
  })

  it('a success on verify-password resets failures made on password change for profile update', async () => {
    const id = await user('sharedReset', { mobile: '13900000005' })
    const threshold = (await app.get(AuthParams).load()).security.lockThreshold
    for (let i = 0; i < 2; i++)
      await put(
        'sharedReset',
        { oldPassword: 'wrong', newPassword: 'Changed#Pass2' },
        '/password',
        `198.18.3.${i + 1}`,
      ).expect(400)
    await http()
      .post('/api/auth/verify-password')
      .set(as('sharedReset'))
      .send({ password: PW })
      .expect(200)
    expect(await redis.exists(redisKey('authFail', 'cur', id))).toBe(0)
    for (let i = 1; i < threshold; i++) {
      const res = await put(
        'sharedReset',
        { mobile: null, currentPassword: 'wrong' },
        '',
        `198.18.4.${i}`,
      ).expect(400)
      expect(res.body.code).toBe(Err.AUTH_OLD_PASSWORD_WRONG.code)
    }
    await get('sharedReset').expect(200)
  })

  it('at the threshold every current-password route refuses even the right password without bcrypt and ends every session', async () => {
    const threshold = (await app.get(AuthParams).load()).security.lockThreshold
    const compare = vi.spyOn(bcrypt, 'compare')
    const routes: Record<string, (who: string) => request.Test> = {
      lock: (who) =>
        http()
          .post('/api/auth/verify-password')
          .set(as(who))
          .set('X-Forwarded-For', '198.18.5.1')
          .send({ password: PW }),
      profile: (who) => put(who, { mobile: null, currentPassword: PW }, '', '198.18.5.2'),
      password: (who) =>
        put(who, { oldPassword: PW, newPassword: 'Changed#Pass2' }, '/password', '198.18.5.3'),
    }
    for (const [i, [route, call]] of Object.entries(routes).entries()) {
      const who = `atLimit-${route}`
      const id = await user(who, { mobile: `1390000002${i}` })
      const other = (await signIn(app, PREFIX + who)).accessToken
      const [before] = await ds.query<{ mobile: string; password_hash: string }[]>(
        'SELECT mobile, password_hash FROM iam_user WHERE id = ?',
        [id],
      )
      await redis.set(redisKey('authFail', 'cur', id), String(threshold))
      const res = await call(who)
      expect(res.status).toBe(401)
      expect(res.body.code).toBe(Err.AUTH_SESSION_EXPIRED.code)
      expect(compare.mock.calls.filter((c) => c[1] === before!.password_hash)).toEqual([])
      await get(who).expect(401)
      await http().get(URL).set(bearer(other)).expect(401)
      expect(
        (await ds.query('SELECT mobile, password_hash FROM iam_user WHERE id = ?', [id]))[0],
      ).toEqual(before)
    }
  })
})

it('Swagger documents the profile routes', async () => {
  const doc = (await http().get('/api/docs-json').expect(200)).body
  expect(Object.keys(doc.paths[URL])).toEqual(expect.arrayContaining(['get', 'put']))
  expect(doc.paths[`${URL}/locale`].put).toBeDefined()
  expect(doc.paths[`${URL}/avatar`].post).toBeDefined()
  expect(doc.paths[`${URL}/password`].put).toBeDefined()
  expect(doc.paths[`${URL}/mobile/code`].post).toBeDefined()
})
