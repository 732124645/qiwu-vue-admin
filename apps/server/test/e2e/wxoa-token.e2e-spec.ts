// Official Account access tokens through the real gateway and token service of the app, WeChat answered
// by a stubbed https.request: one stable_token per account at a time, the Redis cache under the account
// id (an AppID deleted and added again is another account: never the old one's token or request), a
// fresh token on demand, a refused token dropped and fetched once more, and never force_refresh.
import https from 'node:https'
import { PassThrough } from 'node:stream'
import { Logger } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { SecretBox } from '../../src/core/crypto/secret-box.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow as insertRowRaw } from '../../src/db/seeds/upsert.js'
import { WxoaGateway, type WxoaCaller } from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import {
  tokenKey as keyOf,
  WxoaTokenService,
} from '../../src/modules/platform/wxoa/core/wxoa-token.js'
import { cleanRedis } from '../setup/redis.js'
import { inTenant1 } from '../setup/tenants.js'
const insertRow = (...args: Parameters<typeof insertRowRaw>) =>
  inTenant1(() => insertRowRaw(...args))

const SECRET = 'fedcba9876543210fedcba9876543210'
const TOKEN = 'TOKEN-E2E-'
const STABLE = '/cgi-bin/stable_token'
const API = '/cgi-bin/get_api_domain_ip'

interface Sent {
  path: string
  query: URLSearchParams
  body: string
}

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let tokens: WxoaTokenService
let gateway: WxoaGateway
const accounts: WxoaCaller[] = []
let sent: Sent[] = []
/** every request of the spec (`sent` is per case) */
const everything: Sent[] = []
/** errcodes the next business calls answer with (0 = ok) */
let apiAnswers: number[] = []
/** stable_token answers by AppID instead of a new token */
const stableAnswers = new Map<string, object>()
let tokenSeq = 0
const logged: unknown[] = []

const tokenKey = (a: WxoaCaller) => keyOf(a.id)
const stableCalls = () => sent.filter((s) => s.path === STABLE)
const apiCalls = () => sent.filter((s) => s.path === API)
const getToken = (a: WxoaCaller, opts: { fresh?: boolean } = {}) =>
  inTenant1(() => tokens.get(a, opts))
const callApi = (a: WxoaCaller, path: string) => inTenant1(() => gateway.json(a, path))
const dropToken = (accountId: number) => inTenant1(() => tokens.drop(accountId))

async function account(n: number, over: Record<string, unknown> = {}): Promise<WxoaCaller> {
  const appId = `wx00000000000e2e${n.toString(16).padStart(2, '0')}`
  const id = await insertRow(ds.manager, 'wxoa_account', {
    label: `token-e2e-${n}`,
    app_id: appId,
    account_kind: 'service',
    app_secret_enc: app.get(SecretBox).encrypt(SECRET),
    push_token_enc: app.get(SecretBox).encrypt('pushtoken'),
    callback_key: `tokene2e${n}`.padEnd(22, 'k'),
    ...over,
  })
  return { id, appId, accountKind: 'service' }
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false })
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  tokens = app.get(WxoaTokenService)
  gateway = app.get(WxoaGateway)
  await cleanRedis(redis)
  await ds.query("DELETE FROM wxoa_account WHERE label LIKE 'token-e2e-%'")
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const)
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
  // WeChat: stable_token answers a new token after 50 ms; the business API answers `apiAnswers`
  vi.spyOn(https, 'request').mockImplementation(((
    opts: https.RequestOptions,
    cb: (res: PassThrough) => void,
  ) => {
    const req = new PassThrough()
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('finish', () => {
      const [path = '', qs = ''] = String(opts.path).split('?')
      const s = { path, query: new URLSearchParams(qs), body }
      sent.push(s)
      everything.push(s)
      const answer =
        path !== STABLE
          ? { errcode: apiAnswers.shift() ?? 0, ip_list: ['203.0.113.1'] }
          : (stableAnswers.get(JSON.parse(body).appid) ?? {
              access_token: `${TOKEN}${++tokenSeq}`,
              expires_in: 7200,
            })
      setTimeout(() => {
        const res = Object.assign(new PassThrough(), {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
        })
        cb(res)
        res.end(JSON.stringify(answer))
      }, 50)
    })
    return req
  }) as never)
  for (let n = 1; n <= 10; n++) accounts.push(await account(n))
})

