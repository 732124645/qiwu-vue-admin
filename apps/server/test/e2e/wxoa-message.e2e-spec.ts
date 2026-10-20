// WeChat Official Account messages (see docs/design-notes.md#wxoa): the message log; conversations (the
// account's fans by their last message, one fan's messages with a cursor, its two send windows read from
// the fan row the callback wrote); customer-service sending (one window open by time, else B6007 without a
// call; WeChat's window refusal B6007 too; media only from the account's own materials or its own
// wxoa.media objects, any other object 404 also when a temporary media_id is cached; a pending row
// settled by WeChat's answer, never an object_id); the inbound hub fed straight with rows (media copies as
// the account's wxoa.media, switched by wxoa.media.copy_inbound, and the realtime hint); the purge job
// (retention, steps, copies of inbound rows only, 0 keeps all, stale pending rows failed, an aborted
// signal stops it); every route through the account; 403 per permission; 400; @ActionLog. WeChat is a
// fake gateway.
import { randomBytes } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, RT, WXOA_MEDIA_TAG, wxoaParams, wxoaPerms } from '@qiwu/shared'
import sharp from 'sharp'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { RealtimeService } from '../../src/core/realtime/realtime.service.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { findId as findIdRaw, insertRow as insertRowRaw } from '../../src/db/seeds/upsert.js'
import { JobRegistry } from '../../src/modules/platform/scheduler/job-registry.js'
import { JobScheduler } from '../../src/modules/platform/scheduler/job-scheduler.js'
import { StorageService } from '../../src/modules/platform/storage/storage.service.js'
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

const PREFIX = 'e2e-wxoa-message-'
const MESSAGES = '/api/wxoa/messages'
const CONVERSATIONS = '/api/wxoa/conversations'
const SEND = '/cgi-bin/message/custom/send'
const TEMP = '/cgi-bin/media/upload'
const MEDIA_GET = '/cgi-bin/media/get'
const MISSING = 999_999
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const BIG_MSG_ID = '18446744073709551615'

const fake = fakeWxoaGateway()
let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens = { admin: '', reader: '', sender: '', plain: '' }
let adminId: number
const userIds: number[] = []
const roleIds: number[] = []
const accountIds: number[] = []
/** enabled accounts A and B, a disabled one */
let a: number
let b: number
let off: number
let png: Buffer
const amr = Buffer.concat([Buffer.from('#!AMR\n'), Buffer.alloc(64, 0x3c)])
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.from([0, 0, 2, 0]),
  Buffer.from('isomiso2'),
  Buffer.from([0, 0, 0, 8]),
  Buffer.from('free'),
])

let seq = 0
const unique = () => `${PREFIX}${++seq}`
const openId = () => `o${randomBytes(12).toString('hex')}`
const ago = (ms: number) => new Date(Date.now() - ms)
const okSent = () => ({ errcode: 0, errmsg: 'ok' })

const http = () => request(app.getHttpServer())
const get = (who: keyof typeof tokens, url: string) => http().get(url).set(bearer(tokens[who]))
const send = (who: keyof typeof tokens, body: object) =>
  http().post(MESSAGES).set(bearer(tokens[who])).send(body)

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
/** a fan who wrote a minute ago unless told otherwise */
const fan = (accountId: number, over: Record<string, unknown> = {}) =>
  insertRow(ds.manager, 'wxoa_fan', {
    account_id: accountId,
    open_id: openId(),
    subscribed: 1,
    last_inbound_at: ago(MIN),
    ...over,
  })
const fanRow = async (id: number) =>
  (await ds.query('SELECT * FROM wxoa_fan WHERE id = ?', [id]))[0]
const message = (accountId: number, open: string, over: Record<string, unknown> = {}) =>
  insertRow(ds.manager, 'wxoa_message', {
    account_id: accountId,
    open_id: open,
    direction: 'in',
    channel: 'push',
    msg_kind: 'text',
    payload: { Content: unique() },
    occurred_at: new Date(),
    ...over,
  })
const messageRow = async (id: number) =>
  (await ds.query('SELECT * FROM wxoa_message WHERE id = ?', [id]))[0]
const messagesOf = (accountId: number) =>
  ds.query('SELECT * FROM wxoa_message WHERE account_id = ? ORDER BY id', [accountId])
const material = (accountId: number, over: Record<string, unknown> = {}) =>
  insertRow(ds.manager, 'wxoa_material', {
    account_id: accountId,
    media_kind: 'image',
    media_id: unique(),
    origin: 'pulled',
    ...over,
  })
const mediaIdOf = async (id: number): Promise<string> =>
  (await ds.query('SELECT media_id FROM wxoa_material WHERE id = ?', [id]))[0].media_id
/** one of the account's wxoa.media objects, as an inbound copy is stored */
const media = (accountId: number, name = `${unique()}.png`, data = png) =>
  inTenant1(() =>
    app
      .get(StorageService)
      .putWxoaMedia(
        accountId,
        { name, data },
        { exts: ['png', 'jpg', 'amr', 'mp4'], maxBytes: 1 << 20 },
      ),
  )
