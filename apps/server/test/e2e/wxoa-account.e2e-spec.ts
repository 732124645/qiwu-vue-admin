// WeChat Official Accounts (see docs/design-notes.md#wxoa): list, options, detail, create, change,
// delete, connection test, quota and its reset. The AppSecret, Token and EncodingAESKey are boxed and
// write-only (has* flags; empty or absent on change keeps them); the AppID is fixed (a PUT carrying it
// 400); compat and secure modes need an EncodingAESKey (B6008), a sandbox account plain mode (400); a
// new AppSecret or a deleted account drops the cached token; the routes calling WeChat need the account
// enabled (B6011); no answer, action log, API log, process log or fault row carries a secret. WeChat
// is the fake gateway; accounts are created through the API, extra rows written straight in.
import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import { Logger } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  Err,
  wxoaAccountDetailVo,
  wxoaAccountOptionVo,
  wxoaAccountVo,
  wxoaPerms,
} from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { SecretBox } from '../../src/core/crypto/secret-box.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId as findIdRaw, insertRow as insertRowRaw } from '../../src/db/seeds/upsert.js'
import { WxoaAccount } from '../../src/modules/platform/wxoa/core/wxoa.entity.js'
import { upstreamError, WxoaGateway } from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import { WxoaTokenService } from '../../src/modules/platform/wxoa/core/wxoa-token.js'
import { fakeWxoaGateway } from '../fixtures/wxoa/fake-gateway.js'
import { logOf, type TracedTable } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { inTenant1 } from '../setup/tenants.js'
const findId = (...args: Parameters<typeof findIdRaw>) => inTenant1(() => findIdRaw(...args))
const insertRow = (...args: Parameters<typeof insertRowRaw>) =>
  inTenant1(() => insertRowRaw(...args))

const PREFIX = 'e2e-wxoa-account-'
const URL = '/api/wxoa/accounts'
const MISSING = 999_999
const STABLE = '/cgi-bin/stable_token'
const DOMAIN_IP = '/cgi-bin/get_api_domain_ip'
const QUOTA = '/cgi-bin/openapi/quota/get'
const CLEAR = '/cgi-bin/clear_quota/v2'

const SECRET = 'c0ffee11c0ffee22c0ffee33c0ffee44'
const TOKEN = 'PushTokenE2eWxoa'
const AES = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const NEW_SECRET = 'feedface55feedface66feedface7788'
const NEW_TOKEN = 'NewPushTokenE2eWxoa'
const NEW_AES = 'ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxwvut'
const ALL_SECRETS = [SECRET, TOKEN, AES, NEW_SECRET, NEW_TOKEN, NEW_AES]

const fake = fakeWxoaGateway()
let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let box: SecretBox
let tokenService: WxoaTokenService
const tokens = {
  admin: '',
  reader: '',
  replier: '',
  sender: '',
  plain: '',
  modifier: '',
  clearer: '',
}
const userIds: number[] = []
const roleIds: number[] = []
const accountIds: number[] = []
const logged: unknown[] = []

const call = (
  who: keyof typeof tokens,
  method: 'get' | 'post' | 'put' | 'delete',
  path = '',
  body?: object,
) => {
  const req = request(app.getHttpServer())[method](`${URL}${path}`).set(bearer(tokens[who]))
  return body ? req.send(body) : req
}
let seq = 0
const unique = () => `${PREFIX}${++seq}`
/** A create body of a new AppID (unique label: no two creates are the same submission). */
const body = (over: object = {}) => ({
  label: unique(),
  appId: `wx${randomBytes(8).toString('hex')}`,
  accountKind: 'service',
  appSecret: SECRET,
  token: TOKEN,
  ...over,
})
const add = async (over: object = {}) => {
  const data = (await call('admin', 'post', '', body(over)).expect(201)).body.data
  accountIds.push(data.id)
  return data
}
const row = async (id: number) =>
  (await ds.query('SELECT * FROM wxoa_account WHERE id = ?', [id]))[0]
