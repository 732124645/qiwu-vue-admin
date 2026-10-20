// Official Accounts with tenants (see docs/design-notes.md#wxoa and #tenancy), the switch on, between the
// default tenant (A) and tenant B, plus a disabled tenant C and a tenant D whose package leaves the module
// out. B's administrator naming A's account or any of A's rows gets 404 on every endpoint group, and
// WeChat is never called. A new account first proves its AppSecret by one token request (refused: no
// row, the AppID stays free); an AppID taken in one tenant is 409 in another, and the platform's tenant
// list finds the tenant holding it. A push to B's account lands in B (message, fan, auto reply); the
// callback of C's and D's accounts, and of B's while the switch is off, is the unknown key's 404. The
// nightly fan sync, fired as the scheduler fires it (no tenant around it), works on B's account and
// leaves the disabled tenant's and the package without the module alone; the retention purge clears the
// old rows of every live tenant, the disabled one too, as it calls no WeChat API. WeChat is a fake gateway.
import { createHash, randomBytes } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { ConfigService } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { DEFAULT_TENANT_ID as A, Err, wxoaPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { SecretBox } from '../../src/core/crypto/secret-box.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import type { Row } from '../../src/db/seeds/upsert.js'
import { JobScheduler } from '../../src/modules/platform/scheduler/job-scheduler.js'
import { upstreamError, WxoaGateway } from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import { fakeWxoaGateway } from '../fixtures/wxoa/fake-gateway.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import {
  addRow,
  createPackage,
  createTenant,
  type PeopledTenant,
  signInDirect,
  type TestPackage,
  type TestTenant,
} from '../setup/tenants.js'

const PREFIX = 'e2e-wxoa-tenant-'
const STABLE = '/cgi-bin/stable_token'
const USER_GET = '/cgi-bin/user/get'
const BATCHGET = '/cgi-bin/user/info/batchget'
const BLACKLIST = '/cgi-bin/tags/members/getblacklist'
const DAY = 86_400_000

const fake = fakeWxoaGateway()
let on: NestExpressApplication
let off: NestExpressApplication
let ds: DataSource
let box: SecretBox
let B: PeopledTenant
let C: TestTenant
let D: TestTenant
let noWxoa: TestPackage
const tokens = { root: '', bAdmin: '' }
/** A's rows of this spec (B's, C's and D's go with their tenant) */
const aAccounts: number[] = []

let seq = 0
const unique = () => `${PREFIX}${++seq}`
const appId = () => `wx${randomBytes(8).toString('hex')}`
const key = () => randomBytes(16).toString('base64url')
const sha1 = (...parts: string[]) =>
  createHash('sha1').update(parts.toSorted().join('')).digest('hex')

/** The whole app with the switch as asked and the fake gateway. */
async function boot(multiTenant: boolean): Promise<NestExpressApplication> {
  const env = { ...process.env, APP_MULTI_TENANT: String(multiTenant) }
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .overrideProvider(WxoaGateway)
    .useValue(fake.gateway)
    .compile()
  const app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  return app
}

/**
 * A row of `table` in `tenant` with `row`, every other NOT NULL column without a default filled with a
 * value of its type (the rows only need to exist: every request below stops at the lookup).
 */
async function minimal(tenant: number, table: string, row: Row): Promise<number> {
  const cols = await ds.query<{ c: string; t: string; ct: string; len: number | null }[]>(
    `SELECT column_name AS c, data_type AS t, column_type AS ct, character_maximum_length AS len
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND is_nullable = 'NO'
        AND column_default IS NULL AND extra = ''`,
    [table],
  )
  const filled: Row = { ...row }
  for (const { c, t, ct, len } of cols) {
    if (c in filled || c === 'id' || c === 'tenant_id') continue
    if (t === 'enum') filled[c] = /^enum\('([^']*)'/.exec(ct)![1]!
    else if (t === 'json') filled[c] = {}
    else if (t.includes('int') || t === 'decimal') filled[c] = 1
    else if (t.includes('date') || t === 'timestamp') filled[c] = new Date()
    else filled[c] = unique().slice(-(len ?? 16))
  }
  return addRow(on, tenant, table, filled)
}

