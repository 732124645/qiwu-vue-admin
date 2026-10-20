// WeChat Official Account fans and tags (see docs/design-notes.md#wxoa): the list with its filters and the
// export of the same rows; a subscribe fed to the inbound hub completes the fan's profile once through
// user/info; remarks, tagging (batches of 50, the tag's fan count following) and the blacklist (batches of
// 20) on WeChat first, then here; tags created, renamed, deleted (their fans losing them) and synced,
// WeChat's reserved tags left alone; the full sync (user/get pages, info/batchget per 100, the blacklist)
// in the background, one per account across two app instances, interrupted when its instance stopped,
// marking unsubscribed only after a whole round and never against what the callback wrote during it;
// the nightly job; every route through the account (missing or deleted 404, disabled B6011); 403 per
// permission; 400; @ActionLog. WeChat is a fake gateway.
import { randomBytes } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, WXOA_TAGS_MAX, wxoaPerms } from '@qiwu/shared'
import ExcelJS from 'exceljs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { RedisLock } from '../../src/core/guard/redis-lock.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId as findIdRaw, insertRow as insertRowRaw } from '../../src/db/seeds/upsert.js'
import { JobScheduler } from '../../src/modules/platform/scheduler/job-scheduler.js'
import { WxoaFanService } from '../../src/modules/platform/wxoa/fan/fan.service.js'
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

const PREFIX = 'e2e-wxoa-fan-'
const FANS = '/api/wxoa/fans'
const TAGS = '/api/wxoa/tags'
const INFO = '/cgi-bin/user/info'
const BATCHGET = '/cgi-bin/user/info/batchget'
const USER_GET = '/cgi-bin/user/get'
const REMARK = '/cgi-bin/user/info/updateremark'
const TAGGING = '/cgi-bin/tags/members/batchtagging'
const UNTAGGING = '/cgi-bin/tags/members/batchuntagging'
const BLOCK = '/cgi-bin/tags/members/batchblacklist'
const UNBLOCK = '/cgi-bin/tags/members/batchunblacklist'
const BLACKLIST = '/cgi-bin/tags/members/getblacklist'
const TAG_CREATE = '/cgi-bin/tags/create'
const TAG_UPDATE = '/cgi-bin/tags/update'
const TAG_DELETE = '/cgi-bin/tags/delete'
const TAG_GET = '/cgi-bin/tags/get'
const MISSING = 999_999

const fake = fakeWxoaGateway()
let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens = { admin: '', reader: '', editor: '', plain: '' }
const userIds: number[] = []
const roleIds: number[] = []
const accountIds: number[] = []
/** enabled accounts A and B, a disabled one */
let a: number
let b: number
let off: number

let seq = 0
const unique = () => `${PREFIX}${++seq}`
let tagSeq = 100
const openId = () => `o${randomBytes(12).toString('hex')}`
const ok = { errcode: 0 }

type Method = 'get' | 'post' | 'put' | 'delete'
const call = (who: keyof typeof tokens, method: Method, path: string, body?: object) => {
  const req = request(app.getHttpServer())[method](path).set(bearer(tokens[who]))
  return body ? req.send(body) : req
}

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
const fan = (accountId: number, over: Record<string, unknown> = {}) =>
  insertRow(ds.manager, 'wxoa_fan', {
    account_id: accountId,
    open_id: openId(),
    subscribed: 1,
    ...over,
  })
const fanRow = async (id: number) =>
  (await ds.query('SELECT * FROM wxoa_fan WHERE id = ?', [id]))[0]
const fanByOpenId = async (accountId: number, oid: string) =>
  (
    await ds.query('SELECT * FROM wxoa_fan WHERE account_id = ? AND open_id = ?', [accountId, oid])
  )[0]
/** A tag of `accountId`: its row id and upstream id. */
async function tag(accountId: number, over: Record<string, unknown> = {}) {
  const tagId = ++tagSeq
  const id = await insertRow(ds.manager, 'wxoa_tag', {
    account_id: accountId,
    tag_id: tagId,
    name: unique(),
    ...over,
  })
  return { id, tagId: (over.tag_id as number | undefined) ?? tagId }
}
const tagRow = async (id: number) =>
  (await ds.query('SELECT * FROM wxoa_tag WHERE id = ?', [id]))[0]

async function role(name: string, perms: string[]) {
  const id = await insertRow(ds.manager, 'iam_role', {
    code: PREFIX + name,
    name: PREFIX + name,
    data_scope: 'all',
  })
  roleIds.push(id)
  for (const perm of perms)
    await ds.query('INSERT INTO iam_role_menus (tenant_id, role_id, menu_id) VALUES (1, ?, ?)', [
      id,
      await findId(ds.manager, 'iam_menu', { perms: perm }),
    ])
  return id
}
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

/** An inbound row as the callback hands it to the hub. */
const inbound = (accountId: number, oid: string, over: Partial<WxoaInbound> = {}): WxoaInbound => ({
  id: ++seq,
  accountId,
  openId: oid,
  msgKind: 'event',
  eventKind: 'subscribe',
  eventKey: null,
  wxMsgId: null,
  payload: {},
  occurredAt: new Date(),
  ...over,
})
/** A user of `user/info` / `batchget`. */
const info = (oid: string, over: Record<string, unknown> = {}) => ({
  subscribe: 1,
  openid: oid,
  language: 'zh_CN',
  subscribe_time: 1_700_000_000,
  unionid: `u${oid}`,
  remark: '',
  tagid_list: [],
  subscribe_scene: 'ADD_SCENE_QR_CODE',
  qr_scene: 0,
  qr_scene_str: '',
  ...over,
})
/** `batchget` answering every user asked for as subscribed (`over` per openid). */
const batchget =
  (over: Record<string, Record<string, unknown>> = {}) =>
  (c: FakeWxoaCall) => ({
    user_info_list: (c.body as { user_list: { openid: string }[] }).user_list.map((u) =>
      info(u.openid, over[u.openid]),
    ),
  })