const tokenKey = (accountId: number) => redisKey('wxoa', 'token', accountId)
const keysOf = (schema: { shape: object }) => Object.keys(schema.shape).sort()
const expectCode = (res: request.Response, err: { code: string; status: number }) => {
  expect(res.status).toBe(err.status)
  expect(res.body.code).toBe(err.code)
}

async function role(perms: string[]) {
  const id = await insertRow(ds.manager, 'iam_role', {
    code: unique(),
    name: unique(),
    data_scope: 'all',
  })
  for (const perm of perms)
    await ds.query('INSERT INTO iam_role_menus (tenant_id, role_id, menu_id) VALUES (1, ?, ?)', [
      id,
      await findId(ds.manager, 'iam_menu', { perms: perm }),
    ])
  roleIds.push(id)
  return id
}
async function user(name: string, perms: string[]) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  if (perms.length)
    await ds.query('INSERT INTO iam_user_roles (tenant_id, user_id, role_id) VALUES (1, ?, ?)', [
      id,
      await role(perms),
    ])
  userIds.push(id)
  return (await signIn(app, PREFIX + name)).accessToken
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WxoaGateway)
    .useValue(fake.gateway)
    .compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  box = app.get(SecretBox)
  tokenService = app.get(WxoaTokenService)
  await cleanRedis(redis)
  // every process log line, whatever its level (the app's Logger writes through pino)
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const)
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
  tokens.admin = (await signIn(app)).accessToken
  tokens.reader = await user('reader', [wxoaPerms.account.browse])
  tokens.replier = await user('replier', [wxoaPerms.reply.browse])
  tokens.sender = await user('sender', [wxoaPerms.message.send])
  tokens.plain = await user('plain', [])
  const { browse, modify } = wxoaPerms.account
  tokens.modifier = await user('modifier', [browse, modify])
  tokens.clearer = await user('clearer', [browse, wxoaPerms.account['clear-quota']])
})

afterAll(async () => {
  vi.restoreAllMocks()
  if (ds) {
    if (accountIds.length) await ds.query('DELETE FROM wxoa_account WHERE id IN (?)', [accountIds])
    if (userIds.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    }
    if (roleIds.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roleIds])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roleIds])
    }
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

beforeEach(() => fake.reset())

