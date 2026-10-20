// WeChat Official Account template messages (see docs/design-notes.md#wxoa): the template list read from
// get_all_private_template and cached 10 minutes per account (refresh=true asks again, a delete drops it);
// the industries; delete; a send to at most 100 of the account's fans (data keys checked against the
// template, one pending row per fan returned, then message/template/send one by one after the response
// with client_msg_id qw-<row id>, msgid or errcode recorded); TEMPLATESENDJOBFINISH receipts fed straight
// to the inbound hub settle the rows; every route through the account (missing or deleted 404, disabled
// B6011); 403 per permission; 400; @ActionLog. WeChat is a fake gateway.
import { randomBytes } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, wxoaPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId as findIdRaw, insertRow as insertRowRaw } from '../../src/db/seeds/upsert.js'
import { upstreamError, WxoaGateway } from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import {
  type WxoaInbound,
  WxoaInboundHub,
} from '../../src/modules/platform/wxoa/core/wxoa-inbound-hub.js'
import { fakeWxoaGateway, type FakeWxoaCall } from '../fixtures/wxoa/fake-gateway.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { inTenant1 } from '../setup/tenants.js'
const findId = (...args: Parameters<typeof findIdRaw>) => inTenant1(() => findIdRaw(...args))
const insertRow = (...args: Parameters<typeof insertRowRaw>) =>
  inTenant1(() => insertRowRaw(...args))

const PREFIX = 'e2e-wxoa-template-'
const URL = '/api/wxoa/templates'
const LIST = '/cgi-bin/template/get_all_private_template'
const INDUSTRY = '/cgi-bin/template/get_industry'
const DEL = '/cgi-bin/template/del_private_template'
const SEND = '/cgi-bin/message/template/send'
const MISSING = 999_999
const BIG_MSG_ID = '18446744073709551615'

const fake = fakeWxoaGateway()
let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens = { admin: '', reader: '', plain: '' }
let adminId: number
const userIds: number[] = []
const accountIds: number[] = []
let roleId: number
/** enabled accounts A and B, a disabled one */
let a: number
let b: number
let off: number

let seq = 0
const unique = () => `${PREFIX}${++seq}`

const tpl = (id: string, content = '{{thing1.DATA}}\n金额：{{amount2.DATA}}\n{{time3.DATA}}') => ({
  template_id: id,
  title: `title of ${id}`,
  primary_industry: 'IT科技',
  deputy_industry: '互联网|电子商务',
  content,
  example: 'an example',
})
/** get_all_private_template per account: A has TPL-A1 and TPL-A2, B has TPL-B1 */
const lists = (c: FakeWxoaCall) => ({
  template_list:
    c.accountId === b ? [tpl('TPL-B1')] : [tpl('TPL-A1'), tpl('TPL-A2', '{{first.DATA}}')],
})

const call = (who: keyof typeof tokens, method: 'get' | 'post' | 'delete', path = '') =>
  request(app.getHttpServer())[method](`${URL}${path}`).set(bearer(tokens[who]))
const send = (who: keyof typeof tokens, templateId: string, body: object) =>
  call(who, 'post', `/${templateId}/send`).send(body)

async function account(enabled = true) {
  const id = await insertRow(ds.manager, 'wxoa_account', {
    label: unique(),
    app_id: `wx${randomBytes(8).toString('hex')}`,
    account_kind: 'service',
    app_secret_enc: 'not-used-by-this-spec',
    push_token_enc: 'not-used-by-this-spec',
    callback_key: randomBytes(16).toString('base64url'),
    enabled,
  })
  accountIds.push(id)
  return id
}
const fan = (accountId: number, openId = `o${randomBytes(12).toString('hex')}`) =>
  insertRow(ds.manager, 'wxoa_fan', { account_id: accountId, open_id: openId, subscribed: 1 })
const openIdOf = async (fanId: number): Promise<string> =>
  (await ds.query('SELECT open_id FROM wxoa_fan WHERE id = ?', [fanId]))[0].open_id
