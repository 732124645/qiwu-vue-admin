// WeChat Official Account channel QR codes (see docs/design-notes.md#wxoa): create on WeChat with a string
// scene (temporary with its validity, permanent without), the image fetched by its ticket and stored as
// the account's wxoa.media (a failed copy leaves the code without one), one live code per scene and
// account (409 before calling WeChat); rename and change the auto tag (PUT takes neither the account nor
// the scene); delete here only; SCAN and qrscene_ subscribes fed straight to the inbound hub count on the
// code and tag the fan through the fan service (a failed tagging keeps the count); per-day stats from
// the message log in the request's time zone; every route through the account (missing or deleted 404,
// disabled B6011), a tag of another account 404; 403 per permission; 400; @ActionLog. WeChat is a fake
// gateway.
import { randomBytes } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, WXOA_MEDIA_TAG, wxoaPerms } from '@qiwu/shared'
import sharp from 'sharp'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId as findIdRaw, insertRow as insertRowRaw } from '../../src/db/seeds/upsert.js'
import { upstreamError, WxoaGateway } from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import {
  type WxoaInbound,
  WxoaInboundHub,
} from '../../src/modules/platform/wxoa/core/wxoa-inbound-hub.js'
import { fakeWxoaGateway } from '../fixtures/wxoa/fake-gateway.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { inTenant1 } from '../setup/tenants.js'
const findId = (...args: Parameters<typeof findIdRaw>) => inTenant1(() => findIdRaw(...args))
const insertRow = (...args: Parameters<typeof insertRowRaw>) =>
  inTenant1(() => insertRowRaw(...args))

const PREFIX = 'e2e-wxoa-qrcode-'
const URL = '/api/wxoa/qrcodes'
const CREATE = '/cgi-bin/qrcode/create'
const IMAGE = 'qrImage'
const TAGGING = '/cgi-bin/tags/members/batchtagging'
const MISSING = 999_999
/** upstream tags: A has 101, B has 201 */
const TAG_A = 101
const TAG_B = 201

const fake = fakeWxoaGateway()
let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens = { admin: '', reader: '', plain: '' }
const userIds: number[] = []
const accountIds: number[] = []
let roleId: number
/** enabled accounts A and B, a disabled one, a deleted one */
let a: number
let b: number
let off: number
let gone: number
let jpg: Buffer

let seq = 0
const unique = () => `${PREFIX}${++seq}`
const scene = () => `s_${process.pid}-${++seq}`
let ticketSeq = 0
/** qrcode/create's answer: a new ticket and the code's link */
const created = () => {
  const ticket = `gQE-e2e-${++ticketSeq}==`
  return { ticket, expire_seconds: 600, url: `http://weixin.qq.com/q/e2e${ticketSeq}` }
}

const call = (who: keyof typeof tokens, method: 'get' | 'post' | 'put' | 'delete', path = '') =>
  request(app.getHttpServer())[method](`${URL}${path}`).set(bearer(tokens[who]))
const codeRow = async (id: number) =>
  (await ds.query('SELECT * FROM wxoa_qrcode WHERE id = ?', [id]))[0]
const codeCount = async () =>
  Number(
    (
      await ds.query('SELECT COUNT(*) AS n FROM wxoa_qrcode WHERE account_id IN (?)', [accountIds])
    )[0].n,
  )

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
const tag = (accountId: number, tagId: number) =>
  insertRow(ds.manager, 'wxoa_tag', { account_id: accountId, tag_id: tagId, name: unique() })
const fan = async (accountId: number) => {
  const openId = `o${randomBytes(12).toString('hex')}`
  const id = await insertRow(ds.manager, 'wxoa_fan', {
    account_id: accountId,
    open_id: openId,
    subscribed: 1,
  })
  return { id, openId }
}
/** a code written straight into the table (no WeChat call) */
const code = (accountId: number, over: Record<string, unknown> = {}) =>
  insertRow(ds.manager, 'wxoa_qrcode', {
    account_id: accountId,
    label: unique(),
    qr_kind: 'permanent',
    scene: scene(),
    ticket: unique(),
    qr_url: 'http://weixin.qq.com/q/e2e',
    ...over,
  })