/** An account of `tenant` (plain mode) with its push Token. */
async function account(tenant: number, over: Row = {}) {
  const token = randomBytes(8).toString('hex')
  const k = key()
  const id = await addRow(on, tenant, 'wxoa_account', {
    label: unique(),
    app_id: appId(),
    account_kind: 'service',
    crypto_mode: 'plain',
    app_secret_enc: box.encrypt('0'.repeat(32)),
    push_token_enc: box.encrypt(token),
    callback_key: k,
    ...over,
  })
  if (tenant === A) aAccounts.push(id)
  return { id, key: k, token }
}

/** A plain-mode text push to `acc`, signed with its Token, on `app`. */
function push(
  app: NestExpressApplication,
  acc: { key: string; token: string },
  openId: string,
  content: string,
) {
  const ts = String(Math.floor(Date.now() / 1000))
  const nonce = `${Date.now()}${++seq}`
  const body = `<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[${openId}]]></FromUserName><CreateTime>${ts}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId>${Date.now()}${seq}</MsgId></xml>`
  return request(app.getHttpServer())
    .post(`/api/wxoa/callback/${acc.key}`)
    .query({ signature: sha1(acc.token, ts, nonce), timestamp: ts, nonce, openid: openId })
    .set('X-Forwarded-For', `10.88.0.${seq % 250}`)
    .set('Content-Type', 'text/xml')
    .send(body)
}

const call = (
  token: string,
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  body?: object,
) => {
  const req = request(on.getHttpServer())[method](`/api/wxoa/${path}`).set(bearer(token))
  return body === undefined ? req : req.send(body)
}

/** Fires a seeded wxoa task as the scheduler does (no tenant around it); its run row. */
async function fire(handler: string) {
  const [{ id }] = await ds.query(
    'SELECT id FROM job_task WHERE handler = ? AND deleted_at IS NULL',
    [handler],
  )
  await on.get(JobScheduler).fire(Number(id), Date.now() + ++seq, 'manual')
  const [run] = await ds.query(
    'SELECT outcome, output, error FROM job_run WHERE task_id = ? ORDER BY id DESC LIMIT 1',
    [id],
  )
  return run as { outcome: string; output: string | null; error: string | null }
}

beforeAll(async () => {
  on = await boot(true)
  off = await boot(false)
  ds = on.get<DataSource>(getDataSourceToken())
  box = on.get(SecretBox)
  await cleanRedis(on.get<Redis>(REDIS))
  B = await createTenant(on, { users: true })
  C = await createTenant(on)
  await ds.query('UPDATE iam_tenant SET enabled = 0 WHERE id = ?', [C.id])
  const notWxoa = await ds.query<{ id: number }[]>(
    `SELECT m.id FROM iam_menu m WHERE m.platform_only = 0 AND m.deleted_at IS NULL
        AND m.route_name IS NOT NULL AND m.route_name NOT LIKE 'wxoa%' AND m.kind = 'group' LIMIT 1`,
  )
  noWxoa = await createPackage(on, { menuIds: notWxoa.map((m) => Number(m.id)) })
  D = await createTenant(on, { packageId: noWxoa.id })
  // B's `member` holds every wxoa menu
  const menus = await ds.query<{ id: number }[]>(
    'SELECT id FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL',
    [Object.values(wxoaPerms).flatMap((p) => Object.values(p))],
  )
  for (const { id } of menus)
    await addRow(on, B.id, 'iam_role_menus', { role_id: B.roleId, menu_id: Number(id) })
  tokens.root = (await signIn(on)).accessToken
  tokens.bAdmin = (await signInDirect(on, B.users.admin))!.accessToken
}, 60_000)

afterAll(async () => {
  if (ds) {
    await on.get(JobScheduler).idle()
    for (const t of [B, C, D]) await t?.dispose()
    await noWxoa?.dispose()
    if (aAccounts.length)
      for (const table of [
        'wxoa_mass_job',
        'wxoa_publish',
        'wxoa_draft',
        'wxoa_message',
        'wxoa_fan',
        'wxoa_tag',
        'wxoa_reply_rule',
        'wxoa_menu',
        'wxoa_material',
        'wxoa_qrcode',
      ])
        // table names of this spec
        await ds.query(`DELETE FROM ${table} WHERE account_id IN (?)`, [aAccounts])
    if (aAccounts.length) await ds.query('DELETE FROM wxoa_account WHERE id IN (?)', [aAccounts])
    await cleanRedis(on.get<Redis>(REDIS))
  }
  await on?.close()
  await off?.close()
})