/** `user/get` / `getblacklist` pages: `pages[i]` answers the i-th call, then an empty page. */
const listing = (pages: string[][]) => {
  let i = 0
  return () => {
    const page = pages[i++] ?? []
    return {
      total: pages.flat().length,
      count: page.length,
      data: page.length ? { openid: page } : undefined,
      next_openid: page.at(-1) ?? '',
    }
  }
}

/** GET /fans/sync of `accountId` until the run is no longer running. */
async function settled(accountId: number) {
  for (const until = Date.now() + 5000; ; await new Promise((r) => setTimeout(r, 25))) {
    const progress = (await call('admin', 'get', `${FANS}/sync?accountId=${accountId}`).expect(200))
      .body.data
    if (progress.state !== 'running' || Date.now() > until) return progress
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
  const { fan: f, tag: t } = wxoaPerms
  tokens.admin = (await signIn(app)).accessToken
  tokens.reader = await user('reader', [await role('reader', [f.browse, t.browse])])
  tokens.editor = await user('editor', [
    await role('editor', [f.browse, f.modify, t.browse, t.modify]),
  ])
  tokens.plain = await user('plain', [])
  a = await account()
  b = await account()
  off = await account(false)
})

beforeEach(() => fake.reset())

afterAll(async () => {
  if (ds) {
    if (accountIds.length) {
      for (const table of ['wxoa_fan', 'wxoa_tag'])
        // arch-allow: sql-concat table names are spec constants; ids bound
        await ds.query(`DELETE FROM ${table} WHERE account_id IN (?)`, [accountIds])
      await ds.query('DELETE FROM wxoa_account WHERE id IN (?)', [accountIds])
    }
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

describe('list, one fan and export', () => {
  /** A binary (xlsx) response body as a Buffer. */
  const binary = (r: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = []
    r.on('data', (c: Buffer) => chunks.push(c))
    r.on('end', () => cb(null, Buffer.concat(chunks)))
  }
  async function exported(who: keyof typeof tokens, query: string, headers: object = {}) {
    const res = await call(who, 'get', `${FANS}/export${query}`)
      .set(headers as Record<string, string>)
      .buffer(true)
      .parse(binary)
    if (res.status !== 200) return { res, rows: [] }
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(res.body as Parameters<typeof wb.xlsx.load>[0])
    const ws = wb.worksheets[0]!
    const rows: unknown[][] = []
    ws.eachRow((row) => rows.push((row.values as unknown[]).slice(1)))
    return { res, rows }
  }

  it("lists the account's fans only, by subscription, blacklist, tag, openid and remark", async () => {
    const acc = await account()
    const x = await fan(acc, { remark: 'alpha', tag_ids: [7, 8], blocked: 1 })
    const y = await fan(acc, { subscribed: 0, tag_ids: [8] })
    const z = await fan(acc)
    await fan(b, { tag_ids: [8] })
    const ids = async (query = '') =>
      (
        await call('admin', 'get', `${FANS}?accountId=${acc}${query}`).expect(200)
      ).body.data.items.map((f: { id: number }) => f.id)
    expect(await ids()).toEqual([z, y, x])
    expect(await ids('&sort=id')).toEqual([x, y, z])
    expect(await ids('&subscribed=false')).toEqual([y])
    expect(await ids('&subscribed=true&blocked=false')).toEqual([z])
    expect(await ids('&blocked=true')).toEqual([x])
    expect(await ids('&tagId=8')).toEqual([y, x])
    expect(await ids('&tagId=7')).toEqual([x])
    expect(await ids('&tagId=9')).toEqual([])
    const { open_id } = await fanRow(x)
    expect(await ids(`&openId=${open_id.slice(4, 16)}`)).toEqual([x])
    expect(await ids('&remark=alp')).toEqual([x])
    const page = (await call('admin', 'get', `${FANS}?accountId=${acc}&pageSize=1`).expect(200))
      .body.data
    expect(page.total).toBe(3)
    expect(page.items[0]).toMatchObject({
      id: z,
      accountId: acc,
      tagIds: [],
      subscribed: true,
      blocked: false,
      remark: null,
    })
    const one = (await call('reader', 'get', `${FANS}/${x}`).expect(200)).body.data
    expect(one).toMatchObject({ id: x, openId: open_id, tagIds: [7, 8], blocked: true })
    await call('admin', 'get', `${FANS}/${MISSING}`).expect(404)
    await call('admin', 'get', `${FANS}?accountId=${acc}&sort=remark`).expect(400)
    await call('admin', 'get', `${FANS}?accountId=${acc}&tagId=-1`).expect(400)
  })

  it('the export holds the rows of the same filters, tags by name, flags as yes / no; 403 without fan.export', async () => {
    const acc = await account()
    const t1 = await tag(acc, { name: 'VIP' })
    const t2 = await tag(acc, { name: 'New' })
    const x = await fan(acc, { remark: 'kept', tag_ids: [t1.tagId, t2.tagId, 4242] })
    const y = await fan(acc, { subscribed: 0, blocked: 1, tag_ids: [t1.tagId] })
    await fan(acc, { tag_ids: [t2.tagId] })
    await fan(b, { tag_ids: [t1.tagId] })
    const trace = `${PREFIX}${process.pid}-export`
    const { res, rows } = await exported('admin', `?accountId=${acc}&tagId=${t1.tagId}&sort=id`, {
      'X-Request-Id': trace,
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="fans.xlsx"')
    expect(rows[0]).toEqual(['openid', '备注名', '标签', '是否关注', '是否在黑名单', '创建时间'])
    const listed = (
      await call('admin', 'get', `${FANS}?accountId=${acc}&tagId=${t1.tagId}&sort=id`).expect(200)
    ).body.data.items.map((f: { openId: string }) => f.openId)
    expect(rows.slice(1).map((r) => r[0])).toEqual(listed)
    expect(listed).toEqual([(await fanRow(x)).open_id, (await fanRow(y)).open_id])
    expect(rows[1]!.slice(1, 5)).toEqual(['kept', 'VIP, New, 4242', '是', '否'])
    expect(rows[2]!.slice(2, 5)).toEqual(['VIP', '否', '是'])
    expect(await logOf(ds, trace)).toMatchObject({ domain: 'wxoa.fan', verb: 'export', ok: 1 })
    expect((await exported('reader', `?accountId=${acc}`)).res.status).toBe(403)
    expect((await exported('admin', '')).res.status).toBe(400)
    expect((await exported('admin', `?accountId=${MISSING}`)).res.status).toBe(404)
  })
})

describe('profile on subscribe', () => {
  it('a subscribe fed to the hub completes the profile once through user/info; the subscription stays as written', async () => {
    const oid = openId()
    const subscribedAt = new Date('2026-10-01T08:00:00.000Z')
    const id = await fan(a, {
      open_id: oid,
      subscribed_at: subscribedAt,
      qr_scene: 'from-callback',
    })
    fake.on(
      INFO,
      info(oid, {
        remark: 'friend',
        tagid_list: [3, 'x', -1],
        language: 'en',
        subscribe_time: 1_600_000_000,
        qr_scene_str: 'from-wechat',
      }),
    )
    await app.get(WxoaInboundHub).emit(inbound(a, oid))
    expect(fake.callsTo(INFO)).toEqual([
      expect.objectContaining({ accountId: a, query: { openid: oid, lang: 'zh_CN' } }),
    ])
    const row = await fanRow(id)
    expect(row).toMatchObject({
      union_id: `u${oid}`,
      remark: 'friend',
      lang: 'en',
      tag_ids: [3],
      subscribe_scene: 'ADD_SCENE_QR_CODE',
      subscribed: 1,
      qr_scene: 'from-callback',
    })
    expect(row.subscribed_at).toEqual(subscribedAt)
    expect(row.synced_at).not.toBeNull()
  })

  it('other messages and events ask nothing; an unsubscribed answer or a disabled account writes nothing', async () => {
    const oid = openId()
    const id = await fan(a, { open_id: oid })
    fake.on(INFO, info(oid))
    const hub = app.get(WxoaInboundHub)
    await hub.emit(inbound(a, oid, { msgKind: 'text', eventKind: null }))
    for (const eventKind of ['SCAN', 'unsubscribe', 'CLICK', 'TEMPLATESENDJOBFINISH'])
      await hub.emit(inbound(a, oid, { eventKind }))
    expect(fake.calls).toEqual([])
    fake.on(INFO, { subscribe: 0, openid: oid })
    await hub.emit(inbound(a, oid))
    expect((await fanRow(id)).synced_at).toBeNull()
    const offFan = openId()
    await fan(off, { open_id: offFan })
    await hub.emit(inbound(off, offFan))
    fake.on(INFO, upstreamError(40003))
    await hub.emit(inbound(a, oid))
    expect(fake.callsTo(INFO).map((c) => c.accountId)).toEqual([a, a])
    expect((await fanRow(id)).synced_at).toBeNull()
  })
})

describe('remark', () => {
  it('goes to updateremark, then here; an empty one clears it; a refusal changes nothing', async () => {
    const id = await fan(a)
    const { open_id } = await fanRow(id)
    fake.on(REMARK, ok)
    await call('editor', 'put', `${FANS}/${id}/remark`, { remark: ' Mr. Li ' }).expect(200)
    expect(fake.callsTo(REMARK)[0]).toMatchObject({
      accountId: a,
      body: { openid: open_id, remark: 'Mr. Li' },
    })
    expect((await fanRow(id)).remark).toBe('Mr. Li')
    fake.on(REMARK, upstreamError(40003))
    await call('editor', 'put', `${FANS}/${id}/remark`, { remark: 'other' }).expect(422)
    expect((await fanRow(id)).remark).toBe('Mr. Li')
    fake.on(REMARK, ok)
    await call('editor', 'put', `${FANS}/${id}/remark`, { remark: '' }).expect(200)
    expect((await fanRow(id)).remark).toBeNull()
  })

  it('400: too long, no remark, an accountId; 404: an unknown fan', async () => {
    const id = await fan(a)
    await call('admin', 'put', `${FANS}/${id}/remark`, { remark: 'x'.repeat(31) }).expect(400)
    await call('admin', 'put', `${FANS}/${id}/remark`, {}).expect(400)
    await call('admin', 'put', `${FANS}/${id}/remark`, { remark: 'x', accountId: a }).expect(400)
    await call('admin', 'put', `${FANS}/${MISSING}/remark`, { remark: 'x' }).expect(404)
    expect(fake.calls).toEqual([])
  })
})

describe('tagging and the blacklist', () => {
  it('tags fans in batches of 50 on WeChat, then here once each; the count follows; untagging takes it off', async () => {
    const acc = await account()
    const t = await tag(acc, { fan_count: 5 })
    const other = await tag(acc)
    const fans: number[] = []
    for (let i = 0; i < 60; i++) fans.push(await fan(acc, i === 0 ? { tag_ids: [t.tagId] } : {}))
    const kept = await fan(acc, { tag_ids: [other.tagId] })
    fake.on(TAGGING, ok)
    fake.on(UNTAGGING, ok)
    await call('editor', 'post', `${FANS}/tagging`, {
      accountId: acc,
      fanIds: [...fans, fans[1]],
      tagId: t.tagId,
      op: 'add',
    }).expect(200)
    const batches = fake.callsTo(TAGGING)
    expect(batches.map((c) => (c.body as { openid_list: string[] }).openid_list.length)).toEqual([
      50, 10,
    ])
    expect(batches[0]!.body).toMatchObject({ tagid: t.tagId })
    for (const id of fans) expect((await fanRow(id)).tag_ids).toEqual([t.tagId])
    expect((await fanRow(kept)).tag_ids).toEqual([other.tagId])
    expect((await tagRow(t.id)).fan_count).toBe(5 + 59)
    await call('editor', 'post', `${FANS}/tagging`, {
      accountId: acc,
      fanIds: [fans[0], fans[1], kept],
      tagId: t.tagId,
      op: 'remove',
    }).expect(200)
    expect(fake.callsTo(UNTAGGING)[0]!.body).toEqual({
      openid_list: [
        (await fanRow(fans[0]!)).open_id,
        (await fanRow(fans[1]!)).open_id,
        (await fanRow(kept)).open_id,
      ],
      tagid: t.tagId,
    })
    expect((await fanRow(fans[0]!)).tag_ids).toEqual([])
    expect((await fanRow(kept)).tag_ids).toEqual([other.tagId])
    expect((await tagRow(t.id)).fan_count).toBe(5 + 59 - 2)
  })

  it('a refused batch keeps what WeChat took before it', async () => {
    const acc = await account()
    const t = await tag(acc)
    const fans: number[] = []
    for (let i = 0; i < 55; i++) fans.push(await fan(acc))
    fake.on(TAGGING, ok, upstreamError(45159))
    const res = await call('admin', 'post', `${FANS}/tagging`, {
      accountId: acc,
      fanIds: fans,
      tagId: t.tagId,
      op: 'add',
    }).expect(422)
    expect(res.body.code).toBe(Err.WXOA_UPSTREAM_REFUSED.code)
    expect((await fanRow(fans[49]!)).tag_ids).toEqual([t.tagId])
    expect((await fanRow(fans[50]!)).tag_ids).toBeNull()
  })

  it('tagOpenIds, for QR code scans, tags the fans of those openids', async () => {
    const acc = await account()
    const t = await tag(acc)
    const id = await fan(acc)
    const { open_id } = await fanRow(id)
    fake.on(TAGGING, ok)
    const fans = app.get(WxoaFanService)
    await inTenant1(() => fans.tagOpenIds(acc, [open_id, 'oUnknown'], t.tagId, 'add'))
    expect(fake.callsTo(TAGGING)[0]!.body).toEqual({ openid_list: [open_id], tagid: t.tagId })
    expect((await fanRow(id)).tag_ids).toEqual([t.tagId])
    const otherTag = await tag(b)
    await expect(
      inTenant1(() => fans.tagOpenIds(acc, [open_id], otherTag.tagId, 'add')),
    ).rejects.toThrow()
  })

  it('blacklists in batches of 20 on WeChat, then here; frees them again', async () => {
    const acc = await account()
    const fans: number[] = []
    for (let i = 0; i < 25; i++) fans.push(await fan(acc))
    fake.on(BLOCK, ok)
    fake.on(UNBLOCK, ok)
    await call('editor', 'post', `${FANS}/blocking`, {
      accountId: acc,
      fanIds: fans,
      blocked: true,
    }).expect(200)
    expect(
      fake.callsTo(BLOCK).map((c) => (c.body as { openid_list: string[] }).openid_list.length),
    ).toEqual([20, 5])
    for (const id of fans) expect((await fanRow(id)).blocked).toBe(1)
    await call('editor', 'post', `${FANS}/blocking`, {
      accountId: acc,
      fanIds: [fans[3]],
      blocked: false,
    }).expect(200)
    expect(fake.callsTo(UNBLOCK)[0]!.body).toEqual({
      openid_list: [(await fanRow(fans[3]!)).open_id],
    })
    expect((await fanRow(fans[3]!)).blocked).toBe(0)
    expect((await fanRow(fans[4]!)).blocked).toBe(1)
  })

  it("400: too many fans, an unknown op, no tag; 404: another account's fan or tag, nothing sent", async () => {
    const mine = await fan(a)
    const theirs = await fan(b)
    const t = await tag(a)
    const tb = await tag(b)
    const tagging = (body: object) =>
      call('admin', 'post', `${FANS}/tagging`, {
        accountId: a,
        fanIds: [mine],
        tagId: t.tagId,
        op: 'add',
        ...body,
      })
    const many = Array.from({ length: 201 }, (_, i) => i + 1)
    await tagging({ fanIds: many }).expect(400)
    await tagging({ fanIds: [] }).expect(400)
    await tagging({ op: 'toggle' }).expect(400)
    await tagging({ tagId: undefined }).expect(400)
    await tagging({ fanIds: [mine, theirs] }).expect(404)
    await tagging({ tagId: tb.tagId }).expect(404)
    await tagging({ tagId: 4242 }).expect(404)
    const blocking = (body: object) =>
      call('admin', 'post', `${FANS}/blocking`, {
        accountId: a,
        fanIds: [mine],
        blocked: true,
        ...body,
      })
    await blocking({ fanIds: many }).expect(400)
    await blocking({ blocked: 'yes' }).expect(400)
    await blocking({ fanIds: [theirs] }).expect(404)
    await blocking({ fanIds: [mine, MISSING] }).expect(404)
    expect(fake.calls).toEqual([])
  })
})

describe('tags', () => {
  it("lists the account's tags; a new one is made on WeChat first; at the cap → 422 without a call", async () => {
    const acc = await account()
    const t2 = await tag(acc, { tag_id: 2, name: '星标组' })
    await tag(b)
    fake.on(TAG_CREATE, (c) => ({
      tag: { id: 90_000, name: (c.body as { tag: { name: string } }).tag.name },
    }))
    const created = (
      await call('admin', 'post', TAGS, { accountId: acc, name: ' Gold ' }).expect(201)
    ).body.data
    expect(fake.callsTo(TAG_CREATE)[0]!.body).toEqual({ tag: { name: 'Gold' } })
    expect(created).toMatchObject({ accountId: acc, tagId: 90_000, name: 'Gold', fanCount: 0 })
    const list = (await call('reader', 'get', `${TAGS}?accountId=${acc}`).expect(200)).body.data
    expect(list.map((t: { id: number }) => t.id)).toEqual([t2.id, created.id])
    fake.on(TAG_CREATE, { tag: { name: 'no id' } })
    const bad = await call('admin', 'post', TAGS, { accountId: acc, name: unique().slice(-20) })
    expect(bad.body.code).toBe(Err.WXOA_UPSTREAM.code)
    for (let i = list.length; i < WXOA_TAGS_MAX; i++) await tag(acc)
    fake.reset()
    const full = await call('admin', 'post', TAGS, { accountId: acc, name: 'one more' }).expect(422)
    expect(full.body.code).toBe(Err.UNPROCESSABLE.code)
    expect(fake.calls).toEqual([])
    await call('admin', 'post', TAGS, { accountId: acc, name: 'x'.repeat(31) }).expect(400)
    await call('admin', 'post', TAGS, { accountId: acc, name: ' ' }).expect(400)
    await call('admin', 'post', TAGS, { name: 'x' }).expect(400)
  })

  it('renames on WeChat, then here; a reserved tag → 422; an accountId or an empty name → 400', async () => {
    const acc = await account()
    const t = await tag(acc)
    const reserved = await tag(acc, { tag_id: 1 })
    fake.on(TAG_UPDATE, ok)
    await call('editor', 'put', `${TAGS}/${t.id}`, { name: 'Renamed' }).expect(200)
    expect(fake.callsTo(TAG_UPDATE)[0]!.body).toEqual({ tag: { id: t.tagId, name: 'Renamed' } })
    expect((await tagRow(t.id)).name).toBe('Renamed')
    fake.on(TAG_UPDATE, upstreamError(45157))
    await call('editor', 'put', `${TAGS}/${t.id}`, { name: 'Taken' }).expect(422)
    expect((await tagRow(t.id)).name).toBe('Renamed')
    fake.reset()
    await call('admin', 'put', `${TAGS}/${reserved.id}`, { name: 'Mine' }).expect(422)
    await call('admin', 'delete', `${TAGS}/${reserved.id}`).expect(422)
    await call('admin', 'put', `${TAGS}/${t.id}`, { name: 'x', accountId: acc }).expect(400)
    await call('admin', 'put', `${TAGS}/${t.id}`, { name: '' }).expect(400)
    await call('admin', 'put', `${TAGS}/${MISSING}`, { name: 'x' }).expect(404)
    expect(fake.calls).toEqual([])
    expect((await tagRow(reserved.id)).deleted_at).toBeNull()
  })

  it('a deleted tag leaves its fans; WeChat refusing the delete keeps both', async () => {
    const acc = await account()
    const t = await tag(acc)
    const other = await tag(acc)
    const x = await fan(acc, { tag_ids: [other.tagId, t.tagId] })
    const y = await fan(acc, { tag_ids: [t.tagId] })
    fake.on(TAG_DELETE, upstreamError(45057))
    await call('admin', 'delete', `${TAGS}/${t.id}`).expect(422)
    expect((await tagRow(t.id)).deleted_at).toBeNull()
    expect((await fanRow(x)).tag_ids).toEqual([other.tagId, t.tagId])
    // while WeChat answers, the fan rows stay free for callback writes of the account
    fake.on(TAG_DELETE, async () => {
      await ds.query('SELECT id FROM wxoa_fan WHERE id IN (?) FOR UPDATE NOWAIT', [[x, y]])
      return ok
    })
    await call('admin', 'delete', `${TAGS}/${t.id}`).expect(200)
    expect(fake.callsTo(TAG_DELETE).at(-1)!.body).toEqual({ tag: { id: t.tagId } })
    expect((await tagRow(t.id)).deleted_at).not.toBeNull()
    expect((await fanRow(x)).tag_ids).toEqual([other.tagId])
    expect((await fanRow(y)).tag_ids).toEqual([])
    await call('admin', 'delete', `${TAGS}/${t.id}`).expect(404)
  })

  it("a sync replaces the account's tags with WeChat's: names and counts, new ones, gone ones deleted", async () => {
    const acc = await account()
    const kept = await tag(acc, { name: 'old name', fan_count: 1 })
    const gone = await tag(acc)
    const x = await fan(acc, { tag_ids: [gone.tagId, kept.tagId] })
    fake.on(TAG_GET, {
      tags: [
        { id: 2, name: '星标组', count: 0 },
        { id: kept.tagId, name: 'new name', count: 12 },
        { id: 99_999, name: 'brand new', count: 3 },
        { id: 'bad', name: 'skipped' },
      ],
    })
    const list = (await call('admin', 'post', `${TAGS}/sync`, { accountId: acc }).expect(200)).body
      .data
    expect(
      list.map((t: { tagId: number; name: string; fanCount: number }) => [
        t.tagId,
        t.name,
        t.fanCount,
      ]),
    ).toEqual([
      [2, '星标组', 0],
      [kept.tagId, 'new name', 12],
      [99_999, 'brand new', 3],
    ])
    expect(list.find((t: { tagId: number }) => t.tagId === kept.tagId).id).toBe(kept.id)
    expect((await tagRow(gone.id)).deleted_at).not.toBeNull()
    expect((await fanRow(x)).tag_ids).toEqual([kept.tagId])
  })
})

describe('full sync', () => {
  it('pages user/get, asks batchget per 100, writes every fan; the ones not seen are marked unsubscribed; the blacklist is mirrored', async () => {
    const acc = await account()
    const known = openId()
    const knownId = await fan(acc, { open_id: known, remark: 'old', tag_ids: [9] })
    const goneId = await fan(acc, { subscribed_at: new Date('2026-01-01T00:00:00Z') })
    const blockedBefore = await fan(acc, { blocked: 1 })
    await fan(b)
    const first = Array.from({ length: 149 }, openId)
    const second = [openId()]
    fake.on(USER_GET, listing([[known, ...first], second]))
    fake.on(
      BATCHGET,
      batchget({ [known]: { remark: 'new', tagid_list: [5], qr_scene_str: 'expo' } }),
    )
    fake.on(BLACKLIST, listing([[first[3]!]]))
    const started = (await call('admin', 'post', `${FANS}/sync`, { accountId: acc }).expect(201))
      .body.data
    expect(started).toMatchObject({ state: 'running', done: 0 })
    const progress = await settled(acc)
    expect(progress).toMatchObject({ state: 'done', done: 151, total: 151, code: null })
    expect(fake.callsTo(USER_GET).map((c) => c.query)).toEqual([
      undefined,
      { next_openid: first.at(-1) },
      { next_openid: second[0] },
    ])
    expect(
      fake
        .callsTo(BATCHGET)
        .map((c) => (c.body as { user_list: { lang: string }[] }).user_list.length),
    ).toEqual([100, 50, 1])
    expect(fake.callsTo(BLACKLIST).map((c) => c.body)).toEqual([
      { begin_openid: '' },
      { begin_openid: first[3] },
    ])
    expect(await fanRow(knownId)).toMatchObject({
      subscribed: 1,
      remark: 'new',
      tag_ids: [5],
      qr_scene: 'expo',
      union_id: `u${known}`,
    })
    expect((await fanRow(knownId)).subscribed_at).toEqual(new Date(1_700_000_000_000))
    const added = await fanByOpenId(acc, second[0]!)
    expect(added).toMatchObject({ subscribed: 1, lang: 'zh_CN', blocked: 0 })
    expect(added.synced_at).not.toBeNull()
    expect((await fanByOpenId(acc, first[3]!)).blocked).toBe(1)
    expect((await fanRow(blockedBefore)).blocked).toBe(0)
    expect((await fanRow(goneId)).subscribed).toBe(0)
    expect(
      Number(
        (await ds.query('SELECT COUNT(*) AS n FROM wxoa_fan WHERE account_id = ?', [acc]))[0].n,
      ),
    ).toBe(153)
  })

  it('what the callback writes during the round wins: a new subscriber stays subscribed, a new unsubscriber unsubscribed', async () => {
    const acc = await account()
    const lister = openId()
    const leaver = openId()
    const leaverId = await fan(acc, {
      open_id: leaver,
      subscribed_at: new Date('2026-01-01T00:00:00Z'),
    })
    const joiner = openId()
    let joinerId = 0
    fake.on(USER_GET, listing([[lister, leaver]]))
    fake.on(BATCHGET, async (c) => {
      // meanwhile the callback: the leaver unsubscribes, a new fan subscribes (not in this round's list)
      await ds.query('UPDATE wxoa_fan SET subscribed = 0, unsubscribed_at = NOW(3) WHERE id = ?', [
        leaverId,
      ])
      joinerId = await fan(acc, { open_id: joiner, subscribed_at: new Date() })
      return batchget({ [leaver]: { remark: 'profile still written' } })(c)
    })
    fake.on(BLACKLIST, listing([]))
    await call('admin', 'post', `${FANS}/sync`, { accountId: acc }).expect(201)
    expect((await settled(acc)).state).toBe('done')
    expect(await fanRow(leaverId)).toMatchObject({ subscribed: 0, remark: 'profile still written' })
    expect((await fanRow(leaverId)).subscribed_at).toEqual(new Date('2026-01-01T00:00:00Z'))
    expect((await fanRow(joinerId)).subscribed).toBe(1)
    expect((await fanByOpenId(acc, lister)).subscribed).toBe(1)
  })

  it('a round that fails marks nobody unsubscribed and keeps its error code', async () => {
    const acc = await account()
    const stay = await fan(acc)
    fake.on(USER_GET, listing([[openId()], [openId()]]))
    fake.on(BATCHGET, batchget(), upstreamError(45009))
    await call('admin', 'post', `${FANS}/sync`, { accountId: acc }).expect(201)
    expect(await settled(acc)).toMatchObject({
      state: 'failed',
      done: 1,
      code: Err.WXOA_QUOTA_EXCEEDED.code,
    })
    expect((await fanRow(stay)).subscribed).toBe(1)
    expect(fake.callsTo(BLACKLIST)).toEqual([])
  })

  it('two app instances: one sync per account at a time (409 B6010 on the other); another account runs alongside', async () => {
    const acc = await account()
    const other = await account()
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WxoaGateway)
      .useValue(fake.gateway)
      .compile()
    const second = setupApp(
      moduleRef.createNestApplication<NestExpressApplication>({ logger: false }),
    )
    await second.init()
    try {
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      fake.on(USER_GET, async () => {
        await held
        return listing([])()
      })
      fake.on(BLACKLIST, listing([]))
      const start = (target: NestExpressApplication, accountId: number) =>
        request(target.getHttpServer())
          .post(`${FANS}/sync`)
          .set(bearer(tokens.admin))
          .send({ accountId })
      const [one, two] = await Promise.all([start(app, acc), start(second, acc)])
      expect([one.status, two.status].sort()).toEqual([201, 409])
      expect((one.status === 409 ? one : two).body.code).toBe(Err.WXOA_SYNC_RUNNING.code)
      await start(second, other).expect(201)
      expect(
        (await call('admin', 'get', `${FANS}/sync?accountId=${acc}`).expect(200)).body.data.state,
      ).toBe('running')
      release()
      expect((await settled(acc)).state).toBe('done')
      expect((await settled(other)).state).toBe('done')
      await start(second, acc).expect(201)
      expect((await settled(acc)).state).toBe('done')
    } finally {
      await second.close()
    }
  })

  it('a run left by a stopped instance reads interrupted and may run again', async () => {
    const acc = await account()
    await redis.set(
      redisKey('wxoa', 'sync', acc, 'fan'),
      JSON.stringify({
        state: 'running',
        done: 3,
        total: 9,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        code: null,
      }),
    )
    expect(
      (await call('reader', 'get', `${FANS}/sync?accountId=${acc}`).expect(200)).body.data,
    ).toMatchObject({ state: 'interrupted', done: 3 })
    fake.on(USER_GET, listing([]))
    fake.on(BLACKLIST, listing([]))
    await call('admin', 'post', `${FANS}/sync`, { accountId: acc }).expect(201)
    expect((await settled(acc)).state).toBe('done')
    const fresh = await account()
    expect(
      (await call('admin', 'get', `${FANS}/sync?accountId=${fresh}`).expect(200)).body.data,
    ).toEqual({
      state: 'idle',
      done: 0,
      total: null,
      startedAt: null,
      finishedAt: null,
      code: null,
    })
  })

  it('the nightly job (fired as the scheduler fires it, no tenant around it) syncs every enabled account, skipping one whose sync is running', async () => {
    fake.on(USER_GET, listing([]))
    fake.on(BLACKLIST, listing([]))
    const busy = await account()
    const lease = await app
      .get(RedisLock)
      .acquire(redisKey('lock', `wxoa-sync-fan-${busy}`), 30_000)
    let lines: string[] = []
    try {
      const [{ id: task }] = await ds.query(
        "SELECT id FROM job_task WHERE handler = 'wxoa.fan.sync' AND deleted_at IS NULL",
      )
      await app.get(JobScheduler).fire(Number(task), Date.now(), 'manual')
      const [run] = await ds.query(
        'SELECT outcome, output FROM job_run WHERE task_id = ? ORDER BY id DESC LIMIT 1',
        [task],
      )
      expect(run.outcome).toBe('ok')
      lines = String(run.output).split('\n')
      const out = lines.at(-1)
      const enabled = Number(
        (
          await ds.query(
            'SELECT COUNT(*) AS n FROM wxoa_account WHERE enabled = 1 AND deleted_at IS NULL',
          )
        )[0].n,
      )
      expect(out).toBe(`${enabled - 1} of ${enabled} accounts synced`)
    } finally {
      await lease!.release()
    }
    expect(lines).toContain(`account ${busy}: a sync is running, skipped`)
    expect(lines).toContain(`account ${a}: done`)
    expect(lines.some((l) => l.startsWith(`account ${off}:`))).toBe(false)
    expect(fake.callsTo(USER_GET).some((c) => c.accountId === busy)).toBe(false)
    expect((await settled(a)).state).toBe('done')
  })
})

describe('the account', () => {
  it('an unknown or deleted account → 404 on every route; a disabled one → B6011; no accountId → 400', async () => {
    const gone = await account()
    const goneFan = await fan(gone)
    const goneTag = await tag(gone)
    const offFan = await fan(off)
    const offTag = await tag(off)
    await ds.query('UPDATE wxoa_account SET deleted_at = NOW(3) WHERE id = ?', [gone])
    const byAccount = (acc: number, fanId: number, tagId: number) =>
      [
        ['get', `${FANS}?accountId=${acc}`, undefined],
        ['get', `${FANS}/sync?accountId=${acc}`, undefined],
        ['post', `${FANS}/sync`, { accountId: acc }],
        ['post', `${FANS}/tagging`, { accountId: acc, fanIds: [fanId], tagId, op: 'add' }],
        ['post', `${FANS}/blocking`, { accountId: acc, fanIds: [fanId], blocked: true }],
        ['get', `${TAGS}?accountId=${acc}`, undefined],
        ['post', TAGS, { accountId: acc, name: unique().slice(-20) }],
        ['post', `${TAGS}/sync`, { accountId: acc }],
      ] as const
    const byRow = (fanId: number, tagRowId: number) =>
      [
        ['get', `${FANS}/${fanId}`, undefined],
        ['put', `${FANS}/${fanId}/remark`, { remark: 'x' }],
        ['put', `${TAGS}/${tagRowId}`, { name: 'x' }],
        ['delete', `${TAGS}/${tagRowId}`, undefined],
      ] as const
    for (const [method, path, body] of [
      ...byAccount(MISSING, goneFan, goneTag.tagId),
      ...byAccount(gone, goneFan, goneTag.tagId),
      ...byRow(goneFan, goneTag.id),
    ])
      await call('admin', method, path, body).expect(404)
    for (const [method, path, body] of [
      ...byAccount(off, offFan, offTag.tagId),
      ...byRow(offFan, offTag.id),
    ]) {
      const res = await call('admin', method, path, body)
      expect([path, res.status]).toEqual([path, Err.WXOA_ACCOUNT_DISABLED.status])
      expect(res.body.code).toBe(Err.WXOA_ACCOUNT_DISABLED.code)
    }
    expect((await tagRow(offTag.id)).deleted_at).toBeNull()
    expect(fake.calls).toEqual([])
    for (const path of [FANS, `${FANS}/sync`, TAGS]) await call('admin', 'get', path).expect(400)
    await call('admin', 'post', `${FANS}/sync`, {}).expect(400)
    await call('admin', 'post', `${TAGS}/sync`, {}).expect(400)
  })
})

describe('403', () => {
  it('without the permission of a route the request is refused', async () => {
    const id = await fan(a)
    const t = await tag(a)
    for (const [method, path] of [
      ['get', `${FANS}?accountId=${a}`],
      ['get', `${FANS}/${id}`],
      ['get', `${FANS}/sync?accountId=${a}`],
      ['get', `${TAGS}?accountId=${a}`],
    ] as const) {
      await call('plain', method, path).expect(403)
      await call('reader', method, path).expect(200)
    }
    const writes = [
      ['put', `${FANS}/${id}/remark`, { remark: 'x' }],
      ['post', `${FANS}/tagging`, { accountId: a, fanIds: [id], tagId: t.tagId, op: 'add' }],
      ['post', `${FANS}/blocking`, { accountId: a, fanIds: [id], blocked: true }],
      ['put', `${TAGS}/${t.id}`, { name: 'x' }],
    ] as const
    for (const [method, path, body] of writes) await call('reader', method, path, body).expect(403)
    for (const who of ['reader', 'editor'] as const) {
      await call(who, 'post', `${FANS}/sync`, { accountId: a }).expect(403)
      await call(who, 'post', `${TAGS}/sync`, { accountId: a }).expect(403)
      await call(who, 'post', TAGS, { accountId: a, name: 'x' }).expect(403)
      await call(who, 'delete', `${TAGS}/${t.id}`).expect(403)
      await call(who, 'get', `${FANS}/export?accountId=${a}`).expect(403)
    }
    expect(fake.calls).toEqual([])
    expect((await tagRow(t.id)).deleted_at).toBeNull()
  })
})

it('every write leaves an action log row with its domain, verb and id', async () => {
  const acc = await account()
  const id = await fan(acc)
  fake.on(REMARK, ok)
  fake.on(TAGGING, ok)
  fake.on(BLOCK, ok)
  fake.on(TAG_CREATE, { tag: { id: 900, name: 'logged' } })
  fake.on(TAG_UPDATE, ok)
  fake.on(TAG_DELETE, ok)
  fake.on(TAG_GET, { tags: [] })
  fake.on(USER_GET, listing([]))
  fake.on(BLACKLIST, listing([]))
  const trace = `${PREFIX}${process.pid}-`
  const created = await call('admin', 'post', TAGS, { accountId: acc, name: 'logged' })
    .set('X-Request-Id', `${trace}c`)
    .expect(201)
  const tagRowId = created.body.data.id
  const tagging = { accountId: acc, fanIds: [id], tagId: 900, op: 'add' }
  const steps = [
    ['r', 'put', `${FANS}/${id}/remark`, { remark: 'x' }, 'wxoa.fan', 'modify', 200],
    ['t', 'post', `${FANS}/tagging`, tagging, 'wxoa.fan', 'modify', 200],
    [
      'b',
      'post',
      `${FANS}/blocking`,
      { accountId: acc, fanIds: [id], blocked: true },
      'wxoa.fan',
      'modify',
      200,
    ],
    ['u', 'put', `${TAGS}/${tagRowId}`, { name: 'renamed' }, 'wxoa.tag', 'modify', 200],
    ['d', 'delete', `${TAGS}/${tagRowId}`, undefined, 'wxoa.tag', 'remove', 200],
    ['s', 'post', `${TAGS}/sync`, { accountId: acc }, 'wxoa.tag', 'sync', 200],
    ['f', 'post', `${FANS}/sync`, { accountId: acc }, 'wxoa.fan', 'sync', 201],
  ] as const
  for (const [suffix, method, path, body, , , status] of steps)
    await call('admin', method, path, body).set('X-Request-Id', `${trace}${suffix}`).expect(status)
  expect(await logOf(ds, `${trace}c`)).toMatchObject({
    domain: 'wxoa.tag',
    verb: 'create',
    biz_id: String(tagRowId),
    ok: 1,
  })
  for (const [suffix, , , , domain, verb] of steps)
    expect(await logOf(ds, `${trace}${suffix}`)).toMatchObject({ domain, verb, ok: 1 })
  expect((await logOf(ds, `${trace}r`))?.biz_id).toBe(String(id))
  await settled(acc)
})

it('Swagger documents every route', async () => {
  const doc = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body
  const paths = (base: string) =>
    Object.keys(doc.paths)
      .filter((p) => p === base || p.startsWith(`${base}/`))
      .sort()
  expect(paths(FANS)).toEqual([
    FANS,
    `${FANS}/blocking`,
    `${FANS}/export`,
    `${FANS}/sync`,
    `${FANS}/tagging`,
    `${FANS}/{id}`,
    `${FANS}/{id}/remark`,
  ])
  expect(Object.keys(doc.paths[`${FANS}/sync`]).sort()).toEqual(['get', 'post'])
  expect(paths(TAGS)).toEqual([TAGS, `${TAGS}/sync`, `${TAGS}/{id}`])
  expect(Object.keys(doc.paths[TAGS]).sort()).toEqual(['get', 'post'])
  expect(Object.keys(doc.paths[`${TAGS}/{id}`]).sort()).toEqual(['delete', 'put'])
})