const upload = (bizTag: 'richtext' | 'attachment') =>
  inTenant1(() =>
    app
      .get(StorageService)
      .upload(
        { originalname: `${unique()}.png`, mimetype: 'image/png', size: png.length, buffer: png },
        bizTag,
        adminId,
      ),
  )
const objectRow = async (id: number) =>
  (await ds.query('SELECT * FROM fs_object WHERE id = ?', [id]))[0]
const download = (who: keyof typeof tokens, objectId: number) =>
  get(who, `/api/storage/objects/${objectId}/download`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => cb(null, Buffer.concat(chunks)))
    })

async function setParam(key: string, value: string) {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await app.get(ParamService).invalidate(key)
}

async function role(perms: string[]) {
  const id = await insertRow(ds.manager, 'iam_role', {
    code: unique(),
    name: unique(),
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

/** One run of the purge as the scheduler fires it (no tenant around it); its output. */
async function purge(): Promise<string> {
  const [{ id: task }] = await ds.query(
    "SELECT id FROM job_task WHERE handler = 'wxoa.message.purge' AND deleted_at IS NULL",
  )
  await app.get(JobScheduler).fire(Number(task), Date.now() + ++fires, 'manual')
  const [run] = await ds.query(
    'SELECT outcome, output, error FROM job_run WHERE task_id = ? ORDER BY id DESC LIMIT 1',
    [task],
  )
  expect(run).toMatchObject({ outcome: 'ok', error: null })
  return String(run.output)
}
let fires = 0

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
  png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#1f6feb' } })
    .png()
    .toBuffer()
  tokens.admin = (await signIn(app)).accessToken
  adminId = (await ds.query("SELECT id FROM iam_user WHERE username = 'admin'"))[0].id
  tokens.reader = await user('reader', [await role([wxoaPerms.message.browse])])
  tokens.sender = await user('sender', [await role([wxoaPerms.message.send])])
  tokens.plain = await user('plain', [])
  a = await account()
  b = await account()
  off = await account(false)
})

beforeEach(() => fake.reset())

afterAll(async () => {
  if (ds) {
    if (accountIds.length) {
      for (const table of ['wxoa_message', 'wxoa_fan', 'wxoa_material'])
        // arch-allow: sql-concat table names are spec constants; ids bound
        await ds.query(`DELETE FROM ${table} WHERE account_id IN (?)`, [accountIds])
      await ds.query('DELETE FROM fs_object WHERE biz_tag = ? AND biz_ref IN (?)', [
        WXOA_MEDIA_TAG,
        accountIds.map((id) => `wxoa:${id}`),
      ])
      await ds.query('DELETE FROM wxoa_account WHERE id IN (?)', [accountIds])
    }
    await ds.query("DELETE FROM fs_object WHERE original_name LIKE 'e2e-wxoa-message-%'")
    await setParam(wxoaParams.retentionDays, '180')
    await setParam(wxoaParams.copyInbound, 'true')
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

describe('message log', () => {
  it("pages the account's messages by fan, direction, channel, kind and time; another account's never", async () => {
    const acc = await account()
    const o1 = openId()
    const o2 = openId()
    const m1 = await message(acc, o1, {
      wx_msg_id: BIG_MSG_ID,
      payload: { Content: 'hello', truncated: true },
      occurred_at: ago(3 * HOUR),
    })
    const m2 = await message(acc, o1, {
      direction: 'out',
      channel: 'cs',
      msg_kind: 'image',
      payload: { materialId: 7 },
      send_state: 'sent',
      errcode: 0,
      operator_id: adminId,
      occurred_at: ago(2 * HOUR),
    })
    const m3 = await message(acc, o2, {
      msg_kind: 'event',
      event_kind: 'CLICK',
      event_key: 'K1',
      payload: {},
      occurred_at: ago(HOUR),
    })
    await message(b, o1)
    const page = async (q = '') =>
      (await get('reader', `${MESSAGES}?accountId=${acc}${q}`).expect(200)).body.data
    const all = await page()
    expect(all.total).toBe(3)
    expect(all.items.map((m: { id: number }) => m.id)).toEqual([m3, m2, m1])
    expect(all.items[2]).toEqual({
      id: m1,
      accountId: acc,
      openId: o1,
      direction: 'in',
      channel: 'push',
      msgKind: 'text',
      eventKind: null,
      eventKey: null,
      payload: { Content: 'hello', truncated: true },
      objectId: null,
      wxMsgId: BIG_MSG_ID,
      sendState: null,
      errcode: null,
      operatorId: null,
      occurredAt: expect.any(String),
    })
    expect(all.items[1]).toMatchObject({ sendState: 'sent', errcode: 0, operatorId: adminId })
    const ids = async (q: string) => (await page(q)).items.map((m: { id: number }) => m.id)
    expect(await ids(`&openId=${o1}`)).toEqual([m2, m1])
    expect(await ids('&direction=out')).toEqual([m2])
    expect(await ids('&channel=push')).toEqual([m3, m1])
    expect(await ids('&msgKind=event')).toEqual([m3])
    const from = encodeURIComponent(ago(2.5 * HOUR).toISOString())
    const to = encodeURIComponent(ago(1.5 * HOUR).toISOString())
    expect(await ids(`&occurredAtFrom=${from}&occurredAtTo=${to}`)).toEqual([m2])
    expect(await ids('&sort=occurredAt')).toEqual([m1, m2, m3])
  })

  it('403 without wxoa.message.browse; 400 without an account; 404 for a missing one; B6011 for a disabled one', async () => {
    await get('plain', `${MESSAGES}?accountId=${a}`).expect(403)
    await get('sender', `${MESSAGES}?accountId=${a}`).expect(403)
    await get('admin', MESSAGES).expect(400)
    await get('admin', `${MESSAGES}?accountId=${a}&direction=sideways`).expect(400)
    await get('admin', `${MESSAGES}?accountId=${MISSING}`).expect(404)
    const res = await get('admin', `${MESSAGES}?accountId=${off}`).expect(422)
    expect(res.body.code).toBe(Err.WXOA_ACCOUNT_DISABLED.code)
  })
})

describe('conversations', () => {
  it("lists the account's fans by their last message, newest first", async () => {
    const acc = await account()
    const older = await fan(acc, { last_inbound_at: ago(2 * HOUR) })
    const newer = await fan(acc, { last_inbound_at: ago(MIN) })
    const quiet = await fan(acc, { last_inbound_at: null })
    await fan(b)
    const res = await get('reader', `${CONVERSATIONS}?accountId=${acc}`).expect(200)
    expect(res.body.data.total).toBe(3)
    expect(res.body.data.items.map((f: { id: number }) => f.id)).toEqual([newer, older, quiet])
    expect(res.body.data.items[0]).toMatchObject({
      id: newer,
      accountId: acc,
      openId: (await fanRow(newer)).open_id,
      lastInboundAt: expect.any(String),
      tagIds: [],
    })
    const asc = await get('reader', `${CONVERSATIONS}?accountId=${acc}&sort=id`).expect(200)
    expect(asc.body.data.items.map((f: { id: number }) => f.id)).toEqual([older, newer, quiet])
  })

  it("one fan's messages: newest first, before a cursor, at most the limit, that fan's only", async () => {
    const f = await fan(a)
    const open = (await fanRow(f)).open_id
    const ids: number[] = []
    for (let i = 0; i < 4; i++)
      ids.push(await message(a, open, i % 2 ? { direction: 'out', channel: 'cs' } : {}))
    await message(b, open)
    await message(a, openId())
    const list = async (q = '') =>
      (await get('reader', `${CONVERSATIONS}/${f}/messages${q}`).expect(200)).body.data.map(
        (m: { id: number }) => m.id,
      )
    expect(await list()).toEqual([...ids].reverse())
    expect(await list(`?beforeId=${ids[2]}`)).toEqual([ids[1], ids[0]])
    expect(await list(`?limit=1&beforeId=${ids[3]}`)).toEqual([ids[2]])
    await get('reader', `${CONVERSATIONS}/${f}/messages?limit=51`).expect(400)
    await get('reader', `${CONVERSATIONS}/${f}/messages?beforeId=x`).expect(400)
  })

  it('the send windows: their ends from the fan row, the messages sent since each opened (failed ones not counted)', async () => {
    const inboundAt = new Date(Date.now() - 2 * HOUR)
    const eventAt = new Date(Date.now() - 30_000)
    const f = await fan(a, { last_inbound_at: inboundAt, last_event_at: eventAt })
    const open = (await fanRow(f)).open_id
    const out = (at: Date, over: Record<string, unknown> = {}) =>
      message(a, open, {
        direction: 'out',
        channel: 'cs',
        send_state: 'sent',
        occurred_at: at,
        ...over,
      })
    await out(new Date(inboundAt.getTime() - MIN))
    await out(new Date(inboundAt.getTime() + MIN))
    await out(new Date(inboundAt.getTime() + 2 * MIN), { send_state: 'failed' })
    await out(new Date(eventAt.getTime() + 1000))
    await out(new Date(eventAt.getTime() + 2000), { send_state: 'pending' })
    await out(new Date(eventAt.getTime() + 3000), { channel: 'template' })
    await message(b, open, { direction: 'out', channel: 'cs', send_state: 'sent' })
    const res = await get('reader', `${CONVERSATIONS}/${f}/window`).expect(200)
    expect(res.body.data).toEqual({
      inbound: { until: new Date(inboundAt.getTime() + 48 * HOUR).toISOString(), used: 3, max: 5 },
      event: { until: new Date(eventAt.getTime() + MIN).toISOString(), used: 2, max: 3 },
    })
    const never = await fan(a, { last_inbound_at: null })
    expect((await get('reader', `${CONVERSATIONS}/${never}/window`).expect(200)).body.data).toEqual(
      {
        inbound: { until: null, used: 0, max: 5 },
        event: { until: null, used: 0, max: 3 },
      },
    )
  })

  it('403 without wxoa.message.browse; 400 without an account; 404 for a missing fan or account; B6011 for a disabled one', async () => {
    const f = await fan(a)
    for (const url of [
      `${CONVERSATIONS}?accountId=${a}`,
      `${CONVERSATIONS}/${f}/messages`,
      `${CONVERSATIONS}/${f}/window`,
    ]) {
      await get('plain', url).expect(403)
      await get('sender', url).expect(403)
    }
    await get('admin', CONVERSATIONS).expect(400)
    await get('admin', `${CONVERSATIONS}?accountId=${MISSING}`).expect(404)
    await get('admin', `${CONVERSATIONS}/${MISSING}/messages`).expect(404)
    await get('admin', `${CONVERSATIONS}/${MISSING}/window`).expect(404)
    const offFan = await fan(off)
    for (const url of [
      `${CONVERSATIONS}?accountId=${off}`,
      `${CONVERSATIONS}/${offFan}/messages`,
      `${CONVERSATIONS}/${offFan}/window`,
    ])
      expect((await get('admin', url).expect(422)).body.code).toBe(Err.WXOA_ACCOUNT_DISABLED.code)
  })
})

describe('customer-service messages', () => {
  it('a text goes to custom/send; its row is written pending, then sent (no object), and logged', async () => {
    fake.on(SEND, okSent())
    const f = await fan(a)
    const open = (await fanRow(f)).open_id
    const content = unique()
    const trace = `${PREFIX}${process.pid}-send`
    const res = await send('admin', { accountId: a, fanId: f, kind: 'text', body: { content } })
      .set('X-Request-Id', trace)
      .expect(201)
    expect(fake.callsTo(SEND)).toEqual([
      expect.objectContaining({
        method: 'json',
        accountId: a,
        body: { touser: open, msgtype: 'text', text: { content } },
      }),
    ])
    expect(res.body.data).toMatchObject({
      accountId: a,
      openId: open,
      direction: 'out',
      channel: 'cs',
      msgKind: 'text',
      payload: { content },
      objectId: null,
      sendState: 'sent',
      errcode: 0,
      operatorId: adminId,
    })
    const row = await messageRow(res.body.data.id)
    expect(row).toMatchObject({ send_state: 'sent', errcode: 0, object_id: null, dedup_key: null })
    expect(await logOf(ds, trace)).toMatchObject({
      domain: 'wxoa.message',
      verb: 'send',
      biz_id: String(res.body.data.id),
      ok: 1,
    })
    // the same submission again within the window
    await send('admin', { accountId: a, fanId: f, kind: 'text', body: { content } }).expect(429)
  })

  it("media from one of the account's materials of that kind; video and music carry a thumb material", async () => {
    fake.on(SEND, okSent())
    const f = await fan(a)
    const open = (await fanRow(f)).open_id
    const image = await material(a)
    const voice = await material(a, { media_kind: 'voice' })
    const video = await material(a, { media_kind: 'video' })
    const thumb = await material(a, { media_kind: 'thumb' })
    await send('admin', {
      accountId: a,
      fanId: f,
      kind: 'image',
      body: {},
      materialId: image,
    }).expect(201)
    await send('admin', {
      accountId: a,
      fanId: f,
      kind: 'voice',
      body: {},
      materialId: voice,
    }).expect(201)
    const shown = await send('admin', {
      accountId: a,
      fanId: f,
      kind: 'video',
      body: { title: 'clip' },
      materialId: video,
      thumbMaterialId: thumb,
    }).expect(201)
    expect(shown.body.data.payload).toEqual({
      title: 'clip',
      materialId: video,
      thumbMaterialId: thumb,
    })
    await send('admin', {
      accountId: a,
      fanId: f,
      kind: 'music',
      body: { title: 'song', description: 'd', musicUrl: 'https://example.com/a.mp3' },
      thumbMaterialId: thumb,
    }).expect(201)
    await send('admin', {
      accountId: a,
      fanId: f,
      kind: 'news',
      body: {
        title: 'news',
        description: 'd',
        url: 'https://example.com/n',
        picUrl: 'https://example.com/p.png',
      },
    }).expect(201)
    expect(fake.callsTo(SEND).map((c) => c.body)).toEqual([
      { touser: open, msgtype: 'image', image: { media_id: await mediaIdOf(image) } },
      { touser: open, msgtype: 'voice', voice: { media_id: await mediaIdOf(voice) } },
      {
        touser: open,
        msgtype: 'video',
        video: {
          media_id: await mediaIdOf(video),
          thumb_media_id: await mediaIdOf(thumb),
          title: 'clip',
        },
      },
      {
        touser: open,
        msgtype: 'music',
        music: {
          title: 'song',
          description: 'd',
          musicurl: 'https://example.com/a.mp3',
          thumb_media_id: await mediaIdOf(thumb),
        },
      },
      {
        touser: open,
        msgtype: 'news',
        news: {
          articles: [
            {
              title: 'news',
              description: 'd',
              url: 'https://example.com/n',
              picurl: 'https://example.com/p.png',
            },
          ],
        },
      },
    ])
  })

  it('a material of another account, of another kind or deleted → 404, nothing uploaded or sent', async () => {
    fake.on(TEMP, { type: 'video', media_id: 'E2E-TEMP-V', created_at: 1 })
    fake.on(SEND, okSent())
    const f = await fan(a)
    const ofB = await material(b)
    const voice = await material(a, { media_kind: 'voice' })
    const gone = await material(a, { deleted_at: new Date() })
    const video = await material(a, { media_kind: 'video' })
    const image = await material(a)
    for (const materialId of [ofB, voice, gone, MISSING])
      await send('admin', { accountId: a, fanId: f, kind: 'image', body: {}, materialId }).expect(
        404,
      )
    // a thumbnail must be a thumb material of the account, checked before an object is uploaded
    const clip = await media(a, `${unique()}.mp4`, mp4)
    for (const thumbMaterialId of [image, await material(b, { media_kind: 'thumb' })])
      for (const source of [{ materialId: video }, { objectId: clip.id }])
        await send('admin', {
          accountId: a,
          fanId: f,
          kind: 'video',
          body: {},
          ...source,
          thumbMaterialId,
        }).expect(404)
    expect(fake.callsTo(TEMP)).toEqual([])
    expect(fake.callsTo(SEND)).toEqual([])
    const open = (await fanRow(f)).open_id
    expect(await messagesOf(a)).not.toContainEqual(expect.objectContaining({ open_id: open }))
  })

  it("an object of the account's media (an inbound copy) goes as a temporary medium; the row keeps its id in the payload, not as its object", async () => {
    fake.on(TEMP, { type: 'image', media_id: 'E2E-TEMP-1', created_at: 1 })
    fake.on(SEND, okSent())
    const f = await fan(a)
    const obj = await media(a)
    const res = await send('admin', {
      accountId: a,
      fanId: f,
      kind: 'image',
      body: {},
      objectId: obj.id,
    }).expect(201)
    expect(fake.callsTo(TEMP)).toEqual([
      expect.objectContaining({ method: 'upload', accountId: a, query: { type: 'image' } }),
    ])
    expect(Buffer.compare(fake.callsTo(TEMP)[0]!.file!.data, png)).toBe(0)
    expect(fake.callsTo(SEND)[0]!.body).toMatchObject({ image: { media_id: 'E2E-TEMP-1' } })
    expect(res.body.data).toMatchObject({ payload: { objectId: obj.id }, objectId: null })
    expect((await messageRow(res.body.data.id)).object_id).toBeNull()
  })

  it("an object of another tag (public or private) or of another account's media → 404, nothing uploaded or sent", async () => {
    fake.on(TEMP, { type: 'image', media_id: 'E2E-TEMP-2', created_at: 1 })
    fake.on(SEND, okSent())
    const f = await fan(a)
    const richtext = await upload('richtext')
    const attachment = await upload('attachment')
    // the account's reference on an object of another tag: the tag alone refuses it
    await ds.query('UPDATE fs_object SET biz_ref = ? WHERE id IN (?)', [
      `wxoa:${a}`,
      [richtext.id, attachment.id],
    ])
    const ofB = await media(b)
    for (const objectId of [richtext.id, attachment.id, ofB.id, MISSING])
      await send('admin', { accountId: a, fanId: f, kind: 'image', body: {}, objectId }).expect(404)
    expect(fake.callsTo(TEMP)).toEqual([])
    expect(fake.callsTo(SEND)).toEqual([])
  })

  it('the object is checked even when a temporary media_id is cached for it', async () => {
    fake.on(SEND, okSent())
    const f = await fan(a)
    const attachment = await upload('attachment')
    await ds.query('UPDATE fs_object SET biz_ref = ? WHERE id = ?', [`wxoa:${a}`, attachment.id])
    const ofB = await media(b)
    for (const id of [attachment.id, ofB.id]) {
      await redis.set(redisKey('wxoa', 'temp', a, id), 'image E2E-CACHED', {
        expiration: { type: 'EX', value: 60 },
      })
      await send('admin', { accountId: a, fanId: f, kind: 'image', body: {}, objectId: id }).expect(
        404,
      )
    }
    expect(fake.callsTo(SEND)).toEqual([])
  })

  it('needs a window open: 48 hours after a message or a minute after an event; both closed → B6007 without a call or a row', async () => {
    fake.on(SEND, okSent())
    const text = () => ({ content: unique() })
    const closed = await fan(a, {
      last_inbound_at: ago(48 * HOUR + MIN),
      last_event_at: ago(2 * MIN),
    })
    const res = await send('admin', { accountId: a, fanId: closed, kind: 'text', body: text() })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe(Err.WXOA_SEND_WINDOW.code)
    const never = await fan(a, { last_inbound_at: null })
    expect(
      (await send('admin', { accountId: a, fanId: never, kind: 'text', body: text() })).body.code,
    ).toBe(Err.WXOA_SEND_WINDOW.code)
    expect(fake.callsTo(SEND)).toEqual([])
    const quiet = [closed, never].map(async (id) => (await fanRow(id)).open_id)
    const rows = await messagesOf(a)
    for (const open of await Promise.all(quiet))
      expect(rows.filter((r: { open_id: string }) => r.open_id === open)).toEqual([])
    const byMessage = await fan(a, { last_inbound_at: ago(47 * HOUR) })
    await send('admin', { accountId: a, fanId: byMessage, kind: 'text', body: text() }).expect(201)
    const byEvent = await fan(a, { last_inbound_at: null, last_event_at: ago(30_000) })
    await send('admin', { accountId: a, fanId: byEvent, kind: 'text', body: text() }).expect(201)
  })

  it('WeChat refusing the window → B6007, another refusal → B6002; the row is left failed', async () => {
    const f = await fan(a)
    fake.on(SEND, upstreamError(45047, 'out of response count limit'))
    const res = await send('admin', {
      accountId: a,
      fanId: f,
      kind: 'text',
      body: { content: unique() },
    })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe(Err.WXOA_SEND_WINDOW.code)
    fake.on(SEND, upstreamError(43004, 'require subscribe'))
    const other = await send('admin', {
      accountId: a,
      fanId: f,
      kind: 'text',
      body: { content: unique() },
    })
    expect(other.status).toBe(422)
    expect(other.body.code).toBe(Err.WXOA_UPSTREAM_REFUSED.code)
    const open = (await fanRow(f)).open_id
    const rows = (await messagesOf(a)).filter((r: { open_id: string }) => r.open_id === open)
    expect(
      rows.map((r: { send_state: string; errcode: number | null }) => [r.send_state, r.errcode]),
    ).toEqual([
      ['failed', null],
      ['failed', 43004],
    ])
  })

  it('400 for a body that does not fit its kind', async () => {
    fake.on(SEND, okSent())
    const f = await fan(a)
    const image = await material(a)
    const obj = await media(a)
    for (const body of [
      { accountId: a, fanId: f, kind: 'text', body: { content: '' } },
      { accountId: a, fanId: f, kind: 'text', body: { content: 'a', extra: 1 } },
      { accountId: a, fanId: f, kind: 'text', body: { content: 'bell\u0007' } },
      { accountId: a, fanId: f, kind: 'image', body: {} },
      { accountId: a, fanId: f, kind: 'image', body: {}, materialId: image, objectId: obj.id },
      { accountId: a, fanId: f, kind: 'text', body: { content: 'a' }, materialId: image },
      { accountId: a, fanId: f, kind: 'video', body: {}, materialId: image },
      { accountId: a, fanId: f, kind: 'sticker', body: {} },
      { fanId: f, kind: 'text', body: { content: 'a' } },
      { accountId: a, kind: 'text', body: { content: 'a' } },
    ])
      await send('admin', body).expect(400)
    expect(fake.callsTo(SEND)).toEqual([])
  })

  it('403 without wxoa.message.send; a fan of another account or a missing one 404; a missing account 404, a disabled one B6011', async () => {
    fake.on(SEND, okSent())
    const f = await fan(a)
    const body = (over: object) => ({
      accountId: a,
      fanId: f,
      kind: 'text',
      body: { content: unique() },
      ...over,
    })
    await send('reader', body({})).expect(403)
    await send('plain', body({})).expect(403)
    await send('admin', body({ fanId: await fan(b) })).expect(404)
    await send('admin', body({ fanId: MISSING })).expect(404)
    await send('admin', body({ accountId: MISSING })).expect(404)
    const offFan = await fan(off)
    const res = await send('admin', body({ accountId: off, fanId: offFan })).expect(422)
    expect(res.body.code).toBe(Err.WXOA_ACCOUNT_DISABLED.code)
    expect(fake.callsTo(SEND)).toEqual([])
    // the chat role: it sends without browsing
    await send('sender', body({})).expect(201)
  })
})

describe('inbound hub', () => {
  const MEDIA_ID = 'E2E-INBOUND-MEDIA'
  const inbound = async (
    accountId: number,
    msgKind: string,
    payload: Record<string, unknown>,
  ): Promise<WxoaInbound> => {
    const open = openId()
    const id = await message(accountId, open, { msg_kind: msgKind, payload })
    return {
      id,
      accountId,
      openId: open,
      msgKind,
      eventKind: null,
      eventKey: null,
      wxMsgId: null,
      payload,
      occurredAt: new Date(),
    }
  }
  let hints: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    hints = vi.spyOn(app.get(RealtimeService), 'toUserType')
  })
  afterEach(() => hints.mockRestore())
  const hinted = (row: WxoaInbound) =>
    expect(hints).toHaveBeenCalledWith(1, 'admin', {
      type: RT.wxoaMessage,
      payload: { accountId: row.accountId, messageId: row.id },
    })

  it("an inbound image is copied from media/get as the account's media, the row's own; readers of messages download it", async () => {
    fake.on(MEDIA_GET, { data: png, mime: 'image/png', fileName: null })
    const row = await inbound(a, 'image', { MediaId: MEDIA_ID, PicUrl: 'https://mmbiz.qpic.cn/x' })
    await app.get(WxoaInboundHub).emit(row)
    expect(fake.callsTo(MEDIA_GET)).toEqual([
      expect.objectContaining({
        method: 'download',
        accountId: a,
        query: { media_id: MEDIA_ID },
        maxBytes: 10 * 1024 * 1024,
      }),
    ])
    const objectId = (await messageRow(row.id)).object_id
    expect(objectId).toEqual(expect.any(Number))
    expect(await objectRow(objectId)).toMatchObject({
      biz_tag: WXOA_MEDIA_TAG,
      biz_ref: `wxoa:${a}`,
      uploader_id: 0,
      is_public: 0,
      mime: 'image/png',
      original_name: `image-${row.id}.png`,
    })
    hinted(row)
    const res = await download('reader', objectId).expect(200)
    expect(Buffer.compare(res.body as Buffer, png)).toBe(0)
    await download('plain', objectId).expect(403)
  })

  it('voice is copied as amr, a video as its thumbnail', async () => {
    fake.on(MEDIA_GET, { data: amr, mime: 'audio/amr', fileName: null })
    const voice = await inbound(a, 'voice', { MediaId: MEDIA_ID, Format: 'amr' })
    await app.get(WxoaInboundHub).emit(voice)
    expect(await objectRow((await messageRow(voice.id)).object_id)).toMatchObject({
      mime: 'audio/amr',
      original_name: `voice-${voice.id}.amr`,
    })
    fake.reset()
    fake.on(MEDIA_GET, { data: png, mime: 'image/png', fileName: null })
    const video = await inbound(a, 'video', { MediaId: 'E2E-VIDEO', ThumbMediaId: 'E2E-THUMB' })
    await app.get(WxoaInboundHub).emit(video)
    expect(fake.callsTo(MEDIA_GET).map((c) => c.query)).toEqual([{ media_id: 'E2E-THUMB' }])
    expect((await messageRow(video.id)).object_id).toEqual(expect.any(Number))
  })

  it('wxoa.media.copy_inbound false copies nothing; a text has nothing to copy; both still hint', async () => {
    fake.on(MEDIA_GET, { data: png, mime: 'image/png', fileName: null })
    await setParam(wxoaParams.copyInbound, 'false')
    try {
      const image = await inbound(a, 'image', { MediaId: MEDIA_ID })
      await app.get(WxoaInboundHub).emit(image)
      expect((await messageRow(image.id)).object_id).toBeNull()
      hinted(image)
    } finally {
      await setParam(wxoaParams.copyInbound, 'true')
    }
    const text = await inbound(a, 'text', { Content: 'hi' })
    await app.get(WxoaInboundHub).emit(text)
    hinted(text)
    expect(fake.callsTo(MEDIA_GET)).toEqual([])
  })

  it('a failed download still hints; a row gone meanwhile takes its copy back', async () => {
    fake.on(MEDIA_GET, upstreamError(40007))
    const failed = await inbound(a, 'image', { MediaId: MEDIA_ID })
    await app.get(WxoaInboundHub).emit(failed)
    expect((await messageRow(failed.id)).object_id).toBeNull()
    hinted(failed)
    fake.on(MEDIA_GET, { data: png, mime: 'image/png', fileName: null })
    const gone = await inbound(a, 'image', { MediaId: MEDIA_ID })
    await ds.query('DELETE FROM wxoa_message WHERE id = ?', [gone.id])
    const before = Number((await ds.query('SELECT MAX(id) AS id FROM fs_object'))[0].id)
    await app.get(WxoaInboundHub).emit(gone)
    const [copy] = await ds.query('SELECT * FROM fs_object WHERE id > ?', [before])
    expect(copy).toMatchObject({ biz_tag: WXOA_MEDIA_TAG, deleted_at: expect.any(Date) })
  })

  it("a row emitted again keeps its first copy; an outbound row or another account's gets none; each extra copy is taken back", async () => {
    fake.on(MEDIA_GET, { data: png, mime: 'image/png', fileName: null })
    const row = await inbound(a, 'image', { MediaId: MEDIA_ID })
    await app.get(WxoaInboundHub).emit(row)
    const first = (await messageRow(row.id)).object_id
    expect(first).toEqual(expect.any(Number))
    const out = await inbound(a, 'image', { MediaId: MEDIA_ID })
    await ds.query("UPDATE wxoa_message SET direction = 'out', channel = 'cs' WHERE id = ?", [
      out.id,
    ])
    const other = await inbound(a, 'image', { MediaId: MEDIA_ID })
    const before = Number((await ds.query('SELECT MAX(id) AS id FROM fs_object'))[0].id)
    for (const r of [row, out, { ...other, accountId: b }]) await app.get(WxoaInboundHub).emit(r)
    expect((await messageRow(row.id)).object_id).toBe(first)
    expect((await messageRow(out.id)).object_id).toBeNull()
    expect((await messageRow(other.id)).object_id).toBeNull()
    const copies = await ds.query('SELECT biz_tag, deleted_at FROM fs_object WHERE id > ?', [
      before,
    ])
    expect(copies).toHaveLength(3)
    for (const copy of copies)
      expect(copy).toMatchObject({ biz_tag: WXOA_MEDIA_TAG, deleted_at: expect.any(Date) })
    expect((await objectRow(first)).deleted_at).toBeNull()
  })
})

describe('purge', () => {
  it('deletes rows past the retention in steps, with the copies of inbound rows only; newer rows stay', async () => {
    await setParam(wxoaParams.retentionDays, '1')
    try {
      const acc = await account()
      const open = openId()
      const old = ago(DAY + MIN)
      const copy = await media(acc)
      const oldIn = await message(acc, open, {
        msg_kind: 'image',
        object_id: copy.id,
        occurred_at: old,
      })
      // a material's copy: an outbound row only names it, never owns it
      const mat = await media(acc)
      await material(acc, { object_id: mat.id })
      const oldOut = await message(acc, open, {
        direction: 'out',
        channel: 'cs',
        msg_kind: 'image',
        payload: { materialId: 1 },
        send_state: 'sent',
        object_id: mat.id,
        occurred_at: old,
      })
      const recent = await message(acc, open, { occurred_at: ago(DAY - MIN) })
      // one step and one more
      await ds.query(
        'INSERT INTO wxoa_message (tenant_id, account_id, open_id, direction, channel, msg_kind, payload, occurred_at) VALUES ?',
        [Array.from({ length: 1001 }, () => [1, acc, open, 'in', 'push', 'text', '{}', old])],
      )
      expect(await purge()).toMatch(/^kept 1 days, \d+ deleted; \d+ pending failed$/)
      const left = (await messagesOf(acc)).map((r: { id: number }) => r.id)
      expect(left).toEqual([recent])
      expect([oldIn, oldOut].some((id) => left.includes(id))).toBe(false)
      expect((await objectRow(copy.id)).deleted_at).toEqual(expect.any(Date))
      expect((await objectRow(mat.id)).deleted_at).toBeNull()
      await download('reader', mat.id).expect(200)
    } finally {
      await setParam(wxoaParams.retentionDays, '180')
    }
  })

  it('0 keeps every row', async () => {
    await setParam(wxoaParams.retentionDays, '0')
    try {
      const acc = await account()
      const old = await message(acc, openId(), { occurred_at: ago(4000 * DAY) })
      expect(await purge()).toMatch(/^kept forever; /)
      expect((await messagesOf(acc)).map((r: { id: number }) => r.id)).toEqual([old])
    } finally {
      await setParam(wxoaParams.retentionDays, '180')
    }
  })

  it('outbound rows pending for more than 10 minutes are failed; newer pending and settled rows stay', async () => {
    const acc = await account()
    const open = openId()
    const out = (state: string, createdAgo: number) =>
      message(acc, open, {
        direction: 'out',
        channel: 'template',
        msg_kind: 'template',
        send_state: state,
        created_at: ago(createdAgo),
      })
    const orphan = await out('pending', 11 * MIN)
    const fresh = await out('pending', 5 * MIN)
    const sent = await out('sent', 11 * MIN)
    // a full step of old settled rows: never picked again, so the run ends
    await ds.query(
      'INSERT INTO wxoa_message (tenant_id, account_id, open_id, direction, channel, msg_kind, payload, send_state, occurred_at, created_at) VALUES ?',
      [
        Array.from({ length: 1000 }, () => {
          const at = ago(11 * MIN)
          return [1, acc, open, 'out', 'cs', 'text', '{}', 'sent', at, at]
        }),
      ],
    )
    await purge()
    expect((await messageRow(orphan)).send_state).toBe('failed')
    expect((await messageRow(fresh)).send_state).toBe('pending')
    expect((await messageRow(sent)).send_state).toBe('sent')
  })

  it('an aborted signal (task lock lost) stops it before anything is deleted', async () => {
    await setParam(wxoaParams.retentionDays, '1')
    try {
      const acc = await account()
      const old = await message(acc, openId(), { occurred_at: ago(2 * DAY) })
      const abort = new AbortController()
      abort.abort(new Error('lock lost'))
      await expect(
        app
          .get(JobRegistry)
          .get('wxoa.message.purge')!
          .run({}, { signal: abort.signal, log: () => undefined }),
      ).rejects.toThrow('lock lost')
      expect((await messagesOf(acc)).map((r: { id: number }) => r.id)).toEqual([old])
    } finally {
      await setParam(wxoaParams.retentionDays, '180')
    }
  })
})
