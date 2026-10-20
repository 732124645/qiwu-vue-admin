// WeChat Official Account push callback (see docs/design-notes.md#wxoa). Every request is built and
// signed here, independently of the server's own helpers: GET echoes echostr once `signature` holds (in
// every mode); a plain POST is checked by `signature` and its body bound to the timestamp and nonce, a
// compat or secure one needs `encrypt_type=aes` and `Encrypt` under `msg_signature`; failures (and a 400
// or 413 before the signature is known) are counted per IP and account, per IP for unknown keys, 429
// past 120 in a minute; a push is stored once, with its fan row in the same transaction, answered by a
// rule (encrypted in compat and secure mode) or `success`; nothing on the request path calls WeChat and
// only new rows reach the inbound hub. Accounts and rules are written straight into the tables.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Logger } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { XMLParser } from 'fast-xml-parser'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AppConfigService } from '../../src/core/config/config.module.js'
import { SecretBox } from '../../src/core/crypto/secret-box.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow as insertRowRaw, type Row } from '../../src/db/seeds/upsert.js'
import { WxoaCallbackService } from '../../src/modules/platform/wxoa/callback/callback.service.js'
import { WxoaReplyMatcher } from '../../src/modules/platform/wxoa/callback/reply-matcher.js'
import { WxoaGateway } from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import {
  type WxoaInbound,
  WxoaInboundHub,
} from '../../src/modules/platform/wxoa/core/wxoa-inbound-hub.js'
import { fakeWxoaGateway } from '../fixtures/wxoa/fake-gateway.js'
import { cleanRedis } from '../setup/redis.js'
import { inTenant1 } from '../setup/tenants.js'
const insertRow = (...args: Parameters<typeof insertRowRaw>) =>
  inTenant1(() => insertRowRaw(...args))

const PREFIX = 'e2e-wxoa-callback-'
const URL = '/api/wxoa/callback'
const fake = fakeWxoaGateway()

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let box: SecretBox
let service: WxoaCallbackService
/** the hub's own emit, its handlers included (the spy below only records) */
let realEmit: (row: WxoaInbound) => Promise<void>
/** rows the inbound hub was given (its handlers do not run here) */
const emitted: WxoaInbound[] = []
const accountIds: number[] = []

interface Acc {
  id: number
  key: string
  token: string
  appId: string
  /** the AES key (compat and secure) */
  aes?: Buffer
}

let seq = 0
const unique = () => `${PREFIX}${++seq}`
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const alnum = (n: number) => Array.from(randomBytes(n), (b) => ALNUM[b % ALNUM.length]).join('')
const fan = () => `o${alnum(27)}`
const msgId = () => String(Date.now() * 1000 + ++seq)
const nonce = () => `${Date.now()}${++seq}`
const seconds = () => Math.floor(Date.now() / 1000)
let ipSeq = 0
/** A fresh source address: every request of a spec gets its own unless it shares one on purpose. */
const nextIp = () => `10.77.${(++ipSeq >> 8) & 255}.${ipSeq & 255}`

async function account(mode: 'plain' | 'compat' | 'secure' = 'plain', over: Row = {}) {
  const token = alnum(16)
  const aesKey = alnum(43)
  const appId = `wx${randomBytes(8).toString('hex')}`
  const key = randomBytes(16).toString('base64url')
  const id = await insertRow(ds.manager, 'wxoa_account', {
    label: unique(),
    app_id: appId,
    account_kind: mode === 'plain' ? 'sandbox' : 'service',
    crypto_mode: mode,
    app_secret_enc: box.encrypt('0'.repeat(32)),
    push_token_enc: box.encrypt(token),
    aes_key_enc: mode === 'plain' ? null : box.encrypt(aesKey),
    callback_key: key,
    ...over,
  })
  accountIds.push(id)
  const acc: Acc = { id, key, token, appId }
  if (mode !== 'plain') acc.aes = Buffer.from(`${aesKey}=`, 'base64')
  return acc
}

const rule = (accountId: number, over: Row) =>
  insertRow(ds.manager, 'wxoa_reply_rule', {
    account_id: accountId,
    name: unique(),
    trigger_kind: 'keyword',
    reply_kind: 'text',
    reply_body: { content: 'unused' },
    ...over,
  })
const textRule = (accountId: number, content: string, over: Row) =>
  rule(accountId, { reply_body: { content }, ...over })

// ---- signing and encryption, written from WeChat's description ----

const sha1 = (...parts: string[]) =>
  createHash('sha1').update(parts.toSorted().join('')).digest('hex')

function encrypt(acc: Acc, message: string, appId = acc.appId): string {
  const msg = Buffer.from(message)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(msg.length)
  const plain = Buffer.concat([randomBytes(16), size, msg, Buffer.from(appId)])
  const pad = 32 - (plain.length % 32)
  const cipher = createCipheriv('aes-256-cbc', acc.aes!, acc.aes!.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([
    cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])),
    cipher.final(),
  ]).toString('base64')
}

function decrypt(acc: Acc, b64: string): string {
  const decipher = createDecipheriv('aes-256-cbc', acc.aes!, acc.aes!.subarray(0, 16))
  decipher.setAutoPadding(false)
  const full = Buffer.concat([decipher.update(Buffer.from(b64, 'base64')), decipher.final()])
  const plain = full.subarray(0, full.length - full.at(-1)!)
  const size = plain.readUInt32BE(16)
  expect(plain.subarray(20 + size).toString()).toBe(acc.appId)
  return plain.subarray(20, 20 + size).toString()
}

// ---- push bodies ----