afterAll(async () => {
  vi.restoreAllMocks()
  if (ds) await ds.query("DELETE FROM wxoa_account WHERE label LIKE 'token-e2e-%'")
  if (redis) await cleanRedis(redis)
  await app?.close()
})

beforeEach(() => {
  sent = []
  apiAnswers = []
})

it('two concurrent requests send one stable_token; both get its token, cached 5 minutes short', async () => {
  const a = accounts[0]!
  const got = await Promise.all([getToken(a), getToken(a)])
  expect(stableCalls()).toHaveLength(1)
  expect(got).toEqual([`${TOKEN}${tokenSeq}`, `${TOKEN}${tokenSeq}`])
  expect(await redis.get(tokenKey(a))).toBe(`${TOKEN}${tokenSeq}`)
  const ttl = await redis.pTTL(tokenKey(a))
  expect(ttl).toBeGreaterThan(6_890_000)
  expect(ttl).toBeLessThanOrEqual(6_900_000)
})

it('two concurrent calls of an API with no cached token: one stable_token, both calls made', async () => {
  const a = accounts[1]!
  await Promise.all([callApi(a, API), callApi(a, API)])
  expect(stableCalls()).toHaveLength(1)
  expect(apiCalls().map((s) => s.query.get('access_token'))).toEqual([
    `${TOKEN}${tokenSeq}`,
    `${TOKEN}${tokenSeq}`,
  ])
})

it('a cached token is used without asking WeChat', async () => {
  const a = accounts[0]!
  const cached = await redis.get(tokenKey(a))
  expect(await getToken(a)).toBe(cached)
  await callApi(a, API)
  expect(stableCalls()).toHaveLength(0)
  expect(apiCalls()[0]!.query.get('access_token')).toBe(cached)
})

it('fresh asks WeChat even with a cached token, then caches the new one', async () => {
  const a = accounts[0]!
  expect(await redis.get(tokenKey(a))).toBeTruthy()
  const fresh = await getToken(a, { fresh: true })
  expect(stableCalls()).toHaveLength(1)
  expect(fresh).toBe(`${TOKEN}${tokenSeq}`)
  expect(await redis.get(tokenKey(a))).toBe(fresh)
})

it('fresh does not wait for a request in flight: it sends a stable_token of its own', async () => {
  const a = accounts[9]!
  const normal = getToken(a)
  await vi.waitFor(() => expect(stableCalls()).toHaveLength(1), { interval: 1 })
  const fresh = getToken(a, { fresh: true })
  const [first, second] = await Promise.all([normal, fresh])
  expect(stableCalls()).toHaveLength(2)
  expect(second).not.toBe(first)
})

it('a refused token (40001): dropped, fetched once more, the call made once more', async () => {
  const a = accounts[2]!
  await redis.set(tokenKey(a), `${TOKEN}revoked`)
  apiAnswers = [40001, 0]
  expect(await callApi(a, API)).toMatchObject({ errcode: 0 })
  expect(stableCalls()).toHaveLength(1)
  expect(apiCalls().map((s) => s.query.get('access_token'))).toEqual([
    `${TOKEN}revoked`,
    `${TOKEN}${tokenSeq}`,
  ])
  expect(await redis.get(tokenKey(a))).toBe(`${TOKEN}${tokenSeq}`)
})

it('refused again: B6006 after two calls and one new token, no loop', async () => {
  const a = accounts[3]!
  await redis.set(tokenKey(a), `${TOKEN}revoked`)
  // a third call would succeed: only a loop gets there
  apiAnswers = [42001, 40014, 0]
  await expect(callApi(a, API)).rejects.toMatchObject({ err: Err.WXOA_CREDENTIAL_INVALID })
  expect(apiCalls()).toHaveLength(2)
  expect(stableCalls()).toHaveLength(1)
  expect(apiAnswers).toEqual([0])
})

it('accounts do not share a request or a token', async () => {
  const [a, b] = [accounts[6]!, accounts[7]!]
  const [ta, tb] = await Promise.all([getToken(a), getToken(b)])
  expect(
    stableCalls()
      .map((s) => JSON.parse(s.body).appid)
      .sort(),
  ).toEqual([a.appId, b.appId].sort())
  expect(ta).not.toBe(tb)
  expect([await redis.get(tokenKey(a)), await redis.get(tokenKey(b))]).toEqual([ta, tb])
})

