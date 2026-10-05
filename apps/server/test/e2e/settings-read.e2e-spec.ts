// settings read side (see docs/design-notes.md#i18n): GET /api/settings/dicts/:code/entries for any signed-in user
// (Redis `dict:` cache + version), ParamService.get (Redis `param:` cache) and the unauthenticated
// GET /api/settings/params/public/:key for `is_public` params only.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  DEFAULT_PASSWORD_POLICY,
  DEFAULT_TIMEZONE,
  DEFAULT_TIMEZONE_PARAM,
  Err,
  loginSecurityParams,
  passwordPolicyParams,
  storageParams,
} from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { DictService } from '../../src/core/settings/dict.service.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const USER = 'settings-e2e-plain'
const GENDER = '/api/settings/dicts/iam.gender/entries'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let dicts: DictService
let params: ParamService
let token: string
let userId: number

const http = () => request(app.getHttpServer())
const entries = async (path = GENDER) => (await http().get(path).set(bearer(token))).body

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  dicts = app.get(DictService)
  params = app.get(ParamService)
  await cleanRedis(redis)
  // no roles, no perms: dict entries need only a session
  userId = await insertRow(ds.manager, 'iam_user', {
    username: USER,
    display_name: USER,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  token = (await signIn(app, USER)).accessToken
})

afterAll(async () => {
  if (ds) await ds.query('DELETE FROM iam_user WHERE id = ?', [userId])
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('GET /api/settings/dicts/:code/entries', () => {
  it('any signed-in user: enabled entries in order with every language, version 0; 401 without a session', async () => {
    expect(await entries()).toEqual({
      code: 0,
      msg: expect.any(String),
      data: {
        version: 0,
        entries: [
          expect.objectContaining({
            value: 'male',
            labelI18n: expect.objectContaining({ 'en-US': 'Male' }),
          }),
          expect.objectContaining({ value: 'female' }),
          {
            value: 'unknown',
            label: expect.any(String),
            labelI18n: { 'zh-CN': expect.any(String), 'en-US': 'Not specified' },
            tagType: null,
            cssClass: null,
            isDefault: true,
            sortNo: 30,
          },
        ],
      },
    })
    expect((await http().get(GENDER)).status).toBe(401)
  })

  it('unknown or disabled dicts → 404; disabled entries are left out', async () => {
    const res = await http().get('/api/settings/dicts/no.such_dict/entries').set(bearer(token))
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(Err.NOT_FOUND.code)
    try {
      await ds.query(
        "UPDATE cfg_dict_entry SET enabled = 0 WHERE dict_code = 'core.yes_no' AND value = 'false'",
      )
      await dicts.invalidate('core.yes_no')
      const yesNo = await entries('/api/settings/dicts/core.yes_no/entries')
      expect(yesNo.data.entries.map((e: { value: string }) => e.value)).toEqual(['true'])
      await ds.query("UPDATE cfg_dict SET enabled = 0 WHERE code = 'core.yes_no'")
      await dicts.invalidate('core.yes_no')
      expect(
        (await http().get('/api/settings/dicts/core.yes_no/entries').set(bearer(token))).status,
      ).toBe(404)
    } finally {
      await ds.query("UPDATE cfg_dict SET enabled = 1 WHERE code = 'core.yes_no'")
      await ds.query("UPDATE cfg_dict_entry SET enabled = 1 WHERE dict_code = 'core.yes_no'")
      await dicts.invalidate('core.yes_no')
    }
  })

  it('served from the Redis dict: cache until invalidated; invalidate bumps the version', async () => {
    const before = (await entries()).data
    const label = before.entries[0].label
    expect(await redis.exists(redisKey('dict', 'entries', 'iam.gender'))).toBe(1)
    try {
      await ds.query(
        "UPDATE cfg_dict_entry SET label = 'changed' WHERE dict_code = 'iam.gender' AND value = 'male'",
      )
      expect((await entries()).data).toEqual(before)
      await dicts.invalidate('iam.gender')
      const after = (await entries()).data
      expect(after.version).toBe(before.version + 1)
      expect(after.entries[0].label).toBe('changed')
    } finally {
      await ds.query(
        "UPDATE cfg_dict_entry SET label = ? WHERE dict_code = 'iam.gender' AND value = 'male'",
        [label],
      )
      await dicts.invalidate('iam.gender')
    }
  })
})

describe('ParamService', () => {
  it('get: the value (Redis param: cache until invalidated); null for unknown keys', async () => {
    const key = loginSecurityParams.lockMinutes
    const [{ param_value: original }] = await ds.query(
      'SELECT param_value FROM cfg_param WHERE param_key = ?',
      [key],
    )
    expect(await params.get(key)).toBe(original)
    expect(await redis.exists(redisKey('param', key))).toBe(1)
    try {
      await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', ['42', key])
      expect(await params.get(key)).toBe(original)
      await params.invalidate(key)
      expect(await params.get(key)).toBe('42')
    } finally {
      await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [original, key])
      await params.invalidate(key)
    }
    expect(await params.get('no.such_param')).toBeNull()
  })
})

describe('GET /api/settings/params/public/:key', () => {
  it('no session needed for an is_public param', async () => {
    const res = await http()
      .get(`/api/settings/params/public/${DEFAULT_TIMEZONE_PARAM}`)
      .expect(200)
    expect(res.body.data).toEqual({ key: DEFAULT_TIMEZONE_PARAM, value: DEFAULT_TIMEZONE })
  })

  it('publishes password rules and the upload limit without a session', async () => {
    for (const [key, value] of [
      [passwordPolicyParams.minLength, DEFAULT_PASSWORD_POLICY.minLength],
      [passwordPolicyParams.charClasses, DEFAULT_PASSWORD_POLICY.charClasses],
      [storageParams.maxSizeMb, 20],
    ] as const) {
      const res = await http().get(`/api/settings/params/public/${key}`).expect(200)
      expect(res.body.data).toEqual({ key, value: String(value) })
    }
  })

  it('non-public and unknown keys are the same 404, even with a session', async () => {
    for (const key of [
      loginSecurityParams.lockThreshold,
      storageParams.allowedExts,
      'no.such_param',
    ]) {
      const res = await http().get(`/api/settings/params/public/${key}`).set(bearer(token))
      expect(res.status).toBe(404)
      expect(res.body.code).toBe(Err.NOT_FOUND.code)
    }
  })
})