beforeEach(() => fake.reset())

describe("another tenant's ids", () => {
  it("B's administrator naming A's account or rows: 404 on every endpoint group, WeChat never called", async () => {
    const acc = (await account(A)).id
    const row = (table: string, over: Row = {}) => minimal(A, table, { account_id: acc, ...over })
    const fan = await row('wxoa_fan', { open_id: `o${randomBytes(8).toString('hex')}` })
    const tag = await row('wxoa_tag', { tag_id: 100 })
    const menu = await row('wxoa_menu')
    const rule = await row('wxoa_reply_rule')
    const material = await row('wxoa_material')
    const qr = await row('wxoa_qrcode')
    const draft = await row('wxoa_draft')
    const pub = await row('wxoa_publish')
    const mass = await row('wxoa_mass_job')
    const today = new Date().toISOString().slice(0, 10)
    const comment = { accountId: acc, msgDataId: '2247483650', index: 0 }
    const article = { title: 't', content: '<p>x</p>', thumbMediaId: 'thumb' }
    const groups: Record<
      string,
      [method: 'get' | 'post' | 'put' | 'delete', path: string, body?: object][]
    > = {
      accounts: [
        ['get', `accounts/${acc}`],
        ['put', `accounts/${acc}`, { label: unique() }],
        ['delete', `accounts/${acc}`],
        ['post', `accounts/${acc}/test`],
        ['get', `accounts/${acc}/quota`],
        ['post', `accounts/${acc}/quota/clear`],
      ],
      menus: [
        ['get', `menus?accountId=${acc}`],
        [
          'post',
          'menus',
          {
            accountId: acc,
            menuKind: 'default',
            label: unique(),
            buttons: [{ name: 'Hi', kind: 'click', key: 'K' }],
          },
        ],
        ['post', 'menus/pull', { accountId: acc }],
        ['post', 'menus/clear', { accountId: acc }],
        ['post', 'menus/try-match', { accountId: acc, userId: 'oFan' }],
        ['get', `menus/${menu}`],
        [
          'put',
          `menus/${menu}`,
          { label: unique(), buttons: [{ name: 'Hi', kind: 'click', key: 'K' }] },
        ],
        ['delete', `menus/${menu}`],
        ['post', `menus/${menu}/publish`],
      ],
      replies: [
        ['get', `reply-rules?accountId=${acc}`],
        [
          'post',
          'reply-rules',
          {
            accountId: acc,
            name: unique(),
            triggerKind: 'keyword',
            matchMode: 'exact',
            keywords: ['x'],
            replyKind: 'text',
            replyBody: { content: 'x' },
          },
        ],
        ['get', `reply-rules/${rule}`],
        [
          'put',
          `reply-rules/${rule}`,
          {
            name: unique(),
            triggerKind: 'keyword',
            matchMode: 'exact',
            keywords: ['x'],
            replyKind: 'text',
            replyBody: { content: 'x' },
          },
        ],
        ['delete', `reply-rules/${rule}`],
      ],
      fans: [
        ['get', `fans?accountId=${acc}`],
        ['get', `fans/export?accountId=${acc}`],
        ['get', `fans/sync?accountId=${acc}`],
        ['post', 'fans/sync', { accountId: acc }],
        ['post', 'fans/tagging', { accountId: acc, fanIds: [fan], tagId: 100, op: 'add' }],
        ['post', 'fans/blocking', { accountId: acc, fanIds: [fan], blocked: true }],
        ['get', `fans/${fan}`],
        ['put', `fans/${fan}/remark`, { remark: 'x' }],
      ],
      tags: [
        ['get', `tags?accountId=${acc}`],
        ['post', 'tags', { accountId: acc, name: 'x' }],
        ['post', 'tags/sync', { accountId: acc }],
        ['put', `tags/${tag}`, { name: 'x' }],
        ['delete', `tags/${tag}`],
      ],
      media: [
        ['get', `materials?accountId=${acc}`],
        ['get', `materials/counts?accountId=${acc}`],
        ['get', `materials/sync?accountId=${acc}`],
        ['post', 'materials/sync', { accountId: acc }],
        ['delete', `materials/${material}`],
      ],
      messages: [
        ['get', `messages?accountId=${acc}`],
        ['post', 'messages', { accountId: acc, fanId: fan, kind: 'text', body: { content: 'x' } }],
        ['get', `conversations?accountId=${acc}`],
        ['get', `conversations/${fan}/messages`],
        ['get', `conversations/${fan}/window`],
      ],
      templates: [
        ['get', `templates?accountId=${acc}`],
        ['get', `templates/industry?accountId=${acc}`],
        ['delete', `templates/tpl-1?accountId=${acc}`],
        ['post', 'templates/tpl-1/send', { accountId: acc, fanIds: [fan], data: { first: 'x' } }],
      ],
      qrcodes: [
        ['get', `qrcodes?accountId=${acc}`],
        [
          'post',
          'qrcodes',
          { accountId: acc, label: unique(), qrKind: 'permanent', scene: 'tenant' },
        ],
        ['put', `qrcodes/${qr}`, { label: unique() }],
        ['delete', `qrcodes/${qr}`],
        ['get', `qrcodes/${qr}/stats`],
      ],
      drafts: [
        ['get', `drafts?accountId=${acc}`],
        ['post', 'drafts', { accountId: acc, articles: [article] }],
        ['post', 'drafts/pull', { accountId: acc }],
        ['get', `drafts/${draft}`],
        ['put', `drafts/${draft}`, { articles: [article] }],
        ['delete', `drafts/${draft}`],
        ['post', `drafts/${draft}/sync`],
      ],
      publish: [
        ['get', `publishes?accountId=${acc}`],
        ['post', 'publishes', { accountId: acc, draftId: draft }],
        ['post', 'publishes/pull', { accountId: acc }],
        ['get', `publishes/${pub}`],
        ['delete', `publishes/${pub}`, {}],
      ],
      mass: [
        ['get', `mass-jobs?accountId=${acc}`],
        [
          'post',
          'mass-jobs',
          { accountId: acc, targetKind: 'all', msgKind: 'text', payload: { content: 'x' } },
        ],
        [
          'post',
          'mass-jobs/preview',
          {
            accountId: acc,
            targetKind: 'all',
            msgKind: 'text',
            payload: { content: 'x' },
            toOpenId: 'oFan',
          },
        ],
        ['get', `mass-jobs/${mass}`],
        ['post', `mass-jobs/${mass}/retry`],
        ['delete', `mass-jobs/${mass}`],
      ],
      stats: [
        ['get', `stats/users?accountId=${acc}&from=${today}&to=${today}`],
        ['get', `stats/messages?accountId=${acc}&from=${today}&to=${today}`],
        ['get', `stats/interfaces?accountId=${acc}&from=${today}&to=${today}`],
        ['get', `stats/articles?accountId=${acc}&from=${today}&to=${today}`],
      ],
      comments: [
        ['get', `comments?accountId=${acc}&msgDataId=2247483650&index=0`],
        ['post', 'comments/open', comment],
        ['post', 'comments/close', comment],
        ['post', 'comments/1/elect', comment],
        ['delete', 'comments/1/elect', comment],
        ['post', 'comments/1/reply', { ...comment, content: 'x' }],
        ['delete', 'comments/1/reply', comment],
        ['delete', 'comments/1', comment],
      ],
      notices: [
        ['get', `notice-templates?accountId=${acc}`],
        ['get', `notice-templates/library?accountId=${acc}`],
        [
          'post',
          'notice-templates',
          { accountId: acc, tid: '99', kidList: [1, 2], sceneDesc: 'x' },
        ],
        ['get', `notice-templates/library?accountId=${acc}&categoryId=1`],
        ['get', `notice-templates/library?accountId=${acc}&tid=99`],
        ['delete', `notice-templates/pri-1?accountId=${acc}`],
        [
          'post',
          'notice-templates/pri-1/send',
          { accountId: acc, fanIds: [fan], data: { thing1: 'x' } },
        ],
      ],
    }
    const seen: string[] = []
    for (const [group, list] of Object.entries(groups))
      for (const [method, path, body] of list) {
        const res = await call(tokens.bAdmin, method, path, body)
        seen.push(
          `${group} ${method} ${path} ${res.status}${res.status === 404 ? '' : ` ${JSON.stringify(res.body)}`}`,
        )
      }
    expect(seen.filter((s) => !s.endsWith(' 404'))).toEqual([])
    expect(fake.calls).toEqual([])
    // and A still has them all
    const [{ n }] = await ds.query(
      'SELECT COUNT(*) AS n FROM wxoa_account WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [acc, A],
    )
    expect(Number(n)).toBe(1)
    // B's list does not show A's account
    const listed = (await call(tokens.bAdmin, 'get', 'accounts').expect(200)).body.data.items as {
      id: number
    }[]
    expect(listed.map((a) => a.id)).not.toContain(acc)
    // the same requests on B's own rows get past the lookup
    const own = (await account(B.id)).id
    const ownFan = await minimal(B.id, 'wxoa_fan', {
      account_id: own,
      open_id: `o${randomBytes(8).toString('hex')}`,
    })
    const ownRule = await minimal(B.id, 'wxoa_reply_rule', { account_id: own })
    await call(tokens.bAdmin, 'get', `accounts/${own}`).expect(200)
    await call(tokens.bAdmin, 'get', `fans/${ownFan}`).expect(200)
    await call(tokens.bAdmin, 'get', `menus?accountId=${own}`).expect(200)
    await call(tokens.bAdmin, 'delete', `reply-rules/${ownRule}`).expect(200)
  })
})