const event = (accountId: number, eventKind: string, eventKey: string, occurredAt: Date) =>
  insertRow(ds.manager, 'wxoa_message', {
    account_id: accountId,
    open_id: `o${randomBytes(12).toString('hex')}`,
    direction: 'in',
    channel: 'push',
    msg_kind: 'event',
    event_kind: eventKind,
    event_key: eventKey,
    payload: '{}',
    dedup_key: randomBytes(32).toString('hex'),
    occurred_at: occurredAt,
  })
const inbound = (
  accountId: number,
  openId: string,
  eventKind: string,
  eventKey: string | null,
  msgKind = 'event',
): WxoaInbound => ({
  id: MISSING,
  accountId,
  openId,
  msgKind,
  eventKind,
  eventKey,
  wxMsgId: null,
  payload: {},
  occurredAt: new Date(),
})

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
  jpg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#1f6feb' } })
    .jpeg()
    .toBuffer()
  roleId = await insertRow(ds.manager, 'iam_role', {
    code: `${PREFIX}reader`,
    name: `${PREFIX}reader`,
    data_scope: 'all',
  })
  const browse = await findId(ds.manager, 'iam_menu', { perms: wxoaPerms.qrcode.browse })
  await ds.query('INSERT INTO iam_role_menus (tenant_id, role_id, menu_id) VALUES (1, ?, ?)', [
    roleId,
    browse,
  ])
  tokens.admin = (await signIn(app)).accessToken
  tokens.reader = await user('reader', [roleId])
  tokens.plain = await user('plain', [])
  a = await account()
  b = await account()
  off = await account(false)
  gone = await account()
  await ds.query('UPDATE wxoa_account SET deleted_at = NOW(3) WHERE id = ?', [gone])
  await tag(a, TAG_A)
  await tag(b, TAG_B)
  await tag(off, TAG_A)
})

beforeEach(() => fake.reset())