it.each([
  [
    'a refused secret (40125): B6006',
    { errcode: 40125, errmsg: 'invalid appsecret' },
    Err.WXOA_CREDENTIAL_INVALID,
  ],
  [
    'an answer without a usable token: B6001',
    { access_token: 'has space', expires_in: 7200 },
    Err.WXOA_UPSTREAM,
  ],
  ['an answer without a token: B6001', { expires_in: 7200 }, Err.WXOA_UPSTREAM],
])('%s; nothing cached, the next request asks again', async (_, answer, err) => {
  const a = accounts[8]!
  stableAnswers.set(a.appId, answer)
  try {
    for (let i = 0; i < 2; i++) await expect(getToken(a)).rejects.toMatchObject({ err })
  } finally {
    stableAnswers.delete(a.appId)
  }
  expect(stableCalls()).toHaveLength(2)
  expect(await redis.exists(tokenKey(a))).toBe(0)
})

it('drop forgets the cached token', async () => {
  const a = accounts[0]!
  expect(await redis.exists(tokenKey(a))).toBe(1)
  await dropToken(a.id)
  expect(await redis.exists(tokenKey(a))).toBe(0)
})

it('an AppID deleted and added again as another account never gets the old token nor joins its request', async () => {
  const old = await account(30)
  const first = await getToken(old)
  expect(await redis.get(tokenKey(old))).toBe(first)
  // deleted behind the service's back: its cached token is still there
  await ds.query('UPDATE wxoa_account SET deleted_at = NOW(3) WHERE id = ?', [old.id])
  const again = await account(30, {
    label: 'token-e2e-30-again',
    callback_key: 'tokene2e30again'.padEnd(22, 'k'),
  })
  accounts.push(old, again)
  expect(again.appId).toBe(old.appId)
  expect(again.id).not.toBe(old.id)
  sent = []
  const token = await getToken(again)
  expect(token).not.toBe(first)
  expect(stableCalls()).toHaveLength(1)
  expect(await redis.get(tokenKey(again))).toBe(token)
  // a request of the deleted account in flight is not the new account's: each has its own
  await redis.unlink([tokenKey(old), tokenKey(again)])
  sent = []
  const [gone, live] = await Promise.allSettled([getToken(old), getToken(again)])
  expect(gone).toMatchObject({ status: 'rejected', reason: { err: Err.NOT_FOUND } })
  expect(live).toMatchObject({
    status: 'fulfilled',
    value: expect.stringMatching(new RegExp(`^${TOKEN}`)),
  })
  expect(stableCalls()).toHaveLength(1)
})

it('no token for a deleted account or a caller of another AppID: 404, nothing sent or cached', async () => {
  const gone = accounts[4]!
  await ds.query('UPDATE wxoa_account SET deleted_at = NOW(3) WHERE id = ?', [gone.id])
  await expect(getToken(gone)).rejects.toMatchObject({ err: Err.NOT_FOUND })
  const other = { ...accounts[5]!, appId: accounts[0]!.appId }
  await redis.unlink(tokenKey(other))
  await expect(getToken(other)).rejects.toMatchObject({ err: Err.NOT_FOUND })
  expect(sent).toEqual([])
  expect(await redis.exists([tokenKey(gone), tokenKey(other)])).toBe(0)
})

it('every request of this spec: the secret only in stable_token bodies (force_refresh false), the token only in URLs; no log carries either', () => {
  const stable = everything.filter((s) => s.path === STABLE)
  expect(stable.length).toBeGreaterThanOrEqual(5)
  const appIds = accounts.map((a) => a.appId)
  for (const s of stable) {
    expect([...s.query.keys()]).toEqual([])
    const body = JSON.parse(s.body) as { appid: string }
    expect(appIds).toContain(body.appid)
    expect(body).toEqual({
      grant_type: 'client_credential',
      appid: body.appid,
      secret: SECRET,
      force_refresh: false,
    })
  }
  for (const s of everything.filter((s) => s.path !== STABLE)) {
    expect(`${s.query}${s.body}`).not.toContain(SECRET)
    expect(s.body).not.toContain(TOKEN)
    expect(s.query.get('access_token')).toMatch(new RegExp(`^${TOKEN}`))
  }
  expect(JSON.stringify(logged)).not.toContain(SECRET)
  expect(JSON.stringify(logged)).not.toContain(TOKEN)
})