describe('a new account with the switch on', () => {
  const body = (id: string) => ({
    label: unique(),
    appId: id,
    accountKind: 'service',
    appSecret: 'a'.repeat(32),
    token: 'tenanttoken',
  })

  it('proves its AppSecret first: refused → no row, the AppID free; accepted → created; the AppID taken in another tenant → 409; the tenant list finds its tenant', async () => {
    const id = appId()
    fake.on(STABLE, upstreamError(40125))
    const refused = await call(tokens.bAdmin, 'post', 'accounts', body(id))
    expect([refused.status, refused.body.code]).toEqual([
      Err.WXOA_CREDENTIAL_INVALID.status,
      Err.WXOA_CREDENTIAL_INVALID.code,
    ])
    expect(await ds.query('SELECT id FROM wxoa_account WHERE app_id = ?', [id])).toEqual([])
    expect(fake.callsTo(STABLE)).toEqual([expect.objectContaining({ accountId: 0, path: STABLE })])

    fake.on(STABLE, { access_token: 'TOKEN-PROOF', expires_in: 7200 })
    const created = await call(tokens.bAdmin, 'post', 'accounts', body(id)).expect(201)
    const [row] = await ds.query('SELECT tenant_id FROM wxoa_account WHERE id = ?', [
      created.body.data.id,
    ])
    expect(Number(row.tenant_id)).toBe(B.id)
    // the proof's token is never cached under any account
    const redis = on.get<Redis>(REDIS)
    expect(await redis.get(`qw:wxoa:token:${created.body.data.id}`)).toBeNull()

    const taken = await call(tokens.root, 'post', 'accounts', body(id))
    expect([taken.status, taken.body.code]).toEqual([Err.DUPLICATE.status, Err.DUPLICATE.code])

    const found = await request(on.getHttpServer())
      .get('/api/iam/tenants')
      .query({ appId: id })
      .set(bearer(tokens.root))
      .expect(200)
    expect(found.body.data.items.map((t: { id: number }) => t.id)).toEqual([B.id])
    const none = await request(on.getHttpServer())
      .get('/api/iam/tenants')
      .query({ appId: appId() })
      .set(bearer(tokens.root))
      .expect(200)
    expect(none.body.data.items).toEqual([])
  })
})