const messageCount = async () =>
  Number(
    (
      await ds.query('SELECT COUNT(*) AS n FROM wxoa_message WHERE account_id IN (?)', [accountIds])
    )[0].n,
  )

async function user(name: string, roles: number[]) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (tenant_id, user_id, role_id) VALUES (1, ?, ?)', [
      id,
      r,
    ])
  userIds.push(id)
  return (await signIn(app, PREFIX + name)).accessToken
}

/** The message rows `ids` once none of them is pending any more (5 s at most). */
async function settled(ids: number[]) {
  for (const until = Date.now() + 5000; ; await new Promise((r) => setTimeout(r, 25))) {
    const rows = await ds.query('SELECT * FROM wxoa_message WHERE id IN (?) ORDER BY id', [ids])
    if (rows.every((r: { send_state: string }) => r.send_state !== 'pending') || Date.now() > until)
      return rows
  }
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
  await cleanRedis(redis)
  roleId = await insertRow(ds.manager, 'iam_role', {
    code: `${PREFIX}reader`,
    name: `${PREFIX}reader`,
    data_scope: 'all',
  })
  const browse = await findId(ds.manager, 'iam_menu', { perms: wxoaPerms.template.browse })
  await ds.query('INSERT INTO iam_role_menus (tenant_id, role_id, menu_id) VALUES (1, ?, ?)', [
    roleId,
    browse,
  ])
  tokens.admin = (await signIn(app)).accessToken
  adminId = (await ds.query("SELECT id FROM iam_user WHERE username = 'admin'"))[0].id
  tokens.reader = await user('reader', [roleId])
  tokens.plain = await user('plain', [])
  a = await account()
  b = await account()
  off = await account(false)
})

beforeEach(async () => {
  fake.reset()
  await redis.unlink(accountIds.map((id) => redisKey('wxoa', 'tpl', id)))
})

