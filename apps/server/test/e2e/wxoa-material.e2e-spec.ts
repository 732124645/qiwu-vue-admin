// WeChat Official Account permanent materials (see docs/design-notes.md#wxoa): an upload is stored as the
// account's wxoa.media object first, then sent to add_material (a video with title and intro), and a
// refused upload takes the local object back; the list and WeChat's counts; a background sync from
// batchget_material (links only, one per account at a time, interrupted when its instance stopped);
// delete (a material a reply rule uses → 409 without calling WeChat, then del_material and the local soft
// delete); the temporary media_id of an account's media object; every route through the account
// (missing or deleted 404, disabled B6011); 403 per permission; 400; @ActionLog. WeChat is a fake gateway.
import { randomBytes } from 'node:crypto'
import { NotFoundException } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, WXOA_MEDIA_TAG, wxoaPerms } from '@qiwu/shared'
import sharp from 'sharp'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId as findIdRaw, insertRow as insertRowRaw } from '../../src/db/seeds/upsert.js'
import { StorageService } from '../../src/modules/platform/storage/storage.service.js'
import {
  upstreamError,
  type WxoaCaller,
  WxoaGateway,
} from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import { WxoaMaterialService } from '../../src/modules/platform/wxoa/material/material.service.js'
import { fakeWxoaGateway, type FakeWxoaCall } from '../fixtures/wxoa/fake-gateway.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { inTenant1 } from '../setup/tenants.js'
const findId = (...args: Parameters<typeof findIdRaw>) => inTenant1(() => findIdRaw(...args))
const insertRow = (...args: Parameters<typeof insertRowRaw>) =>
  inTenant1(() => insertRowRaw(...args))

const PREFIX = 'e2e-wxoa-material-'
const URL = '/api/wxoa/materials'
const ADD = '/cgi-bin/material/add_material'
const DEL = '/cgi-bin/material/del_material'
const COUNT = '/cgi-bin/material/get_materialcount'
const BATCH = '/cgi-bin/material/batchget_material'
const TEMP = '/cgi-bin/media/upload'
const MISSING = 999_999
const KB = 1024

const fake = fakeWxoaGateway()
let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens = { admin: '', reader: '', plain: '' }
const userIds: number[] = []
const accounts = new Map<number, WxoaCaller>()
let roleId: number
/** enabled accounts A and B, a disabled one */
let a: number
let b: number
let off: number
let png: Buffer
let jpg: Buffer
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.from([0, 0, 2, 0]),
  Buffer.from('isomiso2'),
  Buffer.from([0, 0, 0, 8]),
  Buffer.from('free'),
])
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')

let seq = 0
const unique = () => `${PREFIX}${++seq}`
let mediaSeq = 0
/** add_material's answer: a new media_id and, for an image, an http link on WeChat's image host */
const added = () => ({
  media_id: `E2E-MEDIA-${++mediaSeq}`,
  url: `http://mmbiz.qpic.cn/mmbiz_png/e2e${mediaSeq}/0?wx_fmt=png`,
})

const call = (who: keyof typeof tokens, method: 'get' | 'post' | 'delete', path = '') =>
  request(app.getHttpServer())[method](`${URL}${path}`).set(bearer(tokens[who]))
/** POST /materials: multipart text fields and a file. */
function upload(
  who: keyof typeof tokens,
  fields: Record<string, string | number | undefined>,
  file?: { data: Buffer; name: string },
) {
  const req = call(who, 'post')
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) req.field(k, String(v))
  return file ? req.attach('file', file.data, file.name) : req
}
const materialRow = async (id: number) =>
  (await ds.query('SELECT * FROM wxoa_material WHERE id = ?', [id]))[0]
const objectRows = (name: string) =>
  ds.query('SELECT * FROM fs_object WHERE original_name = ?', [name])
const objectCount = async () => Number((await ds.query('SELECT COUNT(*) AS n FROM fs_object'))[0].n)