describe('the callback', () => {
  it("a push to B's account lands in B: the message, the fan and the auto reply are B's", async () => {
    const acc = await account(B.id)
    await addRow(on, B.id, 'wxoa_reply_rule', {
      account_id: acc.id,
      name: unique(),
      trigger_kind: 'keyword',
      match_mode: 'exact',
      keywords: ['ping'],
      reply_kind: 'text',
      reply_body: { content: 'pong from B' },
    })
    const openId = `o${randomBytes(8).toString('hex')}`
    const res = await push(on, acc, openId, 'ping').expect(200)
    expect(res.text).toContain('pong from B')
    const messages = await ds.query(
      "SELECT tenant_id, direction FROM wxoa_message WHERE account_id = ? AND open_id = ? AND direction = 'in'",
      [acc.id, openId],
    )
    expect(messages.map((m: { tenant_id: number }) => Number(m.tenant_id))).toEqual([B.id])
    const fans = await ds.query(
      'SELECT tenant_id FROM wxoa_fan WHERE account_id = ? AND open_id = ?',
      [acc.id, openId],
    )
    expect(fans.map((f: { tenant_id: number }) => Number(f.tenant_id))).toEqual([B.id])
    expect(fake.calls).toEqual([])
  })

  it("the accounts of a disabled tenant, of a package without the module, and of B while the switch is off: the unknown key's 404", async () => {
    const ofC = await account(C.id)
    const ofD = await account(D.id)
    const ofB = await account(B.id)
    const ofA = await account(A)
    for (const acc of [ofC, ofD]) await push(on, acc, 'oX', 'hi').expect(404)
    await push(off, ofB, 'oX', 'hi').expect(404)
    // only the other tenants: A's account answers on both
    await push(on, ofA, 'oX', 'hi').expect(200)
    await push(off, ofA, 'oX', 'hi').expect(200)
    await push(on, ofB, 'oX', 'hi').expect(200)
    const [{ n }] = await ds.query(
      'SELECT COUNT(*) AS n FROM wxoa_message WHERE account_id IN (?)',
      [[ofC.id, ofD.id]],
    )
    expect(Number(n)).toBe(0)
  })
})