const cdata = (s: string) => `<![CDATA[${s}]]>`
function xml(openId: string, msgType: string, fields: Record<string, string>, time = seconds()) {
  const rest = Object.entries(fields)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('')
  return `<xml><ToUserName>${cdata('gh_test')}</ToUserName><FromUserName>${cdata(openId)}</FromUserName><CreateTime>${time}</CreateTime><MsgType>${cdata(msgType)}</MsgType>${rest}</xml>`
}
const text = (openId: string, content: string, id = msgId()) =>
  xml(openId, 'text', { Content: cdata(content), MsgId: id })
const event = (
  openId: string,
  name: string,
  key?: string,
  extra: Record<string, string> = {},
  time?: number,
) =>
  xml(
    openId,
    'event',
    { Event: cdata(name), ...(key === undefined ? {} : { EventKey: cdata(key) }), ...extra },
    time,
  )

// ---- requests ----

interface Opts {
  ip?: string
  ts?: string
  nonce?: string
  /** query values replacing the signed ones */
  query?: Record<string, string>
  type?: string
}

const target = (acc: Acc | string) => `${URL}/${typeof acc === 'string' ? acc : acc.key}`

function post(acc: Acc | string, body: string, query: Record<string, string>, o: Opts) {
  return request(app.getHttpServer())
    .post(target(acc))
    .query(query)
    .set('X-Forwarded-For', o.ip ?? nextIp())
    .set('Content-Type', o.type ?? 'text/xml')
    .send(body)
}

/** A plain-mode push signed with the account's Token (`acc` may be a bare key). */
function plain(acc: Acc | string, body: string, o: Opts = {}, signer: Acc | null = null) {
  const ts = o.ts ?? String(seconds())
  const n = o.nonce ?? nonce()
  const token = (signer ?? (acc as Acc)).token ?? 'none'
  return post(
    acc,
    body,
    { signature: sha1(token, ts, n), timestamp: ts, nonce: n, openid: 'x', ...o.query },
    o,
  )
}

/** A compat / secure push: the message encrypted into `Encrypt` under `msg_signature`. */
function sealed(acc: Acc, message: string, o: Opts & { appId?: string } = {}) {
  const ts = o.ts ?? String(seconds())
  const n = o.nonce ?? nonce()
  const enc = encrypt(acc, message, o.appId)
  const body = `<xml><ToUserName>${cdata('gh_test')}</ToUserName><Encrypt>${cdata(enc)}</Encrypt></xml>`
  return post(
    acc,
    body,
    {
      signature: sha1(acc.token, ts, n),
      timestamp: ts,
      nonce: n,
      encrypt_type: 'aes',
      msg_signature: sha1(acc.token, ts, n, enc),
      ...o.query,
    },
    o,
  )
}

/** WeChat's URL check. */
function check(acc: Acc, echostr: string, o: Opts = {}) {
  const ts = o.ts ?? String(seconds())
  const n = o.nonce ?? nonce()
  return request(app.getHttpServer())
    .get(target(acc))
    .query({ signature: sha1(acc.token, ts, n), timestamp: ts, nonce: n, echostr, ...o.query })
    .set('X-Forwarded-For', o.ip ?? nextIp())
}

/** A POST without Content-Length (chunked), its status. */
function chunked(acc: Acc, body: Buffer, ip: string): Promise<number> {
  const ts = String(seconds())
  const n = nonce()
  const query = new URLSearchParams({ signature: sha1(acc.token, ts, n), timestamp: ts, nonce: n })
  const { port } = app.getHttpServer().address() as AddressInfo
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `${target(acc)}?${query}`,
        headers: { 'Content-Type': 'text/xml', 'X-Forwarded-For': ip },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode!)
      },
    )
    req.on('error', reject)
    for (let i = 0; i < body.length; i += 8192) req.write(body.subarray(i, i + 8192))
    req.end()
  })
}

const reader = new XMLParser({ parseTagValue: false })
/** The fields of a reply's `<xml>`. */
const replyOf = (res: request.Response): Record<string, unknown> => reader.parse(res.text).xml
/** The text a plain reply carries. */
const said = (res: request.Response) => (res.text === 'success' ? 'success' : replyOf(res).Content)

const messages = (accountId: number, openId?: string): Promise<Record<string, unknown>[]> =>
  ds.query(
    'SELECT * FROM wxoa_message WHERE account_id = ? AND (? IS NULL OR open_id = ?) AND deleted_at IS NULL ORDER BY id',
    [accountId, openId ?? null, openId ?? null],
  )
const inbound = async (accountId: number, openId?: string) =>
  (await messages(accountId, openId)).filter((m) => m.direction === 'in')
const fanRow = async (accountId: number, openId: string) =>
  (
    await ds.query(
      'SELECT * FROM wxoa_fan WHERE account_id = ? AND open_id = ? AND deleted_at IS NULL',
      [accountId, openId],
    )
  )[0] as Record<string, unknown> | undefined
const failures = async (ip: string, accountId?: number) =>
  Number(
    await redis.get(
      accountId === undefined
        ? redisKey('wxoa', 'cb-fail', ip)
        : redisKey('wxoa', 'cb-fail', ip, accountId),
    ),
  )

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
  service = app.get(WxoaCallbackService)
  await cleanRedis(redis)
  // the handlers (profiles, counts, receipts) are their modules' own specs: here only what reaches them
  const hub = app.get(WxoaInboundHub)
  realEmit = hub.emit.bind(hub)
  vi.spyOn(app.get(WxoaInboundHub), 'emit').mockImplementation(async (row) => {
    emitted.push(row)
  })
})