afterAll(async () => {
  if (ds) {
    if (accountIds.length) {
      for (const table of ['wxoa_qrcode', 'wxoa_message', 'wxoa_fan', 'wxoa_tag'])
        // arch-allow: sql-concat table names are spec constants; ids bound
        await ds.query(`DELETE FROM ${table} WHERE account_id IN (?)`, [accountIds])
      await ds.query('DELETE FROM fs_object WHERE biz_tag = ? AND biz_ref IN (?)', [
        WXOA_MEDIA_TAG,
        accountIds.map((id) => `wxoa:${id}`),
      ])
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

describe('create', () => {
  it('a temporary code: created on WeChat with its validity, the image stored as the account media', async () => {
    fake.on(CREATE, created)
    fake.on(IMAGE, { data: jpg, mime: 'image/jpeg', fileName: null })
    const s = scene()
    const trace = `${PREFIX}${process.pid}-create`
    const before = Date.now()
    const res = await call('admin', 'post')
      .set('X-Request-Id', trace)
      .send({ accountId: a, label: 'Poster', qrKind: 'temporary', scene: s, expireSeconds: 600 })
      .expect(201)
    const row = res.body.data
    expect(row).toMatchObject({
      accountId: a,
      label: 'Poster',
      qrKind: 'temporary',
      scene: s,
      ticket: `gQE-e2e-${ticketSeq}==`,
      qrUrl: `http://weixin.qq.com/q/e2e${ticketSeq}`,
      tagId: null,
      scanCount: 0,
      subscribeCount: 0,
    })
    const expires = Date.parse(row.expiresAt) - before
    expect(expires).toBeGreaterThanOrEqual(600_000)
    expect(expires).toBeLessThan(660_000)
    expect(fake.callsTo(CREATE)).toEqual([
      expect.objectContaining({
        method: 'json',
        accountId: a,
        body: {
          expire_seconds: 600,
          action_name: 'QR_STR_SCENE',
          action_info: { scene: { scene_str: s } },
        },
      }),
    ])
    expect(fake.callsTo(IMAGE)).toEqual([expect.objectContaining({ ticket: row.ticket })])
    const [obj] = await ds.query('SELECT * FROM fs_object WHERE id = ?', [row.objectId])
    expect(obj).toMatchObject({
      biz_tag: WXOA_MEDIA_TAG,
      biz_ref: `wxoa:${a}`,
      uploader_id: 0,
      is_public: 0,
      original_name: `qrcode-${s}.jpg`,
      mime: 'image/jpeg',
    })
    expect(await logOf(ds, trace)).toMatchObject({
      domain: 'wxoa.qrcode',
      verb: 'create',
      biz_id: String(row.id),
      ok: 1,
    })
    // a holder of the QR code browse permission reads the image copy
    await request(app.getHttpServer())
      .get(`/api/storage/objects/${row.objectId}/download`)
      .set(bearer(tokens.reader))
      .expect(200)
  })

  it('a permanent code with an auto tag: no validity sent, none stored', async () => {
    fake.on(CREATE, created)
    fake.on(IMAGE, { data: jpg, mime: 'image/jpeg', fileName: null })
    const s = scene()
    const res = await call('admin', 'post')
      .send({ accountId: a, label: unique(), qrKind: 'permanent', scene: s, tagId: TAG_A })
      .expect(201)
    expect(res.body.data).toMatchObject({ qrKind: 'permanent', expiresAt: null, tagId: TAG_A })
    expect(fake.callsTo(CREATE)[0]!.body).toEqual({
      action_name: 'QR_LIMIT_STR_SCENE',
      action_info: { scene: { scene_str: s } },
    })
  })

  it('an image WeChat does not give leaves the code without a copy', async () => {
    fake.on(CREATE, created)
    fake.on(IMAGE, upstreamError(45009))
    const res = await call('admin', 'post')
      .send({ accountId: a, label: unique(), qrKind: 'permanent', scene: scene() })
      .expect(201)
    expect(res.body.data.objectId).toBeNull()
    expect((await codeRow(res.body.data.id)).object_id).toBeNull()
  })

  it('WeChat refusing or answering no ticket: nothing is recorded, no image fetched', async () => {
    const before = await codeCount()
    fake.on(CREATE, upstreamError(48001))
    const refused = await call('admin', 'post')
      .send({ accountId: a, label: unique(), qrKind: 'permanent', scene: scene() })
      .expect(422)
    expect(refused.body.code).toBe(Err.WXOA_API_UNAUTHORIZED.code)
    fake.on(CREATE, { url: 'http://weixin.qq.com/q/x' })
    const broken = await call('admin', 'post')
      .send({ accountId: a, label: unique(), qrKind: 'permanent', scene: scene() })
      .expect(502)
    expect(broken.body.code).toBe(Err.WXOA_UPSTREAM.code)
    expect(fake.callsTo(IMAGE)).toHaveLength(0)
    expect(await codeCount()).toBe(before)
  })

  it('a scene the account uses → 409 without calling WeChat; another account may use it; a deleted code frees it', async () => {
    fake.on(CREATE, created)
    fake.on(IMAGE, { data: jpg, mime: 'image/jpeg', fileName: null })
    const s = scene()
    const body = (accountId: number) => ({
      accountId,
      label: unique(),
      qrKind: 'permanent',
      scene: s,
    })
    const first = await call('admin', 'post').send(body(a)).expect(201)
    fake.reset()
    const dup = await call('admin', 'post').send(body(a)).expect(409)
    expect(dup.body.code).toBe(Err.DUPLICATE.code)
    expect(fake.calls).toHaveLength(0)
    fake.on(CREATE, created)
    fake.on(IMAGE, { data: jpg, mime: 'image/jpeg', fileName: null })
    await call('admin', 'post').send(body(b)).expect(201)
    await call('admin', 'delete', `/${first.body.data.id}`).expect(200)
    await call('admin', 'post').send(body(a)).expect(201)
  })

  it('400: scene format, validity out of range or given to a permanent code, no account, no label; WeChat not called', async () => {
    const before = await codeCount()
    const base = { accountId: a, label: unique(), qrKind: 'temporary', expireSeconds: 600 }
    for (const body of [
      { ...base, scene: 'has space' },
      { ...base, scene: 'x'.repeat(65) },
      { ...base, scene: '' },
      { ...base, scene: '场景' },
      { ...base, scene: scene(), expireSeconds: 59 },
      { ...base, scene: scene(), expireSeconds: 2_592_001 },
      { ...base, scene: scene(), expireSeconds: undefined },
      { ...base, scene: scene(), qrKind: 'permanent' },
      { ...base, scene: scene(), qrKind: 'forever' },
      { ...base, scene: scene(), accountId: undefined },
      { ...base, scene: scene(), label: '' },
      { ...base, scene: scene(), tagId: -1 },
    ])
      await call('admin', 'post').send(body).expect(400)
    expect(fake.calls).toHaveLength(0)
    expect(await codeCount()).toBe(before)
  })

  it("404: another account's tag, an unknown or deleted account; B6011 when disabled; WeChat not called", async () => {
    const before = await codeCount()
    const body = (accountId: number, tagId?: number) => ({
      accountId,
      label: unique(),
      qrKind: 'permanent',
      scene: scene(),
      tagId,
    })
    await call('admin', 'post').send(body(a, TAG_B)).expect(404)
    await call('admin', 'post').send(body(MISSING)).expect(404)
    await call('admin', 'post').send(body(gone)).expect(404)
    const disabled = await call('admin', 'post').send(body(off)).expect(422)
    expect(disabled.body.code).toBe(Err.WXOA_ACCOUNT_DISABLED.code)
    expect(fake.calls).toHaveLength(0)
    expect(await codeCount()).toBe(before)
  })

  it('the same create twice at once → 429 for the second', async () => {
    fake.on(CREATE, created)
    fake.on(IMAGE, { data: jpg, mime: 'image/jpeg', fileName: null })
    const body = { accountId: a, label: unique(), qrKind: 'permanent', scene: scene() }
    await call('admin', 'post').send(body).expect(201)
    await call('admin', 'post').send(body).expect(429)
    expect(fake.callsTo(CREATE)).toHaveLength(1)
  })
})

describe('list, change and delete', () => {
  it("lists the account's codes, filtered by kind and name", async () => {
    const own = unique()
    const perm = await code(b, { label: `${own}-p` })
    const temp = await code(b, {
      label: `${own}-t`,
      qr_kind: 'temporary',
      expires_at: new Date(Date.now() + 60_000),
    })
    await code(a, { label: `${own}-a` })
    const all = await call('admin', 'get', `?accountId=${b}&label=${own}`).expect(200)
    expect(all.body.data.total).toBe(2)
    expect(all.body.data.items.map((r: { id: number }) => r.id).sort()).toEqual([perm, temp].sort())
    const temporary = await call(
      'admin',
      'get',
      `?accountId=${b}&label=${own}&qrKind=temporary`,
    ).expect(200)
    expect(temporary.body.data.items.map((r: { id: number }) => r.id)).toEqual([temp])
    await call('admin', 'get', '').expect(400)
    await call('admin', 'get', `?accountId=${b}&qrKind=forever`).expect(400)
    await call('admin', 'get', `?accountId=${MISSING}`).expect(404)
    await call('admin', 'get', `?accountId=${gone}`).expect(404)
    const disabled = await call('admin', 'get', `?accountId=${off}`).expect(422)
    expect(disabled.body.code).toBe(Err.WXOA_ACCOUNT_DISABLED.code)
  })

  it('PUT renames and sets or removes the auto tag; the scene and the account stay', async () => {
    const id = await code(a)
    const before = await codeRow(id)
    const trace = `${PREFIX}${process.pid}-modify`
    await call('admin', 'put', `/${id}`)
      .set('X-Request-Id', trace)
      .send({ label: 'Renamed', tagId: TAG_A })
      .expect(200)
    expect(await codeRow(id)).toMatchObject({
      label: 'Renamed',
      tag_id: TAG_A,
      scene: before.scene,
      account_id: a,
    })
    expect(await logOf(ds, trace)).toMatchObject({ domain: 'wxoa.qrcode', verb: 'modify', ok: 1 })
    await call('admin', 'put', `/${id}`).send({ label: 'Renamed', tagId: null }).expect(200)
    expect((await codeRow(id)).tag_id).toBeNull()
    await call('admin', 'put', `/${id}`).send({ label: 'Again' }).expect(200)
    expect(await codeRow(id)).toMatchObject({ label: 'Again', tag_id: null })
    expect(fake.calls).toHaveLength(0)
  })

  it("PUT 400 with the account, the scene or no name; 404 for another account's tag or an unknown code; B6011 when disabled", async () => {
    const id = await code(a, { tag_id: TAG_A })
    const before = await codeRow(id)
    await call('admin', 'put', `/${id}`).send({ label: 'x', accountId: b }).expect(400)
    await call('admin', 'put', `/${id}`).send({ label: 'x', scene: 'other' }).expect(400)
    await call('admin', 'put', `/${id}`).send({ label: '' }).expect(400)
    await call('admin', 'put', `/${id}`).send({ label: 'x', tagId: TAG_B }).expect(404)
    await call('admin', 'put', `/${MISSING}`).send({ label: 'x' }).expect(404)
    expect(await codeRow(id)).toEqual(before)
    const ofGone = await code(gone)
    await call('admin', 'put', `/${ofGone}`).send({ label: 'x' }).expect(404)
    const ofOff = await code(off)
    const disabled = await call('admin', 'put', `/${ofOff}`).send({ label: 'x' }).expect(422)
    expect(disabled.body.code).toBe(Err.WXOA_ACCOUNT_DISABLED.code)
  })

  it('DELETE removes the local row only; again → 404; B6011 when disabled', async () => {
    const id = await code(a)
    const trace = `${PREFIX}${process.pid}-remove`
    await call('admin', 'delete', `/${id}`).set('X-Request-Id', trace).expect(200)
    expect((await codeRow(id)).deleted_at).not.toBeNull()
    expect(fake.calls).toHaveLength(0)
    expect(await logOf(ds, trace)).toMatchObject({ domain: 'wxoa.qrcode', verb: 'remove', ok: 1 })
    await call('admin', 'delete', `/${id}`).expect(404)
    await call('admin', 'delete', `/${await code(gone)}`).expect(404)
    const ofOff = await code(off)
    const disabled = await call('admin', 'delete', `/${ofOff}`).expect(422)
    expect(disabled.body.code).toBe(Err.WXOA_ACCOUNT_DISABLED.code)
    expect((await codeRow(ofOff)).deleted_at).toBeNull()
  })

  it("DELETE also deletes the code's image copy; another account's object stays", async () => {
    fake.on(CREATE, created)
    fake.on(IMAGE, { data: jpg, mime: 'image/jpeg', fileName: null })
    const create = async (accountId: number) =>
      (
        await call('admin', 'post')
          .send({ accountId, label: unique(), qrKind: 'permanent', scene: scene() })
          .expect(201)
      ).body.data as { id: number; objectId: number }
    const objectGone = async (id: number) =>
      (await ds.query('SELECT deleted_at FROM fs_object WHERE id = ?', [id]))[0].deleted_at !== null
    const mine = await create(a)
    await call('admin', 'delete', `/${mine.id}`).expect(200)
    expect(await objectGone(mine.objectId)).toBe(true)
    const ofB = await create(b)
    const wrong = await code(a, { object_id: ofB.objectId })
    await call('admin', 'delete', `/${wrong}`).expect(200)
    expect((await codeRow(wrong)).deleted_at).not.toBeNull()
    expect(await objectGone(ofB.objectId)).toBe(false)
  })
})

describe('scans (inbound hub)', () => {
  it('SCAN counts scans, a qrscene_ subscribe counts subscribes; each tags the fan with the code tag', async () => {
    const hub = app.get(WxoaInboundHub)
    fake.on(TAGGING, { errcode: 0, errmsg: 'ok' })
    fake.on('/cgi-bin/user/info', { subscribe: 0 })
    const s = scene()
    const id = await code(a, { scene: s, tag_id: TAG_A })
    const f = await fan(a)
    await hub.emit(inbound(a, f.openId, 'SCAN', s))
    await hub.emit(inbound(a, f.openId, 'SCAN', s))
    await hub.emit(inbound(a, f.openId, 'subscribe', `qrscene_${s}`))
    expect(await codeRow(id)).toMatchObject({ scan_count: 2, subscribe_count: 1 })
    expect(fake.callsTo(TAGGING)).toHaveLength(3)
    for (const c of fake.callsTo(TAGGING))
      expect(c).toMatchObject({ accountId: a, body: { openid_list: [f.openId], tagid: TAG_A } })
    const [fanRow] = await ds.query('SELECT tag_ids FROM wxoa_fan WHERE id = ?', [f.id])
    expect(fanRow.tag_ids).toEqual([TAG_A])
  })

  it('a code without a tag counts and tags no one', async () => {
    const hub = app.get(WxoaInboundHub)
    const s = scene()
    const id = await code(a, { scene: s })
    await hub.emit(inbound(a, (await fan(a)).openId, 'SCAN', s))
    expect((await codeRow(id)).scan_count).toBe(1)
    expect(fake.callsTo(TAGGING)).toHaveLength(0)
  })

  it('a failed tagging keeps the count', async () => {
    const hub = app.get(WxoaInboundHub)
    fake.on(TAGGING, upstreamError(45009))
    const s = scene()
    const id = await code(a, { scene: s, tag_id: TAG_A })
    const f = await fan(a)
    await hub.emit(inbound(a, f.openId, 'SCAN', s))
    expect((await codeRow(id)).scan_count).toBe(1)
    expect(fake.callsTo(TAGGING)).toHaveLength(1)
    expect((await ds.query('SELECT tag_ids FROM wxoa_fan WHERE id = ?', [f.id]))[0].tag_ids).toBe(
      null,
    )
  })

  it('other events, keys, accounts and deleted codes count nothing', async () => {
    const hub = app.get(WxoaInboundHub)
    fake.on('/cgi-bin/user/info', { subscribe: 0 })
    const s = scene()
    const id = await code(a, { scene: s, tag_id: TAG_A })
    const deleted = await code(a, { deleted_at: new Date() })
    const openId = (await fan(a)).openId
    for (const row of [
      inbound(a, openId, 'subscribe', s),
      inbound(a, openId, 'subscribe', null),
      inbound(a, openId, 'CLICK', s),
      inbound(a, openId, 'SCAN', `qrscene_${s}`),
      inbound(a, openId, 'SCAN', `${s} `),
      inbound(a, openId, 'SCAN', null),
      inbound(a, openId, 'SCAN', s, 'text'),
      inbound(b, openId, 'SCAN', s),
      inbound(a, openId, 'SCAN', (await codeRow(deleted)).scene),
    ])
      await hub.emit(row)
    expect(await codeRow(id)).toMatchObject({ scan_count: 0, subscribe_count: 0 })
    expect(await codeRow(deleted)).toMatchObject({ scan_count: 0, subscribe_count: 0 })
    expect(fake.callsTo(TAGGING)).toHaveLength(0)
  })
})

describe('stats', () => {
  /** today in Shanghai, and the instant it began */
  const shanghai = () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
    return { today, start: Date.parse(`${today}T00:00:00+08:00`) }
  }
  const dayBefore = (day: string, n: number) =>
    new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10)
  const HOUR = 3_600_000

  it("counts scans and subscribes per day in the request's time zone, the last `days` days", async () => {
    const s = scene()
    const id = await code(a, { scene: s })
    const { today, start } = shanghai()
    const at = (ms: number) => new Date(start + ms)
    await event(a, 'SCAN', s, at(0))
    await event(a, 'subscribe', `qrscene_${s}`, at(0))
    await event(a, 'SCAN', s, at(-1))
    await event(a, 'SCAN', s, at(-9 * HOUR))
    await event(a, 'SCAN', s, at(-17 * HOUR))
    // before Shanghai's window, inside UTC's
    await event(a, 'SCAN', s, at(-2 * 24 * HOUR - 1))
    // not this code's
    await event(a, 'SCAN', scene(), at(0))
    await event(a, 'subscribe', s, at(0))
    await event(a, 'CLICK', s, at(0))
    await event(b, 'SCAN', s, at(0))
    const sh = await call('admin', 'get', `/${id}/stats?days=3`)
      .set('X-Timezone', 'Asia/Shanghai')
      .expect(200)
    expect(sh.body.data).toEqual([
      { day: dayBefore(today, 2), scans: 0, subscribes: 0 },
      { day: dayBefore(today, 1), scans: 3, subscribes: 0 },
      { day: today, scans: 1, subscribes: 1 },
    ])
    // in UTC Shanghai's midnight is 16:00 of the day before: the day boundaries move
    const utc = await call('admin', 'get', `/${id}/stats?days=4`)
      .set('X-Timezone', 'UTC')
      .expect(200)
    const of = (day: string) => utc.body.data.find((d: { day: string }) => d.day === day)
    expect(utc.body.data).toHaveLength(4)
    expect(of(dayBefore(today, 1))).toEqual({ day: dayBefore(today, 1), scans: 3, subscribes: 1 })
    expect(of(dayBefore(today, 2))).toEqual({ day: dayBefore(today, 2), scans: 1, subscribes: 0 })
    expect(of(dayBefore(today, 3))).toEqual({ day: dayBefore(today, 3), scans: 1, subscribes: 0 })
    const total = utc.body.data.reduce(
      (sum: number, d: { scans: number; subscribes: number }) => sum + d.scans + d.subscribes,
      0,
    )
    expect(total).toBe(6)
  })

  it('scenes differing only in case count apart', async () => {
    const s = `C${scene()}`
    const upper = await code(a, { scene: s })
    const lower = await code(a, { scene: s.toLowerCase() })
    const now = new Date()
    await event(a, 'SCAN', s.toLowerCase(), now)
    await event(a, 'SCAN', s.toLowerCase(), now)
    await event(a, 'subscribe', `qrscene_${s.toLowerCase()}`, now)
    await event(a, 'SCAN', s, now)
    const sum = async (id: number) => {
      const res = await call('admin', 'get', `/${id}/stats?days=2`).expect(200)
      return res.body.data.reduce(
        (t: { scans: number; subscribes: number }, d: { scans: number; subscribes: number }) => ({
          scans: t.scans + d.scans,
          subscribes: t.subscribes + d.subscribes,
        }),
        { scans: 0, subscribes: 0 },
      )
    }
    expect(await sum(upper)).toEqual({ scans: 1, subscribes: 0 })
    expect(await sum(lower)).toEqual({ scans: 2, subscribes: 1 })
  })

  it('30 days unless asked; 400 outside 1–90; 404 for an unknown code or a deleted account; B6011 when disabled', async () => {
    const id = await code(a)
    const res = await call('admin', 'get', `/${id}/stats`).expect(200)
    expect(res.body.data).toHaveLength(30)
    expect(res.body.data.every((d: { scans: number }) => d.scans === 0)).toBe(true)
    await call('admin', 'get', `/${id}/stats?days=0`).expect(400)
    await call('admin', 'get', `/${id}/stats?days=91`).expect(400)
    await call('admin', 'get', `/${id}/stats?days=90`).expect(200)
    await call('admin', 'get', `/${MISSING}/stats`).expect(404)
    await call('admin', 'get', `/${await code(gone)}/stats`).expect(404)
    const disabled = await call('admin', 'get', `/${await code(off)}/stats`).expect(422)
    expect(disabled.body.code).toBe(Err.WXOA_ACCOUNT_DISABLED.code)
  })
})

describe('permissions', () => {
  it('403 per permission: browse reads, create, modify and remove write', async () => {
    const id = await code(a)
    const body = { accountId: a, label: unique(), qrKind: 'permanent', scene: scene() }
    await call('plain', 'get', `?accountId=${a}`).expect(403)
    await call('plain', 'get', `/${id}/stats`).expect(403)
    await call('reader', 'get', `?accountId=${a}`).expect(200)
    await call('reader', 'get', `/${id}/stats`).expect(200)
    for (const who of ['plain', 'reader'] as const) {
      await call(who, 'post').send(body).expect(403)
      await call(who, 'put', `/${id}`).send({ label: 'x' }).expect(403)
      await call(who, 'delete', `/${id}`).expect(403)
    }
    expect(fake.calls).toHaveLength(0)
    expect((await codeRow(id)).deleted_at).toBeNull()
  })

  it('Swagger documents every route', async () => {
    const doc = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body
    expect(
      Object.keys(doc.paths)
        .filter((p) => p.startsWith(URL))
        .sort(),
    ).toEqual([URL, `${URL}/{id}`, `${URL}/{id}/stats`])
  })
})