async function account(enabled = true) {
  const appId = `wx${randomBytes(8).toString('hex')}`
  const id = await insertRow(ds.manager, 'wxoa_account', {
    label: unique(),
    app_id: appId,
    account_kind: 'service',
    app_secret_enc: 'not-used-by-this-spec',
    push_token_enc: 'not-used-by-this-spec',
    callback_key: randomBytes(16).toString('base64url'),
    enabled,
  })
  accounts.set(id, { id, appId, accountKind: 'service' })
  return id
}
const material = (accountId: number, over: Record<string, unknown> = {}) =>
  insertRow(ds.manager, 'wxoa_material', {
    account_id: accountId,
    media_kind: 'image',
    media_id: unique(),
    origin: 'pulled',
    ...over,
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

/** GET /materials/sync of `accountId` until the run is no longer running. */
async function settled(accountId: number) {
  for (const until = Date.now() + 5000; ; await new Promise((r) => setTimeout(r, 25))) {
    const progress = (await call('admin', 'get', `/sync?accountId=${accountId}`).expect(200)).body
      .data
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
  png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#1f6feb' } })
    .png()
    .toBuffer()
  jpg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#1f6feb' } })
    .jpeg()
    .toBuffer()
  roleId = await insertRow(ds.manager, 'iam_role', {
    code: `${PREFIX}reader`,
    name: `${PREFIX}reader`,
    data_scope: 'all',
  })
  const browse = await findId(ds.manager, 'iam_menu', { perms: wxoaPerms.material.browse })
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
})

beforeEach(() => fake.reset())

afterAll(async () => {
  if (ds) {
    const ids = [...accounts.keys()]
    if (ids.length) {
      for (const table of ['wxoa_reply_rule', 'wxoa_material'])
        // arch-allow: sql-concat table names are spec constants; ids bound
        await ds.query(`DELETE FROM ${table} WHERE account_id IN (?)`, [ids])
      await ds.query('DELETE FROM fs_object WHERE biz_tag = ? AND biz_ref IN (?)', [
        WXOA_MEDIA_TAG,
        ids.map((id) => `wxoa:${id}`),
      ])
      await ds.query('DELETE FROM wxoa_account WHERE id IN (?)', [ids])
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

describe('upload', () => {
  it('an image is stored as the account media first, then sent to add_material; the row links both', async () => {
    fake.on(ADD, added)
    const name = `${unique()}.png`
    const trace = `${PREFIX}${process.pid}-upload`
    const res = await upload('admin', { accountId: a, mediaKind: 'image' }, { data: png, name })
      .set('X-Request-Id', trace)
      .expect(201)
    const row = res.body.data
    expect(row).toMatchObject({
      accountId: a,
      mediaKind: 'image',
      mediaId: `E2E-MEDIA-${mediaSeq}`,
      title: null,
      intro: null,
      fileName: name,
      byteSize: png.length,
      wxUrl: `https://mmbiz.qpic.cn/mmbiz_png/e2e${mediaSeq}/0?wx_fmt=png`,
      origin: 'local',
    })
    const [obj] = await objectRows(name)
    expect(obj).toMatchObject({
      id: row.objectId,
      biz_tag: WXOA_MEDIA_TAG,
      biz_ref: `wxoa:${a}`,
      is_public: 0,
      deleted_at: null,
    })
    const [sent] = fake.callsTo(ADD)
    expect(sent).toMatchObject({
      method: 'upload',
      accountId: a,
      query: { type: 'image' },
      file: { name, mime: 'image/png' },
    })
    expect(Buffer.compare(sent!.file!.data, png)).toBe(0)
    expect(sent!.fields).toBeUndefined()
    expect(await logOf(ds, trace)).toMatchObject({
      domain: 'wxoa.material',
      verb: 'upload',
      biz_id: String(row.id),
      ok: 1,
    })
  })

  it('a video carries its title and intro as the description; a thumbnail and a voice go as their type', async () => {
    fake.on(ADD, added)
    const video = await upload(
      'admin',
      { accountId: a, mediaKind: 'video', title: '视频标题', intro: 'An intro' },
      { data: mp4, name: `${unique()}.mp4` },
    ).expect(201)
    expect(video.body.data).toMatchObject({
      mediaKind: 'video',
      title: '视频标题',
      intro: 'An intro',
      wxUrl: null,
    })
    expect(fake.callsTo(ADD)[0]).toMatchObject({
      query: { type: 'video' },
      fields: { description: JSON.stringify({ title: '视频标题', introduction: 'An intro' }) },
    })
    await upload(
      'admin',
      { accountId: a, mediaKind: 'thumb' },
      { data: jpg, name: `${unique()}.jpg` },
    ).expect(201)
    const amr = Buffer.concat([Buffer.from('#!AMR\n'), Buffer.alloc(64, 0x3c)])
    await upload(
      'admin',
      { accountId: a, mediaKind: 'voice' },
      { data: amr, name: `${unique()}.amr` },
    ).expect(201)
    expect(fake.callsTo(ADD).map((c) => c.query?.type)).toEqual(['video', 'thumb', 'voice'])
  })

  it('400: no file, no account, an unknown kind, a video without title or intro, an image with one', async () => {
    const file = () => ({ data: png, name: `${unique()}.png` })
    const before = await objectCount()
    const res = await upload('admin', { accountId: a, mediaKind: 'image' }).expect(400)
    expect(res.body.code).toBe(Err.STORAGE_FILE_REQUIRED.code)
    await upload('admin', { mediaKind: 'image' }, file()).expect(400)
    await upload('admin', { accountId: a, mediaKind: 'gif' }, file()).expect(400)
    await upload('admin', { accountId: a, mediaKind: 'video', intro: 'x' }, file()).expect(400)
    await upload('admin', { accountId: a, mediaKind: 'video', title: 'x' }, file()).expect(400)
    await upload('admin', { accountId: a, mediaKind: 'image', title: 'x' }, file()).expect(400)
    await upload(
      'admin',
      { accountId: a, mediaKind: 'image', title: 'x'.repeat(65) },
      file(),
    ).expect(400)
    expect(fake.callsTo(ADD)).toHaveLength(0)
    expect(await objectCount()).toBe(before)
  })

  it('a type or size the kind does not take is refused before anything is stored or sent', async () => {
    const before = await objectCount()
    const refused = async (
      kind: string,
      file: { data: Buffer; name: string },
      status: number,
      code: string,
    ) => {
      const res = await upload('admin', { accountId: a, mediaKind: kind }, file).expect(status)
      expect(res.body.code).toBe(code)
    }
    const typeRejected = Err.STORAGE_TYPE_REJECTED.code
    // an extension of another kind, content that is not what its name says, a never-allowed type
    await refused('voice', { data: png, name: `${unique()}.png` }, 422, typeRejected)
    await refused('image', { data: pdf, name: `${unique()}.jpg` }, 422, typeRejected)
    await refused('thumb', { data: png, name: `${unique()}.png` }, 422, typeRejected)
    await refused('image', { data: pdf, name: `${unique()}.pdf` }, 422, typeRejected)
    // a thumbnail over WeChat's 64 KB
    const big = Buffer.concat([jpg, Buffer.alloc(64 * KB)])
    await refused('thumb', { data: big, name: `${unique()}.jpg` }, 413, Err.PAYLOAD_TOO_LARGE.code)
    expect(fake.callsTo(ADD)).toHaveLength(0)
    expect(await objectCount()).toBe(before)
  })

  it('WeChat refusing the upload, or answering no media_id, takes the local object back', async () => {
    const before = Number(
      (await ds.query('SELECT COUNT(*) AS n FROM wxoa_material WHERE account_id = ?', [a]))[0].n,
    )
    fake.on(ADD, upstreamError(40005))
    const refusedName = `${unique()}.png`
    const res = await upload(
      'admin',
      { accountId: a, mediaKind: 'image' },
      { data: png, name: refusedName },
    ).expect(422)
    expect(res.body).toMatchObject({ code: Err.WXOA_UPSTREAM_REFUSED.code })
    fake.on(ADD, { url: 'http://mmbiz.qpic.cn/x/0' })
    const blankName = `${unique()}.png`
    await upload(
      'admin',
      { accountId: a, mediaKind: 'image' },
      { data: png, name: blankName },
    ).expect(502)
    for (const name of [refusedName, blankName]) {
      const rows = await objectRows(name)
      expect(rows).toHaveLength(1)
      expect(rows[0].deleted_at).not.toBeNull()
    }
    expect(
      Number(
        (await ds.query('SELECT COUNT(*) AS n FROM wxoa_material WHERE account_id = ?', [a]))[0].n,
      ),
    ).toBe(before)
  })
})

describe('list and counts', () => {
  it("lists an account's materials only, by kind and by title or file name", async () => {
    const title = `${unique()}-title`
    const video = await material(b, { media_kind: 'video', title, intro: 'i' })
    const named = await material(b, { file_name: `${title}.png` })
    const voice = await material(b, { media_kind: 'voice' })
    await material(a, { title })
    const list = async (query: string) =>
      (await call('admin', 'get', `?accountId=${b}&pageSize=100&${query}`).expect(200)).body.data
    const ids = (page: { items: { id: number }[] }) => page.items.map((m) => m.id).sort()
    expect(ids(await list(''))).toEqual(expect.arrayContaining([video, named, voice]))
    expect((await list('')).items.every((m: { accountId: number }) => m.accountId === b)).toBe(true)
    expect(ids(await list(`title=${encodeURIComponent(title)}`))).toEqual([video, named].sort())
    expect(ids(await list(`title=${encodeURIComponent(title)}&mediaKind=video`))).toEqual([video])
    await call('admin', 'get', '').expect(400)
    await call('admin', 'get', `?accountId=${b}&mediaKind=news`).expect(400)
  })

  it("counts are WeChat's", async () => {
    fake.on(COUNT, { image_count: 3, voice_count: 1, video_count: 2, news_count: 4 })
    const res = await call('admin', 'get', `/counts?accountId=${a}`).expect(200)
    expect(res.body.data).toEqual({ image: 3, voice: 1, video: 2, news: 4 })
    expect(fake.callsTo(COUNT)).toEqual([expect.objectContaining({ method: 'json', accountId: a })])
    await call('admin', 'get', '/counts').expect(400)
  })
})

describe('delete', () => {
  it('a material a reply rule uses → 409 without calling WeChat; once free it goes on both sides', async () => {
    fake.on(DEL, { errcode: 0, errmsg: 'ok' })
    const mediaId = unique()
    const id = await material(a, { media_id: mediaId })
    const rule = await insertRow(ds.manager, 'wxoa_reply_rule', {
      account_id: a,
      name: unique(),
      trigger_kind: 'keyword',
      match_mode: 'exact',
      keywords: JSON.stringify(['img']),
      reply_kind: 'image',
      reply_body: JSON.stringify({}),
      material_id: id,
    })
    const res = await call('admin', 'delete', `/${id}`).expect(409)
    expect(res.body.code).toBe(Err.IN_USE.code)
    expect(fake.callsTo(DEL)).toHaveLength(0)
    expect((await materialRow(id)).deleted_at).toBeNull()
    await ds.query('UPDATE wxoa_reply_rule SET deleted_at = NOW(3) WHERE id = ?', [rule])
    const trace = `${PREFIX}${process.pid}-remove`
    await call('admin', 'delete', `/${id}`).set('X-Request-Id', trace).expect(200)
    expect(fake.callsTo(DEL)).toEqual([
      expect.objectContaining({ accountId: a, body: { media_id: mediaId } }),
    ])
    expect((await materialRow(id)).deleted_at).not.toBeNull()
    expect(await logOf(ds, trace)).toMatchObject({ domain: 'wxoa.material', verb: 'remove', ok: 1 })
    await call('admin', 'delete', `/${id}`).expect(404)
  })

  it('WeChat refusing the delete keeps the row; a media_id WeChat no longer knows goes here', async () => {
    const id = await material(a)
    fake.on(DEL, upstreamError(45009))
    const res = await call('admin', 'delete', `/${id}`).expect(429)
    expect(res.body.code).toBe(Err.WXOA_QUOTA_EXCEEDED.code)
    expect((await materialRow(id)).deleted_at).toBeNull()
    fake.on(DEL, upstreamError(40007))
    await call('admin', 'delete', `/${id}`).expect(200)
    expect((await materialRow(id)).deleted_at).not.toBeNull()
  })

  it("the local copy goes with the material, only once WeChat took the delete; another account's object stays", async () => {
    const put = (accountId: number) =>
      inTenant1(() =>
        app
          .get(StorageService)
          .putWxoaMedia(
            accountId,
            { name: `${unique()}.png`, data: png },
            { exts: ['png'], maxBytes: 10 * KB * KB },
          ),
      )
    const objectGone = async (id: number) =>
      (await ds.query('SELECT deleted_at FROM fs_object WHERE id = ?', [id]))[0].deleted_at !== null
    const copy = await put(a)
    const id = await material(a, { object_id: copy.id, origin: 'local' })
    fake.on(DEL, upstreamError(45009), { errcode: 0, errmsg: 'ok' })
    await call('admin', 'delete', `/${id}`).expect(429)
    expect(await objectGone(copy.id)).toBe(false)
    await call('admin', 'delete', `/${id}`).expect(200)
    expect(await objectGone(copy.id)).toBe(true)
    const ofB = await put(b)
    const wrong = await material(a, { object_id: ofB.id, origin: 'local' })
    await call('admin', 'delete', `/${wrong}`).expect(200)
    expect((await materialRow(wrong)).deleted_at).not.toBeNull()
    expect(await objectGone(ofB.id)).toBe(false)
  })
})

describe('sync', () => {
  /** batchget_material listing `lists[type]` 20 at a time */
  const lister = (lists: Record<string, object[]>) => (c: FakeWxoaCall) => {
    const { type, offset, count } = c.body as { type: string; offset: number; count: number }
    const list = lists[type] ?? []
    const item = list.slice(offset, offset + count)
    return { total_count: list.length, item_count: item.length, item }
  }

  it('pages through batchget_material per listed kind and records what is new, links only', async () => {
    const known = unique()
    const local = await material(a, { media_id: known, origin: 'local', file_name: 'mine.png' })
    const images = Array.from({ length: 21 }, (_, i) => ({
      media_id: `${PREFIX}img-${i}`,
      name: `img-${i}.png`,
      update_time: 1_700_000_000,
      url: `http://mmbiz.qpic.cn/mmbiz_png/img${i}/0?wx_fmt=png`,
    }))
    images[1]!.url = 'https://example.com/elsewhere.png'
    images[2]!.media_id = known
    images[3]!.media_id = 'not a media id'
    const videos = [{ media_id: `${PREFIX}video-0`, name: 'clip.mp4', update_time: 1 }]
    fake.on(COUNT, { image_count: 21, voice_count: 0, video_count: 1, news_count: 7 })
    fake.on(BATCH, lister({ image: images, video: videos }))
    const started = await call('admin', 'post', '/sync').send({ accountId: a }).expect(201)
    expect(started.body.data).toMatchObject({ state: 'running', done: 0, finishedAt: null })
    expect(await settled(a)).toMatchObject({ state: 'done', done: 22, total: 22, code: null })
    expect(fake.callsTo(BATCH).map((c) => c.body)).toEqual([
      { type: 'image', offset: 0, count: 20 },
      { type: 'image', offset: 20, count: 20 },
      { type: 'voice', offset: 0, count: 20 },
      { type: 'video', offset: 0, count: 20 },
    ])
    expect(fake.calls.filter((c) => c.method !== 'json')).toHaveLength(0)
    const rows: { media_id: string; media_kind: string; wx_url: string | null; origin: string }[] =
      await ds.query(
        'SELECT media_id, media_kind, wx_url, origin, file_name FROM wxoa_material WHERE account_id = ? AND media_id LIKE ? AND deleted_at IS NULL',
        [a, `${PREFIX}%-%`],
      )
    const byId = new Map(rows.map((r) => [r.media_id, r]))
    expect(byId.get(`${PREFIX}img-0`)).toMatchObject({
      media_kind: 'image',
      origin: 'pulled',
      file_name: 'img-0.png',
      wx_url: 'https://mmbiz.qpic.cn/mmbiz_png/img0/0?wx_fmt=png',
    })
    expect(byId.get(`${PREFIX}img-1`)).toMatchObject({ wx_url: null })
    expect(byId.get(`${PREFIX}video-0`)).toMatchObject({ media_kind: 'video', wx_url: null })
    expect(byId.has('not a media id')).toBe(false)
    expect(rows.filter((r) => r.origin === 'pulled' && r.media_id.includes('-img-'))).toHaveLength(
      19,
    )
    // a material already known stays as it is, once
    expect(await materialRow(local)).toMatchObject({ origin: 'local', file_name: 'mine.png' })
    const [{ n }] = await ds.query(
      'SELECT COUNT(*) AS n FROM wxoa_material WHERE account_id = ? AND media_id = ?',
      [a, known],
    )
    expect(Number(n)).toBe(1)
    // a second run adds nothing
    const pulled = async () =>
      Number(
        (
          await ds.query(
            "SELECT COUNT(*) AS n FROM wxoa_material WHERE account_id = ? AND origin = 'pulled'",
            [a],
          )
        )[0].n,
      )
    const before = await pulled()
    await call('admin', 'post', '/sync').send({ accountId: a }).expect(201)
    expect(await settled(a)).toMatchObject({ state: 'done' })
    expect(await pulled()).toBe(before)
  })

  it('one sync per account at a time: a second start → 409 B6010; another account runs alongside', async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    fake.on(COUNT, async () => {
      await gate
      return { image_count: 0, voice_count: 0, video_count: 0, news_count: 0 }
    })
    fake.on(BATCH, lister({}))
    await call('admin', 'post', '/sync').send({ accountId: a }).expect(201)
    const again = await call('admin', 'post', '/sync').send({ accountId: a }).expect(409)
    expect(again.body.code).toBe(Err.WXOA_SYNC_RUNNING.code)
    await call('admin', 'post', '/sync').send({ accountId: b }).expect(201)
    expect((await call('admin', 'get', `/sync?accountId=${a}`).expect(200)).body.data.state).toBe(
      'running',
    )
    open()
    expect(await settled(a)).toMatchObject({ state: 'done', total: 0 })
    expect(await settled(b)).toMatchObject({ state: 'done' })
    await call('admin', 'post', '/sync').send({ accountId: a }).expect(201)
    expect(await settled(a)).toMatchObject({ state: 'done' })
  })

  it('a run left by a stopped instance reads interrupted and may run again; a failed run keeps its code', async () => {
    await redis.set(
      redisKey('wxoa', 'sync', b, 'material'),
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
      (await call('admin', 'get', `/sync?accountId=${b}`).expect(200)).body.data,
    ).toMatchObject({ state: 'interrupted', done: 3 })
    fake.on(COUNT, upstreamError(48001))
    await call('admin', 'post', '/sync').send({ accountId: b }).expect(201)
    expect(await settled(b)).toMatchObject({
      state: 'failed',
      code: Err.WXOA_API_UNAUTHORIZED.code,
    })
    expect((await call('admin', 'get', `/sync?accountId=${off}`).expect(422)).body.code).toBe(
      Err.WXOA_ACCOUNT_DISABLED.code,
    )
  })

  it('a start whose progress cannot be written frees the lock: the next start runs', async () => {
    const fresh = await account()
    const progressKey = redisKey('wxoa', 'sync', fresh, 'material')
    const set = redis.set.bind(redis) as (...args: unknown[]) => unknown
    const down = vi
      .spyOn(redis, 'set')
      .mockImplementation(((key: string, ...rest: unknown[]) =>
        key === progressKey ? Promise.reject(new Error('redis down')) : set(key, ...rest)) as never)
    await call('admin', 'post', '/sync').send({ accountId: fresh }).expect(500)
    down.mockRestore()
    fake.on(COUNT, { image_count: 0, voice_count: 0, video_count: 0, news_count: 0 })
    fake.on(BATCH, lister({}))
    await call('admin', 'post', '/sync').send({ accountId: fresh }).expect(201)
    expect(await settled(fresh)).toMatchObject({ state: 'done' })
  })

  it('an account never synced reads idle; 400 without an account', async () => {
    const fresh = await account()
    expect((await call('admin', 'get', `/sync?accountId=${fresh}`).expect(200)).body.data).toEqual({
      state: 'idle',
      done: 0,
      total: null,
      startedAt: null,
      finishedAt: null,
      code: null,
    })
    await call('admin', 'get', '/sync').expect(400)
    await call('admin', 'post', '/sync').send({}).expect(400)
  })
})

describe('temporary media for customer service', () => {
  const put = (accountId: number, name: string, data = png) =>
    inTenant1(() =>
      app
        .get(StorageService)
        .putWxoaMedia(accountId, { name, data }, { exts: ['png', 'jpg'], maxBytes: 10 * KB * KB }),
    )

  it("uploads the account's media object once as a temporary medium and reuses its media_id", async () => {
    fake.on(TEMP, { type: 'image', media_id: 'E2E-TEMP-1', created_at: 1 })
    const service = app.get(WxoaMaterialService)
    const obj = await put(a, `${unique()}.png`)
    expect(await inTenant1(() => service.tempMediaId(accounts.get(a)!, obj.id, 'image'))).toBe(
      'E2E-TEMP-1',
    )
    expect(await inTenant1(() => service.tempMediaId(accounts.get(a)!, obj.id, 'image'))).toBe(
      'E2E-TEMP-1',
    )
    const sent = fake.callsTo(TEMP)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ method: 'upload', accountId: a, query: { type: 'image' } })
    expect(Buffer.compare(sent[0]!.file!.data, png)).toBe(0)
    const ttl = await redis.ttl(redisKey('wxoa', 'temp', a, obj.id))
    expect(ttl).toBeGreaterThan(2 * 24 * 3600)
    expect(ttl).toBeLessThanOrEqual(2.5 * 24 * 3600)
  })

  it("another account's object, another tag or a deleted one → 404; a kind the file is not → C1002", async () => {
    fake.on(TEMP, { type: 'image', media_id: 'E2E-TEMP-2', created_at: 1 })
    const service = app.get(WxoaMaterialService)
    const caller = accounts.get(a)!
    const notFound = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(NotFoundException)
    const ofB = await put(b, `${unique()}.png`)
    await notFound(inTenant1(() => service.tempMediaId(caller, ofB.id, 'image')))
    const tagged = await put(a, `${unique()}.png`)
    await ds.query("UPDATE fs_object SET biz_tag = 'richtext' WHERE id = ?", [tagged.id])
    await notFound(inTenant1(() => service.tempMediaId(caller, tagged.id, 'image')))
    const gone = await put(a, `${unique()}.png`)
    await inTenant1(() => app.get(StorageService).remove(gone.id))
    await notFound(inTenant1(() => service.tempMediaId(caller, gone.id, 'image')))
    const voice = await put(a, `${unique()}.png`)
    await expect(
      inTenant1(() => service.tempMediaId(caller, voice.id, 'voice')),
    ).rejects.toMatchObject({
      err: { code: Err.STORAGE_TYPE_REJECTED.code },
    })
    expect(fake.callsTo(TEMP)).toHaveLength(0)
  })

  it('a cached media_id is not handed out once the object is deleted or asked for as a kind it is not', async () => {
    fake.on(TEMP, { type: 'image', media_id: 'E2E-TEMP-3', created_at: 1 })
    const service = app.get(WxoaMaterialService)
    const caller = accounts.get(a)!
    const obj = await put(a, `${unique()}.png`)
    expect(await inTenant1(() => service.tempMediaId(caller, obj.id, 'image'))).toBe('E2E-TEMP-3')
    await expect(
      inTenant1(() => service.tempMediaId(caller, obj.id, 'voice')),
    ).rejects.toMatchObject({
      err: { code: Err.STORAGE_TYPE_REJECTED.code },
    })
    await inTenant1(() => app.get(StorageService).remove(obj.id))
    await expect(
      inTenant1(() => service.tempMediaId(caller, obj.id, 'image')),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(fake.callsTo(TEMP)).toHaveLength(1)
  })

  it('a file two kinds take is uploaded again as the other kind, not reused', async () => {
    fake.on(
      TEMP,
      { type: 'image', media_id: 'E2E-TEMP-4', created_at: 1 },
      { type: 'thumb', media_id: 'E2E-TEMP-5', created_at: 1 },
    )
    const service = app.get(WxoaMaterialService)
    const caller = accounts.get(a)!
    const obj = await put(a, `${unique()}.jpg`, jpg)
    expect(await inTenant1(() => service.tempMediaId(caller, obj.id, 'image'))).toBe('E2E-TEMP-4')
    expect(await inTenant1(() => service.tempMediaId(caller, obj.id, 'thumb'))).toBe('E2E-TEMP-5')
    expect(await inTenant1(() => service.tempMediaId(caller, obj.id, 'thumb'))).toBe('E2E-TEMP-5')
    expect(fake.callsTo(TEMP).map((c) => c.query)).toEqual([{ type: 'image' }, { type: 'thumb' }])
  })
})

describe('accounts and permissions', () => {
  it('an unknown or deleted account → 404 on every route; a disabled one → B6011', async () => {
    const gone = await account()
    const id = await material(gone)
    const offMaterial = await material(off)
    await ds.query('UPDATE wxoa_account SET deleted_at = NOW(3) WHERE id = ?', [gone])
    const file = () => ({ data: png, name: `${unique()}.png` })
    const before = await objectCount()
    for (const accountId of [MISSING, gone]) {
      await call('admin', 'get', `?accountId=${accountId}`).expect(404)
      await call('admin', 'get', `/counts?accountId=${accountId}`).expect(404)
      await call('admin', 'get', `/sync?accountId=${accountId}`).expect(404)
      await call('admin', 'post', '/sync').send({ accountId }).expect(404)
      await upload('admin', { accountId, mediaKind: 'image' }, file()).expect(404)
    }
    await call('admin', 'delete', `/${id}`).expect(404)
    await call('admin', 'delete', `/${MISSING}`).expect(404)
    const disabled = Err.WXOA_ACCOUNT_DISABLED.code
    for (const res of [
      await call('admin', 'get', `?accountId=${off}`).expect(422),
      await call('admin', 'get', `/counts?accountId=${off}`).expect(422),
      await call('admin', 'post', '/sync').send({ accountId: off }).expect(422),
      await upload('admin', { accountId: off, mediaKind: 'image' }, file()).expect(422),
      await call('admin', 'delete', `/${offMaterial}`).expect(422),
    ])
      expect(res.body.code).toBe(disabled)
    expect(await objectCount()).toBe(before)
    expect(fake.calls).toHaveLength(0)
    expect((await materialRow(offMaterial)).deleted_at).toBeNull()
  })

  it('403 per permission: browse reads, create / remove / sync write', async () => {
    const id = await material(a)
    const file = () => ({ data: png, name: `${unique()}.png` })
    for (const path of [`?accountId=${a}`, `/counts?accountId=${a}`, `/sync?accountId=${a}`])
      await call('plain', 'get', path).expect(403)
    await call('reader', 'get', `?accountId=${a}`).expect(200)
    for (const who of ['plain', 'reader'] as const) {
      await upload(who, { accountId: a, mediaKind: 'image' }, file()).expect(403)
      await call(who, 'delete', `/${id}`).expect(403)
      await call(who, 'post', '/sync').send({ accountId: a }).expect(403)
    }
    expect(fake.calls).toHaveLength(0)
    expect((await materialRow(id)).deleted_at).toBeNull()
  })

  it('Swagger documents every route', async () => {
    const doc = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body
    expect(
      Object.keys(doc.paths)
        .filter((p) => p.startsWith(URL))
        .sort(),
    ).toEqual([URL, `${URL}/counts`, `${URL}/sync`, `${URL}/{id}`])
    expect(Object.keys(doc.paths[URL]).sort()).toEqual(['get', 'post'])
    expect(Object.keys(doc.paths[`${URL}/sync`]).sort()).toEqual(['get', 'post'])
  })
})