afterAll(async () => {
  if (ds) {
    if (accountIds.length) {
      for (const table of ['wxoa_message', 'wxoa_fan'])
        // arch-allow: sql-concat table names are spec constants; ids bound
        await ds.query(`DELETE FROM ${table} WHERE account_id IN (?)`, [accountIds])
      await ds.query('DELETE FROM wxoa_account WHERE id IN (?)', [accountIds])
    }
    if (userIds.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    }
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
    await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('list and industry', () => {
  it('lists the templates from WeChat, then from the cache for 10 minutes; refresh=true asks again', async () => {
    fake.on(LIST, (c) => ({
      template_list: [...lists(c).template_list, { title: 'no id' }],
    }))
    const first = await call('admin', 'get', `?accountId=${a}`).expect(200)
    expect(first.body.data).toEqual([
      {
        templateId: 'TPL-A1',
        title: 'title of TPL-A1',
        primaryIndustry: 'IT科技',
        deputyIndustry: '互联网|电子商务',
        content: '{{thing1.DATA}}\n金额：{{amount2.DATA}}\n{{time3.DATA}}',
        example: 'an example',
      },
      expect.objectContaining({ templateId: 'TPL-A2', content: '{{first.DATA}}' }),
    ])
    expect(fake.callsTo(LIST)).toEqual([expect.objectContaining({ method: 'json', accountId: a })])
    const ttl = await redis.ttl(redisKey('wxoa', 'tpl', a))
    expect(ttl).toBeGreaterThan(590)
    expect(ttl).toBeLessThanOrEqual(600)
    const again = await call('admin', 'get', `?accountId=${a}`).expect(200)
    expect(again.body.data).toEqual(first.body.data)
    expect(fake.callsTo(LIST)).toHaveLength(1)
    fake.on(LIST, { template_list: [tpl('TPL-A3')] })
    const fresh = await call('admin', 'get', `?accountId=${a}&refresh=true`).expect(200)
    expect(fresh.body.data.map((t: { templateId: string }) => t.templateId)).toEqual(['TPL-A3'])
    expect(fake.callsTo(LIST)).toHaveLength(2)
    // the refreshed list is the cached one now; another account has its own
    await call('admin', 'get', `?accountId=${a}&refresh=false`).expect(200)
    expect(fake.callsTo(LIST)).toHaveLength(2)
    fake.on(LIST, lists)
    const ofB = await call('admin', 'get', `?accountId=${b}`).expect(200)
    expect(ofB.body.data.map((t: { templateId: string }) => t.templateId)).toEqual(['TPL-B1'])
    expect(fake.callsTo(LIST).map((c) => c.accountId)).toEqual([a, a, b])
  })

  it("the industries are WeChat's; one not set is null", async () => {
    fake.on(INDUSTRY, {
      primary_industry: { first_class: '运输与仓储', second_class: '快递' },
    })
    const res = await call('admin', 'get', `/industry?accountId=${a}`).expect(200)
    expect(res.body.data).toEqual({
      primary: { first: '运输与仓储', second: '快递' },
      secondary: null,
    })
    expect(fake.callsTo(INDUSTRY)).toEqual([expect.objectContaining({ accountId: a })])
  })

  it('400: no account, a refresh that is not a boolean', async () => {
    await call('admin', 'get', '').expect(400)
    await call('admin', 'get', `?accountId=${a}&refresh=maybe`).expect(400)
    await call('admin', 'get', '/industry').expect(400)
    expect(fake.calls).toHaveLength(0)
  })
})

describe('delete', () => {
  it('deletes the template on WeChat and drops the cached list', async () => {
    fake.on(LIST, lists)
    fake.on(DEL, { errcode: 0, errmsg: 'ok' })
    await call('admin', 'get', `?accountId=${a}`).expect(200)
    const trace = `${PREFIX}${process.pid}-remove`
    await call('admin', 'delete', `/TPL-A2?accountId=${a}`).set('X-Request-Id', trace).expect(200)
    expect(fake.callsTo(DEL)).toEqual([
      expect.objectContaining({ accountId: a, body: { template_id: 'TPL-A2' } }),
    ])
    expect(fake.callsTo(LIST)).toHaveLength(1)
    expect(await redis.exists(redisKey('wxoa', 'tpl', a))).toBe(0)
    expect(await logOf(ds, trace)).toMatchObject({
      domain: 'wxoa.template',
      verb: 'remove',
      biz_id: 'TPL-A2',
      ok: 1,
    })
    await call('admin', 'get', `?accountId=${a}`).expect(200)
    expect(fake.callsTo(LIST)).toHaveLength(2)
  })

  it("a template not in the account's list → 404 without calling del_private_template", async () => {
    fake.on(LIST, lists)
    fake.on(DEL, { errcode: 0, errmsg: 'ok' })
    await call('admin', 'delete', `/TPL-B1?accountId=${a}`).expect(404)
    await call('admin', 'delete', `/no-such-template?accountId=${a}`).expect(404)
    await call('admin', 'delete', '/TPL-A1').expect(400)
    expect(fake.callsTo(DEL)).toHaveLength(0)
  })

  it('WeChat refusing the delete keeps the cached list', async () => {
    fake.on(LIST, lists)
    fake.on(DEL, upstreamError(45009))
    const res = await call('admin', 'delete', `/TPL-A1?accountId=${a}`).expect(429)
    expect(res.body.code).toBe(Err.WXOA_QUOTA_EXCEEDED.code)
    expect(await redis.exists(redisKey('wxoa', 'tpl', a))).toBe(1)
  })
})

describe('send', () => {
  it('writes one pending row per fan, answers before sending, then sends each with its client_msg_id', async () => {
    fake.on(LIST, lists)
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    fake.on(
      SEND,
      async () => {
        await gate
        return { errcode: 0, errmsg: 'ok', msgid: BIG_MSG_ID }
      },
      async () => ({ errcode: 0, errmsg: 'ok', msgid: 200228332 }),
    )
    const f1 = await fan(a)
    const f2 = await fan(a)
    const data = { thing1: unique(), amount2: '12.50元', time3: '2026-10-06 12:00' }
    const body = {
      accountId: a,
      fanIds: [f2, f1, f2],
      data,
      url: 'https://example.com/order/1',
      miniprogram: { appId: 'wx0123456789abcdef', pagePath: 'pages/order?id=1' },
    }
    const trace = `${PREFIX}${process.pid}-send`
    const res = await send('admin', 'TPL-A1', body).set('X-Request-Id', trace).expect(201)
    const rows = res.body.data
    expect(rows).toHaveLength(2)
    const payload = {
      templateId: 'TPL-A1',
      title: 'title of TPL-A1',
      data,
      url: body.url,
      miniprogram: body.miniprogram,
    }
    for (const row of rows)
      expect(row).toMatchObject({
        accountId: a,
        direction: 'out',
        channel: 'template',
        msgKind: 'template',
        sendState: 'pending',
        objectId: null,
        wxMsgId: null,
        operatorId: adminId,
        payload,
      })
    expect(rows.map((r: { openId: string }) => r.openId)).toEqual([
      await openIdOf(f1),
      await openIdOf(f2),
    ])
    open()
    const ids = rows.map((r: { id: number }) => r.id)
    const done = await settled(ids)
    expect(
      done.map((r: Record<string, unknown>) => [r.send_state, r.wx_msg_id, r.errcode]),
    ).toEqual([
      ['sent', BIG_MSG_ID, 0],
      ['sent', '200228332', 0],
    ])
    expect(done.every((r: { object_id: unknown }) => r.object_id === null)).toBe(true)
    expect(fake.callsTo(SEND).map((c) => c.body)).toEqual(
      rows.map((r: { id: number; openId: string }) => ({
        touser: r.openId,
        template_id: 'TPL-A1',
        url: body.url,
        miniprogram: { appid: 'wx0123456789abcdef', pagepath: 'pages/order?id=1' },
        client_msg_id: `qw-${r.id}`,
        data: {
          thing1: { value: data.thing1 },
          amount2: { value: '12.50元' },
          time3: { value: '2026-10-06 12:00' },
        },
      })),
    )
    expect(fake.callsTo(SEND).every((c) => c.accountId === a)).toBe(true)
    expect(await logOf(ds, trace)).toMatchObject({
      domain: 'wxoa.template',
      verb: 'send',
      biz_id: 'TPL-A1',
      ok: 1,
    })
  })

  it('a refused send records failed with its errcode; the others still go; no link is sent when none is given', async () => {
    fake.on(LIST, lists)
    fake.on(SEND, upstreamError(43004), { errcode: 0, errmsg: 'ok', msgid: 7 })
    const fans = [await fan(a), await fan(a)]
    const res = await send('admin', 'TPL-A1', {
      accountId: a,
      fanIds: fans,
      data: { thing1: unique() },
    }).expect(201)
    const done = await settled(res.body.data.map((r: { id: number }) => r.id))
    expect(
      done.map((r: Record<string, unknown>) => [r.send_state, r.wx_msg_id, r.errcode]),
    ).toEqual([
      ['failed', null, 43004],
      ['sent', '7', 0],
    ])
    for (const c of fake.callsTo(SEND)) {
      expect(c.body).not.toHaveProperty('url')
      expect(c.body).not.toHaveProperty('miniprogram')
    }
  })

  it('a row the purge already failed stays failed when its send answers late', async () => {
    fake.on(LIST, lists)
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    fake.on(SEND, async () => {
      await gate
      return { errcode: 0, errmsg: 'ok', msgid: 9 }
    })
    const res = await send('admin', 'TPL-A1', {
      accountId: a,
      fanIds: [await fan(a), await fan(a)],
      data: { thing1: unique() },
    }).expect(201)
    const ids = res.body.data.map((r: { id: number }) => r.id)
    await ds.query("UPDATE wxoa_message SET send_state = 'failed' WHERE id = ?", [ids[0]])
    open()
    const done = await settled(ids)
    expect(
      done.map((r: Record<string, unknown>) => [r.send_state, r.wx_msg_id, r.errcode]),
    ).toEqual([
      ['failed', null, null],
      ['sent', '9', 0],
    ])
    expect(fake.callsTo(SEND)).toHaveLength(2)
  })

  it('400: over 100 fans, a key the template lacks, a value over its limit, a link not http(s); nothing is written', async () => {
    fake.on(LIST, lists)
    const f = await fan(a)
    const before = await messageCount()
    const base = { accountId: a, fanIds: [f] }
    const many = Array.from({ length: 101 }, (_, i) => i + 1)
    await send('admin', 'TPL-A1', { ...base, fanIds: many, data: { thing1: unique() } }).expect(400)
    await send('admin', 'TPL-A1', { ...base, fanIds: [], data: { thing1: unique() } }).expect(400)
    const lacking = await send('admin', 'TPL-A1', {
      ...base,
      data: { thing1: unique(), thing9: 'x' },
    }).expect(400)
    expect(JSON.stringify(lacking.body)).toContain('thing9')
    await send('admin', 'TPL-A1', { ...base, data: { thing1: 'x'.repeat(21) } }).expect(400)
    await send('admin', 'TPL-A1', {
      ...base,
      data: { thing1: unique() },
      url: 'ftp://example.com/x',
    }).expect(400)
    await send('admin', 'TPL-A1', { fanIds: [f], data: { thing1: unique() } }).expect(400)
    expect(await messageCount()).toBe(before)
    expect(fake.callsTo(SEND)).toHaveLength(0)
  })

  it("404: another account's template or fan, a deleted fan, an unknown or deleted account; B6011 when disabled", async () => {
    fake.on(LIST, lists)
    const f = await fan(a)
    const ofB = await fan(b)
    const gone = await fan(a)
    await ds.query('UPDATE wxoa_fan SET deleted_at = NOW(3) WHERE id = ?', [gone])
    const goneAccount = await account()
    const goneFan = await fan(goneAccount)
    await ds.query('UPDATE wxoa_account SET deleted_at = NOW(3) WHERE id = ?', [goneAccount])
    const offFan = await fan(off)
    const before = await messageCount()
    const body = (accountId: number, fanIds: number[]) => ({
      accountId,
      fanIds,
      data: { thing1: unique() },
    })
    await send('admin', 'TPL-B1', body(a, [f])).expect(404)
    await send('admin', 'TPL-A1', body(a, [f, ofB])).expect(404)
    await send('admin', 'TPL-A1', body(a, [gone])).expect(404)
    await send('admin', 'TPL-A1', body(MISSING, [f])).expect(404)
    await send('admin', 'TPL-A1', body(goneAccount, [goneFan])).expect(404)
    for (const res of [
      await send('admin', 'TPL-A1', body(off, [offFan])).expect(422),
      await call('admin', 'get', `?accountId=${off}`).expect(422),
      await call('admin', 'get', `/industry?accountId=${off}`).expect(422),
      await call('admin', 'delete', `/TPL-A1?accountId=${off}`).expect(422),
    ])
      expect(res.body.code).toBe(Err.WXOA_ACCOUNT_DISABLED.code)
    for (const accountId of [MISSING, goneAccount]) {
      await call('admin', 'get', `?accountId=${accountId}`).expect(404)
      await call('admin', 'get', `/industry?accountId=${accountId}`).expect(404)
      await call('admin', 'delete', `/TPL-A1?accountId=${accountId}`).expect(404)
    }
    expect(await messageCount()).toBe(before)
    expect(fake.calls.filter((c) => c.path !== LIST)).toHaveLength(0)
    expect(fake.callsTo(LIST).every((c) => c.accountId === a)).toBe(true)
  })

  it('the same send twice at once → 429 for the second', async () => {
    fake.on(LIST, lists)
    fake.on(SEND, { errcode: 0, errmsg: 'ok', msgid: 1 })
    const body = { accountId: a, fanIds: [await fan(a)], data: { thing1: unique() } }
    const res = await send('admin', 'TPL-A1', body).expect(201)
    await send('admin', 'TPL-A1', body).expect(429)
    await settled(res.body.data.map((r: { id: number }) => r.id))
    expect(fake.callsTo(SEND)).toHaveLength(1)
  })
})

describe('receipts', () => {
  const sent = (accountId: number, openId: string, wxMsgId: string, state = 'sent') =>
    insertRow(ds.manager, 'wxoa_message', {
      account_id: accountId,
      open_id: openId,
      direction: 'out',
      channel: 'template',
      msg_kind: 'template',
      payload: JSON.stringify({ templateId: 'TPL-A1' }),
      wx_msg_id: wxMsgId,
      send_state: state,
      errcode: 0,
      occurred_at: new Date(),
    })
  const receipt = (
    accountId: number,
    openId: string,
    wxMsgId: string | null,
    Status: string,
    eventKind = 'TEMPLATESENDJOBFINISH',
  ): WxoaInbound => ({
    id: MISSING,
    accountId,
    openId,
    msgKind: 'event',
    eventKind,
    eventKey: null,
    wxMsgId,
    payload: { Status },
    occurredAt: new Date(),
  })
  const stateOf = async (id: number) =>
    (await ds.query('SELECT send_state FROM wxoa_message WHERE id = ?', [id]))[0].send_state

  it('success → delivered, a user block → user_blocked, a system failure → failed', async () => {
    const hub = app.get(WxoaInboundHub)
    const openId = `o${randomBytes(12).toString('hex')}`
    const ok = await sent(a, openId, '1001')
    const blocked = await sent(a, openId, '1002')
    const failed = await sent(a, openId, '1003')
    await hub.emit(receipt(a, openId, '1001', 'success'))
    await hub.emit(receipt(a, openId, '1002', 'failed:user block'))
    await hub.emit(receipt(a, openId, '1003', 'failed: system failed'))
    expect([await stateOf(ok), await stateOf(blocked), await stateOf(failed)]).toEqual([
      'delivered',
      'user_blocked',
      'failed',
    ])
    expect(fake.calls).toHaveLength(0)
  })

  it("a receipt settles only the account's sent row of that fan and msgid", async () => {
    const hub = app.get(WxoaInboundHub)
    const openId = `o${randomBytes(12).toString('hex')}`
    const row = await sent(a, openId, '2001')
    const pending = await sent(a, openId, '2002', 'pending')
    await hub.emit(receipt(b, openId, '2001', 'success'))
    await hub.emit(receipt(a, `${openId}x`, '2001', 'success'))
    await hub.emit(receipt(a, openId, '2001', 'success', 'MASSSENDJOBFINISH'))
    await hub.emit(receipt(a, openId, '2001', 'something else'))
    await hub.emit(receipt(a, openId, null, 'success'))
    await hub.emit(receipt(a, openId, '2002', 'success'))
    expect(await stateOf(row)).toBe('sent')
    expect(await stateOf(pending)).toBe('pending')
    await hub.emit(receipt(a, openId, '2001', 'success'))
    expect(await stateOf(row)).toBe('delivered')
  })
})

describe('permissions', () => {
  it('403 per permission: browse reads, remove deletes, send sends', async () => {
    fake.on(LIST, lists)
    const f = await fan(a)
    const body = { accountId: a, fanIds: [f], data: { thing1: unique() } }
    for (const path of [`?accountId=${a}`, `/industry?accountId=${a}`])
      await call('plain', 'get', path).expect(403)
    await call('reader', 'get', `?accountId=${a}`).expect(200)
    for (const who of ['plain', 'reader'] as const) {
      await call(who, 'delete', `/TPL-A1?accountId=${a}`).expect(403)
      await send(who, 'TPL-A1', body).expect(403)
    }
    expect(fake.calls.filter((c) => c.path !== LIST)).toHaveLength(0)
  })

  it('Swagger documents every route', async () => {
    const doc = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body
    expect(
      Object.keys(doc.paths)
        .filter((p) => p.startsWith(URL))
        .sort(),
    ).toEqual([URL, `${URL}/industry`, `${URL}/{templateId}`, `${URL}/{templateId}/send`])
  })
})