describe('the jobs', () => {
  it("the nightly fan sync works on B's account in B and leaves the disabled tenant's and the package without the module alone", async () => {
    const ofB = await account(B.id)
    const ofC = await account(C.id)
    const ofD = await account(D.id)
    const openId = `o${randomBytes(8).toString('hex')}`
    fake.on(USER_GET, (c) =>
      c.accountId === ofB.id && !c.query?.next_openid
        ? { total: 1, count: 1, data: { openid: [openId] }, next_openid: openId }
        : { total: 0, count: 0, next_openid: '' },
    )
    fake.on(BATCHGET, (c) => ({
      user_info_list:
        c.accountId === ofB.id
          ? [{ openid: openId, subscribe: 1, subscribe_time: Math.floor(Date.now() / 1000) }]
          : [],
    }))
    fake.on(BLACKLIST, { total: 0, count: 0, next_openid: '' })
    const run = await fire('wxoa.fan.sync')
    expect(run).toMatchObject({ outcome: 'ok', error: null })
    expect(run.output).toContain(`account ${ofB.id}: done`)
    for (const other of [ofC, ofD]) {
      expect(run.output).not.toContain(`account ${other.id}:`)
      expect(fake.calls.some((c) => c.accountId === other.id)).toBe(false)
    }
    const fans = await ds.query(
      'SELECT tenant_id FROM wxoa_fan WHERE account_id = ? AND open_id = ?',
      [ofB.id, openId],
    )
    expect(fans.map((f: { tenant_id: number }) => Number(f.tenant_id))).toEqual([B.id])
  })

  it('the retention purge deletes the old rows of B and of the disabled tenant too (no WeChat call), each in its own tenant', async () => {
    const ofB = await account(B.id)
    const ofC = await account(C.id)
    const old = new Date(Date.now() - 400 * DAY)
    const message = (tenant: number, accountId: number) =>
      addRow(on, tenant, 'wxoa_message', {
        account_id: accountId,
        open_id: 'oOld',
        direction: 'in',
        channel: 'push',
        msg_kind: 'text',
        payload: {},
        occurred_at: old,
      })
    const bRow = await message(B.id, ofB.id)
    const cRow = await message(C.id, ofC.id)
    const run = await fire('wxoa.message.purge')
    expect(run).toMatchObject({ outcome: 'ok', error: null })
    const left = await ds.query('SELECT id FROM wxoa_message WHERE id IN (?)', [[bRow, cRow]])
    expect(left).toEqual([])
  })
})