describe('create, read, list, options', () => {
  it('a created account keeps its secrets boxed; every answer shows has* flags, never a secret', async () => {
    const data = await add()
    expect(Object.keys(data).sort()).toEqual(keysOf(wxoaAccountDetailVo))
    expect(data).toMatchObject({
      accountKind: 'service',
      verified: false,
      cryptoMode: 'plain',
      enabled: true,
      lastPushAt: null,
      note: null,
      hasAppSecret: true,
      hasToken: true,
      hasAesKey: false,
    })
    const stored = await row(data.id)
    expect(data.callbackPath).toBe(`/api/wxoa/callback/${stored.callback_key}`)
    expect(stored.callback_key).toMatch(/^[A-Za-z0-9_-]{22}$/)
    for (const col of ['app_secret_enc', 'push_token_enc'])
      expect(SecretBox.isBox(stored[col])).toBe(true)
    expect(box.decrypt(stored.app_secret_enc)).toBe(SECRET)
    expect(box.decrypt(stored.push_token_enc)).toBe(TOKEN)
    expect(stored.aes_key_enc).toBeNull()

    const detail = (await call('admin', 'get', `/${data.id}`).expect(200)).body.data
    expect(detail).toEqual(data)
    const list = (
      await call('admin', 'get', `?label=${encodeURIComponent(data.label)}`).expect(200)
    ).body.data
    expect(list.total).toBe(1)
    expect(Object.keys(list.items[0]).sort()).toEqual(keysOf(wxoaAccountVo))
    const options = (await call('admin', 'get', '/options').expect(200)).body.data
    const option = options.find((o: { id: number }) => o.id === data.id)
    expect(Object.keys(option).sort()).toEqual(keysOf(wxoaAccountOptionVo))
    const text = JSON.stringify([data, detail, list, options])
    for (const s of [SECRET, TOKEN, stored.app_secret_enc, stored.push_token_enc, 'Enc"'])
      expect(text).not.toContain(s)
  })

  it('the entity never loads a secret column unless asked for', async () => {
    const { id } = await add({ cryptoMode: 'secure', aesKey: AES })
    const loaded = await inTenant1(() => ds.getRepository(WxoaAccount).findOneByOrFail({ id }))
    expect(loaded.label).toBeTruthy()
    expect([loaded.appSecretEnc, loaded.pushTokenEnc, loaded.aesKeyEnc]).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  it('compat and secure accounts keep their EncodingAESKey boxed (hasAesKey)', async () => {
    for (const cryptoMode of ['compat', 'secure']) {
      const data = await add({ cryptoMode, aesKey: AES, verified: true, note: 'n' })
      expect(data).toMatchObject({ cryptoMode, verified: true, note: 'n', hasAesKey: true })
      expect(box.decrypt((await row(data.id)).aes_key_enc)).toBe(AES)
    }
  })

  it('the list filters by label, AppID, kind and enabled; deleted accounts are gone', async () => {
    const tag = unique()
    const one = await add({ label: `${tag}-a`, accountKind: 'subscription' })
    const two = await add({ label: `${tag}-b`, enabled: false })
    const gone = await add({ label: `${tag}-c` })
    await call('admin', 'delete', `/${gone.id}`).expect(200)
    const ids = async (query: string) =>
      (
        await call('admin', 'get', `?label=${encodeURIComponent(tag)}&${query}`).expect(200)
      ).body.data.items
        .map((a: { id: number }) => a.id)
        .sort()
    expect(await ids('')).toEqual([one.id, two.id].sort())
    expect(await ids('accountKind=subscription')).toEqual([one.id])
    expect(await ids('enabled=false')).toEqual([two.id])
    expect(await ids(`appId=${one.appId.slice(2, 12)}`)).toEqual([one.id])
  })

  it('options: live accounts, disabled ones marked; any wxoa browse permission reads them', async () => {
    const on = await add()
    const off = await add({ enabled: false })
    const gone = await add()
    await call('admin', 'delete', `/${gone.id}`).expect(200)
    for (const who of ['admin', 'reader', 'replier'] as const) {
      const options = (await call(who, 'get', '/options').expect(200)).body.data
      const byId = new Map(options.map((o: { id: number }) => [o.id, o]))
      expect(byId.get(on.id)).toMatchObject({ enabled: true, label: on.label })
      expect(byId.get(off.id)).toMatchObject({ enabled: false })
      expect(byId.has(gone.id)).toBe(false)
    }
    await call('sender', 'get', '/options').expect(403)
    await call('plain', 'get', '/options').expect(403)
  })

  it('an AppID taken by a live account → 409; once deleted it is added again as a new account', async () => {
    const first = await add()
    const dup = await call('admin', 'post', '', body({ appId: first.appId })).expect(409)
    expect(dup.body.code).toBe(Err.DUPLICATE.code)
    await call('admin', 'delete', `/${first.id}`).expect(200)
    const again = await add({ appId: first.appId })
    expect(again.id).not.toBe(first.id)
    expect(again.callbackPath).not.toBe(first.callbackPath)
  })

  it('the same create submitted twice within 3 s → 429', async () => {
    const same = body()
    accountIds.push((await call('admin', 'post', '', same).expect(201)).body.data.id)
    const again = await call('admin', 'post', '', same).expect(429)
    expect(again.body.code).toBe(Err.TOO_MANY_REQUESTS.code)
  })
})

describe('change', () => {
  it('an empty or absent secret keeps the stored one; a new one replaces it', async () => {
    const { id } = await add({ cryptoMode: 'compat', aesKey: AES })
    const before = await row(id)
    await call('admin', 'put', `/${id}`, { label: unique() }).expect(200)
    await call('admin', 'put', `/${id}`, { appSecret: '', token: '', aesKey: '' }).expect(200)
    const kept = await row(id)
    for (const col of ['app_secret_enc', 'push_token_enc', 'aes_key_enc'])
      expect(kept[col]).toBe(before[col])
    await call('admin', 'put', `/${id}`, {
      appSecret: NEW_SECRET,
      token: NEW_TOKEN,
      aesKey: NEW_AES,
    }).expect(200)
    const after = await row(id)
    expect(box.decrypt(after.app_secret_enc)).toBe(NEW_SECRET)
    expect(box.decrypt(after.push_token_enc)).toBe(NEW_TOKEN)
    expect(box.decrypt(after.aes_key_enc)).toBe(NEW_AES)
  })

  it('an appId (or a callback key) in the body → 400, the stored values unchanged', async () => {
    const data = await add()
    const before = await row(data.id)
    for (const extra of [
      { appId: `wx${randomBytes(8).toString('hex')}` },
      { appId: data.appId },
      { callbackKey: randomBytes(16).toString('base64url') },
    ]) {
      const res = await call('admin', 'put', `/${data.id}`, { label: unique(), ...extra }).expect(
        400,
      )
      expect(res.body.code).toBe(Err.VALIDATION_FAILED.code)
    }
    expect(await row(data.id)).toEqual(before)
  })

  it('a sandbox account stays in plain mode: as sent or as the change leaves it → 400', async () => {
    const sandbox = await add({ accountKind: 'sandbox' })
    const res = await call('admin', 'put', `/${sandbox.id}`, {
      cryptoMode: 'compat',
      aesKey: AES,
    }).expect(400)
    expect(res.body.errors.map((e: { path: string }) => e.path)).toContain('cryptoMode')
    expect((await row(sandbox.id)).crypto_mode).toBe('plain')
    const secure = await add({ cryptoMode: 'secure', aesKey: AES })
    await call('admin', 'put', `/${secure.id}`, { accountKind: 'sandbox' }).expect(400)
    expect((await row(secure.id)).account_kind).toBe('service')
    await call('admin', 'put', `/${secure.id}`, {
      accountKind: 'sandbox',
      cryptoMode: 'plain',
    }).expect(200)
  })

  it('compat or secure without an EncodingAESKey sent or stored → B6008', async () => {
    for (const aesKey of [undefined, ''])
      expectCode(
        await call('admin', 'post', '', body({ cryptoMode: 'compat', aesKey })),
        Err.WXOA_AES_KEY_REQUIRED,
      )
    const { id } = await add()
    expectCode(
      await call('admin', 'put', `/${id}`, { cryptoMode: 'secure' }),
      Err.WXOA_AES_KEY_REQUIRED,
    )
    expectCode(
      await call('admin', 'put', `/${id}`, { cryptoMode: 'secure', aesKey: '' }),
      Err.WXOA_AES_KEY_REQUIRED,
    )
    expect((await row(id)).crypto_mode).toBe('plain')
    await call('admin', 'put', `/${id}`, { cryptoMode: 'secure', aesKey: AES }).expect(200)
    // stored now: switching between the encrypted modes needs no key
    await call('admin', 'put', `/${id}`, { cryptoMode: 'compat' }).expect(200)
    expect(await row(id)).toMatchObject({ crypto_mode: 'compat' })
  })
})

describe('the token cache', () => {
  it('a new AppSecret drops the cached token; other changes keep it', async () => {
    const { id } = await add()
    await redis.set(tokenKey(id), 'TOKEN-CACHED')
    await call('admin', 'put', `/${id}`, { label: unique(), token: NEW_TOKEN }).expect(200)
    await call('admin', 'put', `/${id}`, { appSecret: '' }).expect(200)
    expect(await redis.get(tokenKey(id))).toBe('TOKEN-CACHED')
    await call('admin', 'put', `/${id}`, { appSecret: NEW_SECRET }).expect(200)
    expect(await redis.get(tokenKey(id))).toBeNull()
  })

  it('deleting the account drops its cached token; only its row is deleted', async () => {
    const { id } = await add()
    const fan = await insertRow(ds.manager, 'wxoa_fan', { account_id: id, open_id: unique() })
    await redis.set(tokenKey(id), 'TOKEN-CACHED')
    await call('admin', 'delete', `/${id}`).expect(200)
    expect(await redis.get(tokenKey(id))).toBeNull()
    expect((await row(id)).deleted_at).not.toBeNull()
    const [kept] = await ds.query('SELECT deleted_at FROM wxoa_fan WHERE id = ?', [fan])
    expect(kept.deleted_at).toBeNull()
    await ds.query('DELETE FROM wxoa_fan WHERE id = ?', [fan])
  })
})

describe('connection test', () => {
  it('asks WeChat for a token past the cache, caches it, then calls an API', async () => {
    const { id } = await add()
    await redis.set(tokenKey(id), 'TOKEN-CACHED')
    fake.on(STABLE, { access_token: 'TOKEN-FRESH', expires_in: 7200 })
    fake.on(DOMAIN_IP, { ip_list: ['203.0.113.1'] })
    const res = await call('admin', 'post', `/${id}/test`).expect(200)
    expect(res.body.data).toEqual({
      tokenOk: true,
      apiOk: true,
      code: null,
      ip: null,
      lastPushAt: null,
    })
    expect(fake.calls.map((c) => [c.path, c.accountId])).toEqual([
      [STABLE, id],
      [DOMAIN_IP, id],
    ])
    expect(await redis.get(tokenKey(id))).toBe('TOKEN-FRESH')
  })

  it('a refused AppSecret: the token fails with its code and no API is called', async () => {
    const { id } = await add()
    fake.on(STABLE, upstreamError(40125))
    const res = await call('admin', 'post', `/${id}/test`).expect(200)
    expect(res.body.data).toMatchObject({
      tokenOk: false,
      apiOk: false,
      code: Err.WXOA_CREDENTIAL_INVALID.code,
      ip: null,
    })
    expect(fake.callsTo(DOMAIN_IP)).toHaveLength(0)
  })

  it('an IP allow-list refusal names the IP; the last push is reported', async () => {
    const { id } = await add()
    const pushed = new Date('2026-10-01T08:00:00.000Z')
    await ds.query('UPDATE wxoa_account SET last_push_at = ? WHERE id = ?', [pushed, id])
    fake.on(STABLE, { access_token: 'TOKEN-FRESH', expires_in: 7200 })
    fake.on(DOMAIN_IP, upstreamError(40164, 'invalid ip 203.0.113.9 ipv6 ::ffff, not in whitelist'))
    const res = await call('admin', 'post', `/${id}/test`).expect(200)
    expect(res.body.data).toEqual({
      tokenOk: true,
      apiOk: false,
      code: Err.WXOA_IP_NOT_ALLOWED.code,
      ip: '203.0.113.9',
      lastPushAt: pushed.toISOString(),
    })
  })
})

describe('quota', () => {
  const pathOf = (c: { body?: unknown }) => (c.body as { cgi_path: string }).cgi_path

  it('one quota/get per API of the list; an API the account may not call is left out', async () => {
    const { id } = await add()
    // quota/get: no permission for the path 76022, unknown path 76021; an API call itself 48001
    const refused = new Map([
      ['/cgi-bin/message/template/send', 76022],
      ['/cgi-bin/qrcode/create', 76021],
      ['/cgi-bin/message/custom/send', 48001],
    ])
    fake.on(QUOTA, (c) => {
      const code = refused.get(pathOf(c))
      return code
        ? upstreamError(code)
        : { errcode: 0, quota: { daily_limit: 1000, used: 3, remain: 997 } }
    })
    const list = (await call('reader', 'get', `/${id}/quota`).expect(200)).body.data
    const asked = fake.callsTo(QUOTA).map(pathOf)
    expect(new Set(asked).size).toBe(asked.length)
    for (const path of refused.keys()) expect(asked).toContain(path)
    const left = asked.filter((p) => !refused.has(p))
    expect(left.length).toBeGreaterThan(0)
    expect(list.map((q: { api: string }) => q.api)).toEqual(left)
    expect(list[0]).toEqual({ api: left[0], dailyLimit: 1000, used: 3, remain: 997 })
    expect(fake.calls.every((c) => c.accountId === id)).toBe(true)
  })

  it('no API of the list callable → B6003', async () => {
    const { id } = await add()
    fake.on(QUOTA, upstreamError(76022))
    expectCode(await call('admin', 'get', `/${id}/quota`), Err.WXOA_API_UNAUTHORIZED)
    expect(fake.callsTo(QUOTA).length).toBeGreaterThan(1)
  })

  it('any other failure fails the request with its code', async () => {
    const { id } = await add()
    fake.on(QUOTA, upstreamError(45009))
    expectCode(await call('admin', 'get', `/${id}/quota`), Err.WXOA_QUOTA_EXCEEDED)
  })

  it('the reset goes to clear_quota/v2 for the account (the gateway signs it); a refusal → its code', async () => {
    const { id } = await add()
    fake.on(CLEAR, { errcode: 0 }, upstreamError(48006))
    await call('admin', 'post', `/${id}/quota/clear`).expect(200)
    expect(fake.callsTo(CLEAR)).toEqual([{ method: 'json', path: CLEAR, accountId: id }])
    const refused = await call('admin', 'post', `/${id}/quota/clear`)
    expectCode(refused, Err.WXOA_UPSTREAM_REFUSED)
    expect(refused.body.msg).toContain('48006')
  })
})

describe('the account', () => {
  const routes = (id: number) =>
    [
      ['get', `/${id}`, undefined],
      ['put', `/${id}`, { label: unique() }],
      ['delete', `/${id}`, undefined],
      ['post', `/${id}/test`, undefined],
      ['get', `/${id}/quota`, undefined],
      ['post', `/${id}/quota/clear`, undefined],
    ] as const

  it('an unknown or deleted account → 404 on every route, WeChat never called', async () => {
    const gone = await add()
    await call('admin', 'delete', `/${gone.id}`).expect(200)
    for (const id of [MISSING, gone.id])
      for (const [method, path, payload] of routes(id))
        await call('admin', method, path, payload).expect(404)
    expect(fake.calls).toHaveLength(0)
  })

  it('a disabled account: test, quota and reset → B6011 without calling WeChat; read, change and re-enable work', async () => {
    const { id } = await add({ enabled: false })
    for (const [method, path] of [
      ['post', `/${id}/test`],
      ['get', `/${id}/quota`],
      ['post', `/${id}/quota/clear`],
    ] as const)
      expectCode(await call('admin', method, path), Err.WXOA_ACCOUNT_DISABLED)
    expect(fake.calls).toHaveLength(0)
    await call('admin', 'get', `/${id}`).expect(200)
    await call('admin', 'put', `/${id}`, { enabled: true }).expect(200)
    fake.on(STABLE, { access_token: 'TOKEN-FRESH', expires_in: 7200 })
    fake.on(DOMAIN_IP, { ip_list: [] })
    await call('admin', 'post', `/${id}/test`).expect(200)
  })
})

describe('400', () => {
  const cases: [string, object, string][] = [
    ['an AppID of another format', { appId: 'wx123' }, 'appId'],
    ['an AppSecret not 32 hex digits', { appSecret: 'zz'.repeat(16) }, 'appSecret'],
    ['a Token with a symbol', { token: 'bad token!' }, 'token'],
    [
      'an EncodingAESKey of 42 characters',
      { cryptoMode: 'secure', aesKey: 'a'.repeat(42) },
      'aesKey',
    ],
    [
      'a sandbox account in compat mode',
      { accountKind: 'sandbox', cryptoMode: 'compat', aesKey: AES },
      'cryptoMode',
    ],
    ['an unknown kind', { accountKind: 'mini' }, 'accountKind'],
    ['no label', { label: '' }, 'label'],
  ]
  it.each(cases)('create: %s', async (_name, over, field) => {
    const res = await call('admin', 'post', '', body(over)).expect(400)
    expect(res.body.code).toBe(Err.VALIDATION_FAILED.code)
    expect(res.body.errors.map((e: { path: string }) => e.path)).toContain(field)
  })

  it('a refused secret is not echoed; the list refuses an unknown kind', async () => {
    const res = await call('admin', 'post', '', body({ appSecret: `${SECRET}0` })).expect(400)
    expect(JSON.stringify(res.body)).not.toContain(SECRET)
    await call('admin', 'get', '?accountKind=mini').expect(400)
  })
})

describe('403', () => {
  it('without the permission of a route the request is refused', async () => {
    const { id } = await add()
    fake.on(QUOTA, { errcode: 0, quota: { daily_limit: 1, used: 0, remain: 1 } })
    const reads = [
      ['get', ''],
      ['get', `/${id}`],
      ['get', `/${id}/quota`],
    ] as const
    const writes = [
      ['post', '', body()],
      ['put', `/${id}`, { label: unique() }],
      ['delete', `/${id}`, undefined],
      ['post', `/${id}/test`, undefined],
      ['post', `/${id}/quota/clear`, undefined],
    ] as const
    for (const [method, path] of reads) {
      await call('plain', method, path).expect(403)
      await call('replier', method, path).expect(403)
      await call('reader', method, path).expect(200)
    }
    for (const [method, path, payload] of writes) {
      await call('plain', method, path, payload).expect(403)
      await call('reader', method, path, payload).expect(403)
    }
    expect(fake.callsTo(CLEAR)).toHaveLength(0)
    expect((await row(id)).deleted_at).toBeNull()
  })

  it('each write needs its own permission: modify covers change and test only, the reset its own', async () => {
    const { id } = await add()
    await call('modifier', 'post', '', body()).expect(403)
    await call('modifier', 'delete', `/${id}`).expect(403)
    await call('modifier', 'post', `/${id}/quota/clear`).expect(403)
    await call('modifier', 'put', `/${id}`, { label: unique() }).expect(200)
    fake.on(STABLE, { access_token: 'TOKEN-FRESH', expires_in: 7200 })
    fake.on(DOMAIN_IP, { ip_list: [] })
    await call('modifier', 'post', `/${id}/test`).expect(200)
    expect(fake.callsTo(CLEAR)).toHaveLength(0)

    await call('clearer', 'put', `/${id}`, { label: unique() }).expect(403)
    await call('clearer', 'post', `/${id}/test`).expect(403)
    fake.on(CLEAR, { errcode: 0 })
    await call('clearer', 'post', `/${id}/quota/clear`).expect(200)
    expect(fake.callsTo(CLEAR)).toHaveLength(1)
    expect((await row(id)).deleted_at).toBeNull()
  })
})

it('no answer, action log, API log, process log or fault row carries a secret', async () => {
  const trace = `${PREFIX}${process.pid}-`
  const sent = (id: string, req: request.Test) => req.set('X-Request-Id', `${trace}${id}`)
  const answers: unknown[] = []
  const created = await sent(
    'c',
    call('admin', 'post', '', body({ cryptoMode: 'secure', aesKey: AES })),
  ).expect(201)
  const { id } = created.body.data
  accountIds.push(id)
  answers.push(created.body)
  answers.push((await call('admin', 'get', `/${id}`).expect(200)).body)
  answers.push((await call('admin', 'get', `?label=${created.body.data.label}`).expect(200)).body)
  answers.push((await call('admin', 'get', '/options').expect(200)).body)
  const change = { appSecret: NEW_SECRET, token: NEW_TOKEN, aesKey: NEW_AES }
  answers.push((await sent('u', call('admin', 'put', `/${id}`, change)).expect(200)).body)
  fake.on(STABLE, { access_token: 'TOKEN-FRESH', expires_in: 7200 })
  fake.on(DOMAIN_IP, { ip_list: [] })
  answers.push((await sent('t', call('admin', 'post', `/${id}/test`)).expect(200)).body)
  // a change failing past validation (the cache cannot be dropped): 500, nothing changed
  const before = await row(id)
  await redis.set(tokenKey(id), 'TOKEN-CACHED')
  const drop = vi.spyOn(tokenService, 'drop').mockRejectedValue(new Error('cache unavailable'))
  const failed = await sent('f', call('admin', 'put', `/${id}`, { ...change, appSecret: SECRET }))
  drop.mockRestore()
  expect(failed.status).toBe(500)
  answers.push(failed.body)
  expect(await row(id)).toEqual(before)
  expect(await redis.get(tokenKey(id))).toBe('TOKEN-CACHED')

  const rows: [string, TracedTable][] = [
    ['c', 'aud_action_log'],
    ['u', 'aud_action_log'],
    ['t', 'aud_action_log'],
    ['f', 'aud_action_log'],
    ['c', 'aud_http_trace'],
    ['u', 'aud_http_trace'],
    ['f', 'aud_http_trace'],
    ['f', 'aud_http_fault'],
  ]
  const logs = []
  for (const [suffix, table] of rows) logs.push(await logOf(ds, `${trace}${suffix}`, table))
  expect(logs.every(Boolean)).toBe(true)
  const action = (await logOf(ds, `${trace}u`))!
  expect(JSON.parse(action.params).body).toEqual({ appSecret: '***', token: '***', aesKey: '***' })
  expect(logged.length).toBeGreaterThan(0)
  const boxes = [before.app_secret_enc, before.push_token_enc, before.aes_key_enc]
  // answers, audit rows and process log lines
  for (const value of [answers, logs, logged]) {
    const text = inspect(value, { depth: null, maxStringLength: null, maxArrayLength: null })
    for (const s of [...ALL_SECRETS, ...boxes]) expect(text).not.toContain(s)
  }
})

it('every write leaves an action log row with domain wxoa.account, its verb and the id', async () => {
  const trace = `${PREFIX}${process.pid}-verb-`
  const created = await call('admin', 'post', '', body())
    .set('X-Request-Id', `${trace}create`)
    .expect(201)
  const { id } = created.body.data
  accountIds.push(id)
  fake.on(STABLE, { access_token: 'TOKEN-FRESH', expires_in: 7200 })
  fake.on(DOMAIN_IP, { ip_list: [] })
  fake.on(CLEAR, { errcode: 0 })
  const steps = [
    ['modify', 'put', `/${id}`, { label: unique() }],
    ['test', 'post', `/${id}/test`, undefined],
    ['clean', 'post', `/${id}/quota/clear`, undefined],
    ['remove', 'delete', `/${id}`, undefined],
  ] as const
  for (const [verb, method, path, payload] of steps)
    await call('admin', method, path, payload).set('X-Request-Id', `${trace}${verb}`).expect(200)
  for (const verb of ['create', ...steps.map((s) => s[0])])
    expect(await logOf(ds, `${trace}${verb}`)).toMatchObject({
      domain: 'wxoa.account',
      verb,
      biz_id: String(id),
      ok: 1,
    })
})

it('Swagger documents every route', async () => {
  const doc = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body
  const paths = Object.keys(doc.paths).filter((p) => p.startsWith(URL))
  expect(Object.fromEntries(paths.map((p) => [p, Object.keys(doc.paths[p]).sort()]))).toEqual({
    [URL]: ['get', 'post'],
    [`${URL}/options`]: ['get'],
    [`${URL}/{id}`]: ['delete', 'get', 'put'],
    [`${URL}/{id}/test`]: ['post'],
    [`${URL}/{id}/quota`]: ['get'],
    [`${URL}/{id}/quota/clear`]: ['post'],
  })
})