afterAll(async () => {
  if (ds && accountIds.length) {
    for (const table of ['wxoa_message', 'wxoa_fan', 'wxoa_reply_rule', 'wxoa_material'])
      // arch-allow: sql-concat table names are spec constants; ids bound
      await ds.query(`DELETE FROM ${table} WHERE account_id IN (?)`, [accountIds])
    await ds.query('DELETE FROM wxoa_account WHERE id IN (?)', [accountIds])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('URL check (GET)', () => {
  it('echoes echostr as plain text once signature holds, also for a secure-mode account', async () => {
    for (const acc of [await account(), await account('secure')]) {
      const res = await check(acc, 'echo-123').expect(200)
      expect(res.text).toBe('echo-123')
      expect(res.headers['content-type']).toMatch(/^text\/plain/)
      await check(acc, 'echo-123', { query: { signature: sha1('wrong', '1', '2') } }).expect(404)
    }
  })

  it('takes the nonce for 600 s: the same query posted with a body is refused', async () => {
    const acc = await account()
    const ts = String(seconds())
    const n = nonce()
    await check(acc, 'e', { ts, nonce: n }).expect(200)
    expect(await redis.ttl(redisKey('wxoa', 'nonce', acc.id, ts, n))).toBeGreaterThan(300)
    await plain(acc, text(fan(), 'hi'), { ts, nonce: n }).expect(404)
    expect(await inbound(acc.id)).toEqual([])
  })

  it('echoes up to 128 characters; a longer, empty or missing echostr is 404 and counted', async () => {
    const acc = await account()
    const ip = nextIp()
    const longest = alnum(128)
    expect((await check(acc, longest, { ip }).expect(200)).text).toBe(longest)
    await check(acc, alnum(129), { ip }).expect(404)
    await check(acc, '', { ip }).expect(404)
    const ts = String(seconds())
    const n = nonce()
    await request(app.getHttpServer())
      .get(target(acc))
      .query({ signature: sha1(acc.token, ts, n), timestamp: ts, nonce: n })
      .set('X-Forwarded-For', ip)
      .expect(404)
    expect(await failures(ip, acc.id)).toBe(3)
  })
})

describe('signature, time window and body binding', () => {
  it('a plain push binds its body to the timestamp and nonce for 600 s', async () => {
    const acc = await account()
    const ts = String(seconds())
    const n = nonce()
    const openId = fan()
    const body = text(openId, 'first')
    await plain(acc, body, { ts, nonce: n }).expect(200)
    expect(await redis.ttl(redisKey('wxoa', 'nonce', acc.id, ts, n))).toBeGreaterThan(300)
    // another body under the same signed query: someone who saw the query in a log
    await plain(acc, text(openId, 'forged'), { ts, nonce: n }).expect(404)
    // WeChat retrying the same body
    await plain(acc, body, { ts, nonce: n }).expect(200)
    expect((await inbound(acc.id)).map((m) => (m.payload as { Content: string }).Content)).toEqual([
      'first',
    ])
  })

  it('takes a timestamp 299 s ahead of the clock, refuses one 301 s behind or 310 s ahead', async () => {
    const acc = await account()
    // whole seconds, rounded down: a request seen later is only further behind
    const now = seconds()
    await plain(acc, text(fan(), 'ahead'), { ts: String(now + 299) }).expect(200)
    await plain(acc, text(fan(), 'late'), { ts: String(now - 301) }).expect(404)
    await plain(acc, text(fan(), 'early'), { ts: String(now + 310) }).expect(404)
    expect(await inbound(acc.id)).toHaveLength(1)
  })

  it('a bad signature, an unknown key, a disabled or deleted account and another account’s Token are 404', async () => {
    const acc = await account()
    const other = await account()
    const disabled = await account('plain', { enabled: 0 })
    const deleted = await account('plain', { deleted_at: new Date() })
    await plain(acc, text(fan(), 'x'), { query: { signature: sha1('nope', '1', '2') } }).expect(404)
    await plain(randomBytes(16).toString('base64url'), text(fan(), 'x'), {}, acc).expect(404)
    await plain(disabled, text(fan(), 'x')).expect(404)
    await plain(deleted, text(fan(), 'x')).expect(404)
    await plain(other, text(fan(), 'x'), {}, acc).expect(404)
    for (const a of [acc, other, disabled, deleted]) expect(await inbound(a.id)).toEqual([])
  })

  it('compat mode needs encrypt_type=aes and Encrypt: a plain body or a missing flag is 404', async () => {
    const acc = await account('compat')
    const body = text(fan(), 'plain in compat')
    await plain(acc, body).expect(404)
    const ts = String(seconds())
    const n = nonce()
    await plain(acc, body, {
      ts,
      nonce: n,
      query: { encrypt_type: 'aes', msg_signature: sha1(acc.token, ts, n) },
    }).expect(404)
    await sealed(acc, body, { query: { encrypt_type: '' } }).expect(404)
    await sealed(acc, body, { query: { msg_signature: sha1('wrong', '1', '2') } }).expect(404)
    // the message must carry the account's AppID
    await sealed(acc, body, { appId: 'wx0000000000000000' }).expect(404)
    expect(await inbound(acc.id)).toEqual([])
    await sealed(acc, body).expect(200)
    expect(await inbound(acc.id)).toHaveLength(1)
  })

  it('a sealed push holds its nonce: once the account is plain, its query with another body is 404', async () => {
    const acc = await account('compat')
    const ts = String(seconds())
    const n = nonce()
    const openId = fan()
    await sealed(acc, event(openId, 'subscribe'), { ts, nonce: n }).expect(200)
    expect(await redis.ttl(redisKey('wxoa', 'nonce', acc.id, ts, n))).toBeGreaterThan(300)
    await ds.query("UPDATE wxoa_account SET crypto_mode = 'plain' WHERE id = ?", [acc.id])
    await plain(acc, event(openId, 'unsubscribe'), { ts, nonce: n }).expect(404)
    expect(await inbound(acc.id)).toHaveLength(1)
    expect(await fanRow(acc.id, openId)).toMatchObject({ subscribed: 1, unsubscribed_at: null })
  })

  it('a secure-mode account refuses a plain push', async () => {
    const acc = await account('secure')
    await plain(acc, text(fan(), 'downgraded')).expect(404)
    expect(await inbound(acc.id)).toEqual([])
  })
})

describe('failure counting', () => {
  it('a malformed key is 404 without a lookup or a count', async () => {
    const lookup = vi.spyOn(service, 'findAccount')
    const ip = nextIp()
    try {
      for (const key of ['short', 'x'.repeat(23), `${'a'.repeat(21)}!`, `${'a'.repeat(21)}=`])
        await plain(key, text(fan(), 'x'), { ip }).expect(404)
      expect(lookup).not.toHaveBeenCalled()
      expect(await failures(ip)).toBe(0)
    } finally {
      lookup.mockRestore()
    }
  })

  it('121 bad signatures from one IP shut that IP out of that account only', async () => {
    const a = await account()
    const b = await account()
    const ip = nextIp()
    for (let i = 0; i < 121; i++)
      await plain(a, text(fan(), 'x'), { ip, query: { signature: sha1('bad', String(i)) } }).expect(
        404,
      )
    expect(await failures(ip, a.id)).toBe(121)
    // a one-minute window, never a lasting ban
    expect(await redis.ttl(redisKey('wxoa', 'cb-fail', ip, a.id))).toBeGreaterThan(0)
    expect(await redis.ttl(redisKey('wxoa', 'cb-fail', ip, a.id))).toBeLessThanOrEqual(60)
    // signed or not, past the limit: not even checked
    await plain(a, text(fan(), 'x'), { ip }).expect(429)
    await plain(b, text(fan(), 'x'), { ip }).expect(200)
    await plain(a, text(fan(), 'x'), { ip: nextIp() }).expect(200)
    expect(await failures(ip, a.id)).toBe(121)
  })

  it('unknown keys count per IP: past 120 that IP gets 429 for any unknown key', async () => {
    const acc = await account()
    const ip = nextIp()
    for (let i = 0; i < 121; i++)
      await plain(randomBytes(16).toString('base64url'), text(fan(), 'x'), { ip }, acc).expect(404)
    await plain(randomBytes(16).toString('base64url'), text(fan(), 'x'), { ip }, acc).expect(429)
    expect(await redis.ttl(redisKey('wxoa', 'cb-fail', ip))).toBeGreaterThan(0)
    expect(await redis.ttl(redisKey('wxoa', 'cb-fail', ip))).toBeLessThanOrEqual(60)
    await plain(acc, text(fan(), 'x'), { ip }).expect(200)
  })

  it('a 400 or 413 before the signature is known counts', async () => {
    const acc = await account()
    const compat = await account('compat')
    const ip = nextIp()
    await plain(acc, 'x'.repeat(64 * 1024 + 1), { ip }).expect(413)
    expect(await failures(ip, acc.id)).toBe(1)
    expect(await chunked(acc, Buffer.alloc(64 * 1024 + 1, 'x'), ip)).toBe(413)
    expect(await failures(ip, acc.id)).toBe(2)
    // a JSON body: the global parser has read it
    await plain(acc, JSON.stringify({ a: 1 }), { ip, type: 'application/json' }).expect(400)
    expect(await failures(ip, acc.id)).toBe(3)
    // compat: the body must parse before Encrypt is known
    await plain(compat, '<xml><Encrypt>', { ip }).expect(400)
    await plain(compat, '<!DOCTYPE x><xml><Encrypt>e</Encrypt></xml>', { ip }).expect(400)
    expect(await failures(ip, compat.id)).toBe(2)
    expect(await inbound(acc.id)).toEqual([])
  })

  it('signed pushes are never counted: 125 in a row all pass', async () => {
    const acc = await account()
    const ip = nextIp()
    const openId = fan()
    for (let i = 0; i < 125; i++)
      await plain(acc, event(openId, 'LOCATION', undefined, { Latitude: '1', Longitude: '2' }), {
        ip,
      }).expect(200)
    expect(await failures(ip, acc.id)).toBe(0)
  })
})

describe('body limits and parsing', () => {
  it('a 64 KiB body passes, one byte more is 413, streamed or not', async () => {
    const acc = await account()
    const openId = fan()
    const shell = text(openId, '')
    const body = shell.replace(
      '<![CDATA[]]>',
      cdata('y'.repeat(64 * 1024 - Buffer.byteLength(shell))),
    )
    expect(Buffer.byteLength(body)).toBe(64 * 1024)
    await plain(acc, body).expect(200)
    await plain(acc, `${body} `).expect(413)
    expect(await chunked(acc, Buffer.from(`${body} `), nextIp())).toBe(413)
    expect(await inbound(acc.id)).toHaveLength(1)
  })

  it('a DOCTYPE, a body that is not XML and a JSON body are 400', async () => {
    const acc = await account()
    const openId = fan()
    await plain(acc, `<!DOCTYPE xml [<!ENTITY e "x">]>${text(openId, '&e;')}`).expect(400)
    await plain(acc, 'not xml').expect(400)
    await plain(acc, JSON.stringify({ x: 1 }), { type: 'application/json' }).expect(400)
    expect(await inbound(acc.id)).toEqual([])
  })

  it('a text of about 20 KiB is stored with its payload cut and marked', async () => {
    const acc = await account()
    const openId = fan()
    await plain(acc, text(openId, '长'.repeat(7000))).expect(200)
    const [row] = await inbound(acc.id)
    const payload = row!.payload as { Content: string; truncated: boolean }
    expect(payload.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(16 * 1024)
  })

  it('a 64-bit MsgId is kept exactly', async () => {
    const acc = await account()
    const openId = fan()
    await plain(acc, text(openId, 'big', '18446744073709551615')).expect(200)
    const [row] = await inbound(acc.id)
    expect(row!.wx_msg_id).toBe('18446744073709551615')
    expect(emitted.find((e) => e.id === Number(row!.id))?.wxMsgId).toBe('18446744073709551615')
  })
})

describe('storing once, fans and the hub', () => {
  it('a MsgId seen before is stored once and handed to the hub once', async () => {
    const acc = await account()
    await textRule(acc.id, 'pong', { match_mode: 'exact', keywords: ['ping'] })
    const openId = fan()
    const body = text(openId, 'ping')
    const before = emitted.length
    const first = await plain(acc, body).expect(200)
    expect(said(first)).toBe('pong')
    expect(said(await plain(acc, body).expect(200))).toBe('success')
    // neither a failed nor a location push reaches the hub
    await plain(acc, body, { query: { signature: 'bad' } }).expect(404)
    await plain(acc, event(openId, 'LOCATION', undefined, { Latitude: '1' })).expect(200)
    const rows = await inbound(acc.id)
    expect(rows).toHaveLength(1)
    expect(emitted.slice(before)).toEqual([
      expect.objectContaining({
        id: Number(rows[0]!.id),
        accountId: acc.id,
        openId,
        msgKind: 'text',
      }),
    ])
    // one passive reply, recorded as the rule's
    const out = (await messages(acc.id)).filter((m) => m.direction === 'out')
    expect(out).toEqual([
      expect.objectContaining({ channel: 'passive', msg_kind: 'text', dedup_key: null }),
    ])
  })

  it('two template receipts to one fan in one second, different MsgID, are both stored', async () => {
    const acc = await account()
    const openId = fan()
    const t = seconds()
    for (const id of ['2001', '2002'])
      await plain(
        acc,
        event(
          openId,
          'TEMPLATESENDJOBFINISH',
          undefined,
          { MsgID: id, Status: cdata('success') },
          t,
        ),
      ).expect(200)
    expect((await inbound(acc.id)).map((m) => m.wx_msg_id)).toEqual(['2001', '2002'])
    expect(await fanRow(acc.id, openId)).toBeUndefined()
  })

  it('two notice popups in one second with different templates are both stored, a resend once', async () => {
    const acc = await account()
    const openId = fan()
    const t = seconds()
    const popup = (templateId: string) =>
      event(
        openId,
        'subscribe_msg_popup_event',
        undefined,
        {
          SubscribeMsgPopupEvent: `<List><TemplateId>${cdata(templateId)}</TemplateId><SubscribeStatusString>${cdata('accept')}</SubscribeStatusString><PopupScene>2</PopupScene></List>`,
        },
        t,
      )
    await plain(acc, popup('tpl-a')).expect(200)
    await plain(acc, popup('tpl-b')).expect(200)
    await plain(acc, popup('tpl-a')).expect(200)
    expect(
      (await inbound(acc.id)).map(
        (m) =>
          (m.payload as { SubscribeMsgPopupEvent: { List: { TemplateId: string }[] } })
            .SubscribeMsgPopupEvent.List[0]!.TemplateId,
      ),
    ).toEqual(['tpl-a', 'tpl-b'])
  })

  it('a notice sent event settles the outbound notice row with its MsgID and ErrorCode', async () => {
    const acc = await account()
    const openId = fan()
    const out = await insertRow(ds.manager, 'wxoa_message', {
      account_id: acc.id,
      open_id: openId,
      direction: 'out',
      channel: 'notice',
      msg_kind: 'subscribe',
      payload: { templateId: 'tpl-sent', data: {}, url: null },
      send_state: 'sent',
      errcode: 0,
      occurred_at: new Date(),
    })
    const before = emitted.length
    await plain(
      acc,
      event(openId, 'subscribe_msg_sent_event', undefined, {
        SubscribeMsgSentEvent: `<List><TemplateId>${cdata('tpl-sent')}</TemplateId><MsgID>1700827132819554304</MsgID><ErrorCode>43101</ErrorCode><ErrorStatus>${cdata('user refuse to accept the msg')}</ErrorStatus></List>`,
      }),
    ).expect(200)
    const [row] = emitted.slice(before)
    await realEmit(row!)
    const [settled] = await ds.query(
      'SELECT wx_msg_id, errcode, send_state FROM wxoa_message WHERE id = ?',
      [out],
    )
    expect(settled).toEqual({
      wx_msg_id: '1700827132819554304',
      errcode: 43101,
      send_state: 'failed',
    })
  })

  it('two publish receipts in one second, different publish_id, are both stored', async () => {
    const acc = await account()
    const t = seconds()
    for (const id of ['6001', '6002'])
      await plain(
        acc,
        event(
          'mphelper',
          'PUBLISHJOBFINISH',
          undefined,
          { PublishEventInfo: `<publish_id>${id}</publish_id><publish_status>0</publish_status>` },
          t,
        ),
      ).expect(200)
    expect(
      (await inbound(acc.id)).map(
        (m) =>
          (m.payload as { PublishEventInfo: { publish_id: string } }).PublishEventInfo.publish_id,
      ),
    ).toEqual(['6001', '6002'])
    expect(await fanRow(acc.id, 'mphelper')).toBeUndefined()
  })

  it('a mass-send receipt (from mphelper) is stored without a fan row', async () => {
    const acc = await account()
    await plain(
      acc,
      event('mphelper', 'MASSSENDJOBFINISH', undefined, {
        MsgID: '3001',
        Status: cdata('send success'),
        TotalCount: '10',
        CopyrightCheckResult: '<Count>0</Count><CheckState>1</CheckState>',
      }),
    ).expect(200)
    expect(await inbound(acc.id)).toHaveLength(1)
    expect(await fanRow(acc.id, 'mphelper')).toBeUndefined()
  })

  it('a location report is answered but neither stored nor handed on', async () => {
    const acc = await account()
    await rule(acc.id, { trigger_kind: 'default', reply_body: { content: 'default' } })
    const openId = fan()
    const res = await plain(
      acc,
      event(openId, 'LOCATION', undefined, { Latitude: '1', Longitude: '2', Precision: '3' }),
    ).expect(200)
    expect(res.text).toBe('success')
    expect(await messages(acc.id)).toEqual([])
    expect(await fanRow(acc.id, openId)).toBeUndefined()
    expect(emitted.filter((e) => e.accountId === acc.id)).toEqual([])
  })

  it('fan rows: subscribe, unsubscribe, messages and the events that open the window', async () => {
    const acc = await account()
    const [a, b, c, d, e] = [fan(), fan(), fan(), fan(), fan()]
    await plain(acc, event(a, 'subscribe', 'qrscene_spring')).expect(200)
    let row = await fanRow(acc.id, a)
    expect(row).toMatchObject({ subscribed: 1, qr_scene: 'spring', unsubscribed_at: null })
    expect(row!.subscribed_at).not.toBeNull()
    expect(row!.last_event_at).not.toBeNull()
    const subscribedAt = row!.subscribed_at
    await plain(acc, event(a, 'unsubscribe')).expect(200)
    row = await fanRow(acc.id, a)
    expect(row).toMatchObject({ subscribed: 0, subscribed_at: subscribedAt, qr_scene: 'spring' })
    expect(row!.unsubscribed_at).not.toBeNull()

    await plain(acc, text(b, 'hello')).expect(200)
    expect(await fanRow(acc.id, b)).toMatchObject({ subscribed: 1, last_event_at: null })
    expect((await fanRow(acc.id, b))!.last_inbound_at).not.toBeNull()

    await plain(acc, event(c, 'CLICK', 'menu-1')).expect(200)
    expect((await fanRow(acc.id, c))!.last_event_at).not.toBeNull()
    expect((await fanRow(acc.id, c))!.last_inbound_at).toBeNull()
    // VIEW and view_miniprogram write the fan but open no window
    await plain(acc, event(d, 'VIEW', 'https://example.com/a', { MenuId: '1' })).expect(200)
    await plain(acc, event(e, 'view_miniprogram', 'pages/index', { MenuId: '1' })).expect(200)
    for (const openId of [d, e])
      expect(await fanRow(acc.id, openId)).toMatchObject({
        subscribed: 1,
        last_event_at: null,
        last_inbound_at: null,
      })
  })

  it('the fan row and the message are one transaction: a failed fan write stores nothing', async () => {
    const acc = await account()
    const openId = fan()
    const body = text(openId, 'atomic')
    const broken = vi
      .spyOn(service, 'upsertFan')
      .mockRejectedValueOnce(new Error('fan write failed'))
    try {
      await plain(acc, body).expect(500)
    } finally {
      broken.mockRestore()
    }
    expect(await inbound(acc.id)).toEqual([])
    await plain(acc, body).expect(200)
    expect(await inbound(acc.id)).toHaveLength(1)
    expect(await fanRow(acc.id, openId)).toBeDefined()
  })

  it('an unknown event with nested elements is stored as is, without a fan row or a rule', async () => {
    const acc = await account()
    await rule(acc.id, { trigger_kind: 'default', reply_body: { content: 'default' } })
    const openId = fan()
    const res = await plain(
      acc,
      event(openId, 'user_info_modified', undefined, {
        UserInfo: '<Nested><Deep>1</Deep></Nested>',
        MsgID: '4001',
      }),
    ).expect(200)
    expect(res.text).toBe('success')
    const rows = await messages(acc.id)
    expect(rows).toEqual([
      expect.objectContaining({
        direction: 'in',
        msg_kind: 'event',
        event_kind: 'user_info_modified',
        wx_msg_id: '4001',
        payload: {},
      }),
    ])
    expect(await fanRow(acc.id, openId)).toBeUndefined()
  })

  it('two unknown messages of one fan in one second with different MsgIds are both stored', async () => {
    const acc = await account()
    await rule(acc.id, { trigger_kind: 'default', reply_body: { content: 'default' } })
    const openId = fan()
    const t = seconds()
    for (const id of ['5001', '5002'])
      expect(
        (
          await plain(
            acc,
            xml(openId, 'miniprogrampage', { Title: cdata('t'), MsgId: id }, t),
          ).expect(200)
        ).text,
      ).toBe('success')
    expect((await inbound(acc.id)).map((m) => m.wx_msg_id)).toEqual(['5001', '5002'])
    expect(await fanRow(acc.id, openId)).toBeUndefined()
  })
})

describe('passive replies', () => {
  it('subscribe, scan-subscribe, SCAN and CLICK pick their rules; a scan rule beats the subscribe rule', async () => {
    const acc = await account()
    await textRule(acc.id, 'welcome', { trigger_kind: 'subscribe' })
    await textRule(acc.id, 'spring offer', { trigger_kind: 'scan', event_key: 'spring' })
    await textRule(acc.id, 'about us', { trigger_kind: 'click', event_key: 'about' })
    await textRule(acc.id, '关于栖梧', { trigger_kind: 'click', event_key: '菜单·关于' })
    const reply = async (body: string) => said(await plain(acc, body).expect(200))
    expect(await reply(event(fan(), 'subscribe', 'qrscene_spring', { Ticket: 't' }))).toBe(
      'spring offer',
    )
    expect(await reply(event(fan(), 'subscribe', 'qrscene_winter', { Ticket: 't' }))).toBe(
      'welcome',
    )
    expect(await reply(event(fan(), 'subscribe'))).toBe('welcome')
    expect(await reply(event(fan(), 'SCAN', 'spring', { Ticket: 't' }))).toBe('spring offer')
    expect(await reply(event(fan(), 'SCAN', 'winter', { Ticket: 't' }))).toBe('success')
    expect(await reply(event(fan(), 'CLICK', 'about'))).toBe('about us')
    expect(await reply(event(fan(), 'CLICK', '菜单·关于'))).toBe('关于栖梧')
    expect(await reply(event(fan(), 'CLICK', 'ABOUT'))).toBe('success')
  })

  it('keywords: priority first, then exact before contains, then id; folded; the default for the rest', async () => {
    const acc = await account()
    await textRule(acc.id, 'contains pri', { match_mode: 'contains', keywords: ['pri'] })
    await textRule(acc.id, 'exact price', { match_mode: 'exact', keywords: ['other', 'Price'] })
    await textRule(acc.id, 'contains dea p3', {
      match_mode: 'contains',
      keywords: ['dea'],
      priority: 3,
    })
    await textRule(acc.id, 'exact deal', { match_mode: 'exact', keywords: ['deal'] })
    await textRule(acc.id, 'café', { match_mode: 'exact', keywords: ['café'] })
    await textRule(acc.id, 'disabled', { match_mode: 'exact', keywords: ['off'], enabled: 0 })
    await textRule(acc.id, 'fallback', { trigger_kind: 'default' })
    const reply = async (body: string) => said(await plain(acc, body).expect(200))
    expect(await reply(text(fan(), '  PRICE '))).toBe('exact price')
    expect(await reply(text(fan(), 'priceless'))).toBe('contains pri')
    expect(await reply(text(fan(), 'deal'))).toBe('contains dea p3')
    expect(await reply(text(fan(), 'Café'))).toBe('café')
    expect(await reply(text(fan(), 'off'))).toBe('fallback')
    expect(
      await reply(
        xml(fan(), 'voice', {
          MediaId: cdata('m'),
          Format: cdata('amr'),
          Recognition: cdata('price'),
          MsgId: msgId(),
        }),
      ),
    ).toBe('exact price')
    expect(
      await reply(
        xml(fan(), 'image', {
          PicUrl: cdata('https://mmbiz.qpic.cn/a'),
          MediaId: cdata('m'),
          MsgId: msgId(),
        }),
      ),
    ).toBe('fallback')
    // events never get the default rule
    expect(await reply(event(fan(), 'VIEW', 'https://example.com', { MenuId: '1' }))).toBe(
      'success',
    )
  })

  it('no rule answers success; a media rule replies with the account’s own material only', async () => {
    const bare = await account()
    expect(said(await plain(bare, text(fan(), 'anything')).expect(200))).toBe('success')
    const acc = await account()
    const other = await account()
    const own = await insertRow(ds.manager, 'wxoa_material', {
      account_id: acc.id,
      media_kind: 'image',
      media_id: 'own-media-id',
      origin: 'pulled',
    })
    const foreign = await insertRow(ds.manager, 'wxoa_material', {
      account_id: other.id,
      media_kind: 'image',
      media_id: 'foreign-media-id',
      origin: 'pulled',
    })
    const image = (keyword: string, materialId: number) =>
      rule(acc.id, {
        match_mode: 'exact',
        keywords: [keyword],
        reply_kind: 'image',
        reply_body: {},
        material_id: materialId,
      })
    await image('mine', own)
    await image('theirs', foreign)
    const res = await plain(acc, text(fan(), 'mine')).expect(200)
    expect(replyOf(res)).toMatchObject({ MsgType: 'image', Image: { MediaId: 'own-media-id' } })
    expect((await plain(acc, text(fan(), 'theirs')).expect(200)).text).toBe('success')
  })

  it('a ]]> in a reply is split across CDATA sections', async () => {
    const acc = await account()
    await textRule(acc.id, 'a]]>b', { match_mode: 'exact', keywords: ['cdata'] })
    const openId = fan()
    const res = await plain(acc, text(openId, 'cdata')).expect(200)
    expect(res.text).toContain('<![CDATA[a]]]]><![CDATA[>b]]>')
    expect(replyOf(res)).toMatchObject({ ToUserName: openId, Content: 'a]]>b' })
  })

  it('compat and secure accounts get encrypted replies carrying the push’s nonce', async () => {
    for (const mode of ['compat', 'secure'] as const) {
      const acc = await account(mode)
      await textRule(acc.id, `reply in ${mode}`, { match_mode: 'exact', keywords: ['hi'] })
      const n = nonce()
      const openId = fan()
      const res = await sealed(acc, text(openId, 'hi'), { nonce: n }).expect(200)
      const sealedReply = replyOf(res) as Record<string, string>
      expect(Object.keys(sealedReply).toSorted()).toEqual([
        'Encrypt',
        'MsgSignature',
        'Nonce',
        'TimeStamp',
      ])
      expect(sealedReply.Nonce).toBe(n)
      expect(sealedReply.MsgSignature).toBe(
        sha1(acc.token, String(sealedReply.TimeStamp), n, sealedReply.Encrypt),
      )
      const inner = reader.parse(decrypt(acc, sealedReply.Encrypt)).xml
      expect(inner).toMatchObject({
        ToUserName: openId,
        MsgType: 'text',
        Content: `reply in ${mode}`,
      })
      expect(await inbound(acc.id)).toHaveLength(1)
    }
  })
})

describe('the account and the surroundings', () => {
  it('last_push_at is written for a signed push, then not again within 60 s', async () => {
    const acc = await account()
    const stamp = async () =>
      (await ds.query('SELECT last_push_at FROM wxoa_account WHERE id = ?', [acc.id]))[0]
        .last_push_at as Date | null
    await plain(acc, text(fan(), 'x'), { query: { signature: 'bad' } }).expect(404)
    expect(await stamp()).toBeNull()
    await plain(acc, text(fan(), 'x')).expect(200)
    expect(await stamp()).not.toBeNull()
    await ds.query(
      'UPDATE wxoa_account SET last_push_at = NOW(3) - INTERVAL 30 SECOND WHERE id = ?',
      [acc.id],
    )
    const recent = await stamp()
    await plain(acc, text(fan(), 'x')).expect(200)
    expect(await stamp()).toEqual(recent)
    await ds.query(
      'UPDATE wxoa_account SET last_push_at = NOW(3) - INTERVAL 90 SECOND WHERE id = ?',
      [acc.id],
    )
    await plain(acc, text(fan(), 'x')).expect(200)
    expect(Date.now() - (await stamp())!.getTime()).toBeLessThan(10_000)
  })

  it('past the 4 s budget the push is answered success, still stored and handed on, no reply recorded', async () => {
    const acc = await account()
    await textRule(acc.id, 'too late', { match_mode: 'exact', keywords: ['slow'] })
    const matcher = app.get(WxoaReplyMatcher)
    const match = matcher.match.bind(matcher)
    const slow = vi.spyOn(matcher, 'match').mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 4_300))
      return match(...args)
    })
    try {
      const before = emitted.length
      expect((await plain(acc, text(fan(), 'slow')).expect(200)).text).toBe('success')
      // the handling goes on after the answer and still reaches the hub
      await vi.waitFor(() => expect(emitted.slice(before)).toHaveLength(1), {
        timeout: 3_000,
        interval: 50,
      })
    } finally {
      slow.mockRestore()
    }
    expect(await inbound(acc.id)).toHaveLength(1)
    expect((await messages(acc.id)).filter((m) => m.direction === 'out')).toEqual([])
  })

  it('a reply whose outbound row fails to write still goes out and the push still reaches the hub', async () => {
    const acc = await account()
    await textRule(acc.id, 'pong', { match_mode: 'exact', keywords: ['ping'] })
    const broken = vi.spyOn(service, 'record').mockRejectedValueOnce(new Error('record failed'))
    try {
      expect(said(await plain(acc, text(fan(), 'ping')).expect(200))).toBe('pong')
    } finally {
      broken.mockRestore()
    }
    const rows = await inbound(acc.id)
    expect(rows).toHaveLength(1)
    expect(emitted.filter((e) => e.accountId === acc.id)).toEqual([
      expect.objectContaining({ id: Number(rows[0]!.id) }),
    ])
  })

  it('a stored push whose rule lookup fails is answered success and still reaches the hub', async () => {
    const acc = await account()
    await textRule(acc.id, 'pong', { match_mode: 'exact', keywords: ['ping'] })
    const broken = vi
      .spyOn(app.get(WxoaReplyMatcher), 'match')
      .mockRejectedValueOnce(new Error('connection lost'))
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    try {
      expect((await plain(acc, text(fan(), 'ping')).expect(200)).text).toBe('success')
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('connection lost'))
    } finally {
      broken.mockRestore()
      warned.mockRestore()
    }
    const rows = await inbound(acc.id)
    expect(rows).toHaveLength(1)
    await vi.waitFor(() =>
      expect(emitted.filter((e) => e.accountId === acc.id)).toEqual([
        expect.objectContaining({ id: Number(rows[0]!.id) }),
      ]),
    )
    expect((await messages(acc.id)).filter((m) => m.direction === 'out')).toEqual([])
  })

  it('the reply is recorded once it went out: a slow write does not hold the answer back', async () => {
    const acc = await account()
    await textRule(acc.id, 'pong', { match_mode: 'exact', keywords: ['ping'] })
    const record = service.record.bind(service)
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = vi.spyOn(service, 'record').mockImplementation(async (...args) => {
      await held
      return record(...args)
    })
    try {
      expect(said(await plain(acc, text(fan(), 'ping')).expect(200))).toBe('pong')
      expect(slow).toHaveBeenCalledOnce()
    } finally {
      release()
      slow.mockRestore()
    }
    const outbound = async () => (await messages(acc.id)).filter((m) => m.direction === 'out')
    await vi.waitFor(async () =>
      expect(await outbound()).toEqual([
        expect.objectContaining({ channel: 'passive', send_state: 'sent' }),
      ]),
    )
    await vi.waitFor(() => expect(emitted.filter((e) => e.accountId === acc.id)).toHaveLength(1))
  })

  it('demo mode refuses the POST (403) before anything is stored', async () => {
    const acc = await account()
    const cfg = app.get(AppConfigService)
    const get = cfg.get.bind(cfg)
    const demo = vi
      .spyOn(cfg, 'get')
      .mockImplementation(((key: string) =>
        key === 'APP_DEMO_MODE' ? true : get(key as never)) as typeof cfg.get)
    try {
      await plain(acc, text(fan(), 'x')).expect(403)
    } finally {
      demo.mockRestore()
    }
    expect(await inbound(acc.id)).toEqual([])
  })

  it('nothing on the request path called WeChat', () => {
    expect(fake.calls).toEqual([])
  })
})
