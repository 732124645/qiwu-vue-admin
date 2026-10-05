// messaging.inbox (generated CRUD; see docs/design-notes.md#codegen, #api-envelope), read-only admin routes and
// signed-in user's own messages. Rows go straight into the table for read tests.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, inboxPerms, RT } from '@qiwu/shared'
import { vi } from 'vitest'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { RealtimeService } from '../../src/core/realtime/realtime.service.js'
import { logOf } from '../setup/audit.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { Inbox } from '../../src/modules/platform/messaging/inbox/inbox.entity.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-inbox-'
const URL = '/api/messaging/inboxes'
const MISSING = 999_999

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens: Record<'admin' | 'reader' | 'plain', string> = { admin: '', reader: '', plain: '' }
const userIds: number[] = []
let roleId: number
/** the table's last id before this spec: every row above it is this spec's (cleanup) */
let lastId = 0
let lastTemplateId = 0

const call = (
  who: keyof typeof tokens,
  method: 'get' | 'post' | 'put' | 'delete',
  path = '',
  body?: object,
) => {
  const req = request(app.getHttpServer())[method](`${URL}${path}`).set(bearer(tokens[who]))
  return body ? req.send(body) : req
}
/** A row added straight to the table (the module takes no writes), as GET answers it. */
async function add(body: object) {
  const repo = ds.getRepository(Inbox)
  const { id } = await repo.save(repo.create(body))
  return (await call('admin', 'get', `/${id}`).expect(200)).body.data
}
let seq = 0
const unique = () => `${PREFIX}${++seq}`
/** A value of each dict column's dict (test data, read in beforeAll): an entry that fits the column. */
const DICT_VALUES: Record<string, string> = {}
/** A valid POST body made of `tag` (required and unique fields, the configured examples). */
const body = (tag: string, over: object = {}) => ({
  userId: 1,
  templateCode: tag,
  locale: DICT_VALUES['core.locale'],
  category: DICT_VALUES['messaging.inbox_category'],
  title: `${tag} title`,
  body: tag,
  ...over,
})
/** Live rows of the table (a list's total without filters). */
const count = async () =>
  Number((await ds.query('SELECT COUNT(*) AS n FROM msg_inbox WHERE deleted_at IS NULL'))[0].n)
const idsOf = (res: request.Response) => res.body.data.items.map((r: { id: number }) => r.id)

async function user(name: string, roles: number[]) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, r])
  userIds.push(id)
  return (await signIn(app, PREFIX + name)).accessToken
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  lastId = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM msg_inbox'))[0].n)
  lastTemplateId = Number(
    (await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM msg_inbox_template'))[0].n,
  )
  for (const [code, max] of [
    ['core.locale', 10],
    ['messaging.inbox_category', 16],
  ] as const) {
    const [entry] = await ds.query(
      'SELECT value FROM cfg_dict_entry WHERE dict_code = ? AND enabled = 1 AND CHAR_LENGTH(value) <= ? ORDER BY sort_no, id LIMIT 1',
      [code, max],
    )
    DICT_VALUES[code] = entry?.value ?? 'x'
  }
  roleId = await insertRow(ds.manager, 'iam_role', {
    code: `${PREFIX}reader`,
    name: `${PREFIX}reader`,
    data_scope: 'all',
  })
  const browse = await findId(ds.manager, 'iam_menu', { perms: inboxPerms.browse })
  await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [roleId, browse])
  tokens.admin = (await signIn(app)).accessToken
  tokens.reader = await user('reader', [roleId])
  tokens.plain = await user('plain', [])
})

afterAll(async () => {
  if (ds) {
    await ds.query('DELETE FROM msg_inbox WHERE id > ?', [lastId])
    await ds.query('DELETE FROM msg_inbox_template WHERE id > ?', [lastTemplateId])
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

describe('CRUD', () => {
  it('get: a row by id, as the list shows it', async () => {
    const row = await add(body(unique()))
    const res = await call('admin', 'get').query({ sort: '-id', pageSize: 1 }).expect(200)
    expect(res.body.data.items).toEqual([row])
  })

  it('list: newest first by the sort whitelist, all live rows counted, paging, created_at range', async () => {
    const ids: number[] = []
    for (let i = 0; i < 3; i++) ids.push((await add(body(unique()))).id)
    const list = (query: object) => call('admin', 'get').query(query).expect(200)
    const res = await list({ sort: '-id', pageSize: 3 })
    expect(idsOf(res)).toEqual([...ids].reverse())
    expect(res.body.data.total).toBe(await count())
    expect(idsOf(await list({ sort: '-id', page: 2, pageSize: 2 }))[0]).toBe(ids[0])
    // created_at from / to: instants (ISO-8601 with an offset)
    const [{ at }] = await ds.query('SELECT created_at AS at FROM msg_inbox WHERE id = ?', [ids[0]])
    const around = (ms: number) => new Date(at.getTime() + ms).toISOString()
    expect(
      idsOf(await list({ createdAtFrom: around(-1000), createdAtTo: around(1000), sort: '-id' })),
    ).toContain(ids[0])
    expect(idsOf(await list({ createdAtTo: around(-1000), sort: '-id' }))).not.toContain(ids[0])
  })

  it('list: text filters contain (LIKE wildcards literal)', async () => {
    const tag = unique()
    for (const suffix of ['a', 'b', 'c']) await add(body(`${tag}-${suffix}`))
    await add(body(`${tag}_x`))

    const list = (query: object) => call('admin', 'get').query(query).expect(200)
    const keys = (res: request.Response) =>
      res.body.data.items.map((r: { templateCode: string }) => r.templateCode)
    const res = await list({ templateCode: `${tag}-`, sort: '-id' })
    expect(keys(res)).toEqual([`${tag}-c`, `${tag}-b`, `${tag}-a`])
    expect(res.body.data.total).toBe(3)
    // `%` and `_` in the filter are plain characters
    expect(keys(await list({ templateCode: `${tag}_` }))).toEqual([`${tag}_x`])
    expect(keys(await list({ title: `${tag}-b title` }))).toEqual([`${tag}-b`])
    const page2 = await list({ templateCode: `${tag}-`, sort: 'id', page: 2, pageSize: 2 })
    expect(keys(page2)).toEqual([`${tag}-c`])
    expect(page2.body.data.total).toBe(3)
  })
})

describe('errors', () => {
  it('403 per permission: browse-only may list, not view; no perm → no list', async () => {
    const { id } = await add(body(unique()))
    await call('reader', 'get').expect(200)
    const forbidden = [call('reader', 'get', `/${id}`), call('plain', 'get')]
    for (const res of await Promise.all(forbidden)) {
      expect(res.status).toBe(403)
      expect(res.body.code).toBe(Err.FORBIDDEN.code)
    }
  })

  it('400: invalid query / id', async () => {
    expect((await call('admin', 'get').query({ sort: 'body' }).expect(400)).body.code).toBe(
      Err.VALIDATION_FAILED.code,
    )
    await call('admin', 'get', '/abc').expect(400)
  })

  it('404: an unknown id; no write routes (POST / PUT / DELETE → 404, nothing written)', async () => {
    const row = await add(body(unique()))
    for (const res of [
      await call('admin', 'get', `/${MISSING}`),
      await call('admin', 'post', '', body(unique())),
      await call('admin', 'put', `/${row.id}`, {}),
      await call('admin', 'delete', `/${row.id}`),
      await call('admin', 'post', '/batch-delete', { ids: [row.id] }),
    ])
      expect(res.status).toBe(404)
    expect((await call('admin', 'get', `/${row.id}`).expect(200)).body.data).toEqual(row)
  })
})

it('Swagger documents every route', async () => {
  const doc = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body
  expect(
    Object.keys(doc.paths)
      .filter((p) => p.startsWith(URL))
      .sort(),
  ).toEqual([
    URL,
    `${URL}/mine`,
    `${URL}/mine/read-all`,
    `${URL}/mine/unread`,
    `${URL}/mine/{id}`,
    `${URL}/mine/{id}/read`,
    `${URL}/{id}`,
  ])
  expect(
    doc.paths[URL].get.responses['200'].content['application/json'].schema.properties.data,
  ).toMatchObject({ properties: { items: { type: 'array' }, total: { type: 'integer' } } })
})

describe('admin inbox templates and messages', () => {
  const templates = '/api/messaging/inbox-templates'
  const template = (code: string, locale = 'zh-CN', extra: object = {}) => ({
    code,
    locale,
    name: code,
    title: 'Hello {name}',
    body: 'First {name}\nThen {other} {name}',
    category: 'system',
    enabled: true,
    ...extra,
  })

  it('saves one row per locale, derives parameters, validates codes and enums, and rejects duplicates', async () => {
    const code = `e2e_inbox.t${++seq}`
    const create = (payload: object) =>
      request(app.getHttpServer()).post(templates).set(bearer(tokens.admin)).send(payload)
    const zh = (await create({ ...template(code), paramNames: ['client'] }).expect(201)).body.data
    expect(zh.paramNames).toEqual(['name', 'other'])
    const en = (await create(template(code, 'en-US')).expect(201)).body.data
    expect(en.id).not.toBe(zh.id)
    const rows = (
      await request(app.getHttpServer())
        .get(templates)
        .set(bearer(tokens.admin))
        .query({ code, sort: 'code,locale' })
        .expect(200)
    ).body.data.items
    expect(rows.map((row: { locale: string }) => row.locale)).toEqual(['en-US', 'zh-CN'])
    const defaultRows = (
      await request(app.getHttpServer())
        .get(templates)
        .set(bearer(tokens.admin))
        .query({ code })
        .expect(200)
    ).body.data.items
    expect(defaultRows.map((row: { locale: string }) => row.locale)).toEqual(['en-US', 'zh-CN'])
    await create(template(code, 'zh-CN', { name: 'different' })).expect(409)
    await request(app.getHttpServer())
      .put(`${templates}/${zh.id}`)
      .set(bearer(tokens.admin))
      .send({ title: '{new} {name}', body: 'Plain' })
      .expect(200)
    const edited = (
      await request(app.getHttpServer())
        .get(`${templates}/${zh.id}`)
        .set(bearer(tokens.admin))
        .expect(200)
    ).body.data
    expect(edited.paramNames).toEqual(['new', 'name'])
    for (const field of ['locale', 'category', 'code'] as const) {
      const bad = { ...template(`e2e_inbox.t${++seq}`), [field]: 'invalid' }
      const res = await create(bad).set('Accept-Language', 'en-US').expect(400)
      expect(res.body.errors[0]).toMatchObject({ path: field, msg: expect.any(String) })
      expect(res.body.errors[0].msg).not.toMatch(/^validation\./)
    }
  })

  it('test sends the stored disabled row to caller, pushes notify:new, checks permission and logs action', async () => {
    const code = `e2e_inbox.t${++seq}`
    const created = await request(app.getHttpServer())
      .post(templates)
      .set(bearer(tokens.admin))
      .send(template(code, 'en-US', { enabled: false }))
      .expect(201)
    const id = created.body.data.id
    const url = `${templates}/${id}/test`
    const push = vi.spyOn(app.get(RealtimeService), 'toUser').mockImplementation(() => {})
    const beforeOther = Number(
      (await ds.query('SELECT COUNT(*) AS n FROM msg_inbox WHERE user_id = ?', [userIds[0]]))[0].n,
    )
    const trace = `${PREFIX}test-${id}`
    const sent = await request(app.getHttpServer())
      .post(url)
      .set(bearer(tokens.admin))
      .set('X-Request-Id', trace)
      .send({ params: { name: 'Alice', other: 'Next' } })
      .expect(200)
    expect(sent.body.data).toMatchObject({ ok: true, recordId: expect.any(Number) })
    const [row] = await ds.query('SELECT * FROM msg_inbox WHERE id = ?', [sent.body.data.recordId])
    const [admin] = await ds.query("SELECT id FROM iam_user WHERE username = 'admin'")
    expect(Number(row.user_id)).toBe(Number(admin.id))
    expect(
      Number(
        (await ds.query('SELECT COUNT(*) AS n FROM msg_inbox WHERE user_id = ?', [userIds[0]]))[0]
          .n,
      ),
    ).toBe(beforeOther)
    expect(row.title).toBe('Hello Alice')
    expect(row.body).toBe('First Alice\nThen Next Alice')
    expect(row.status).toBe('delivered')
    expect(push).toHaveBeenCalledWith(Number(admin.id), {
      type: RT.notifyNew,
      payload: { id: sent.body.data.recordId, title: 'Hello Alice' },
    })
    expect(await logOf(ds, trace)).toMatchObject({
      domain: 'messaging.inboxTemplate',
      verb: 'test',
      ok: 1,
    })
    await request(app.getHttpServer()).post(url).set(bearer(tokens.reader)).send({}).expect(403)
    await request(app.getHttpServer())
      .post(`${templates}/${MISSING}/test`)
      .set(bearer(tokens.admin))
      .send({})
      .expect(404)
    push.mockRestore()
  })

  it('shows the recipient display name and username in admin list and detail', async () => {
    const row = await add(body(unique(), { userId: userIds[0] }))
    expect(row.recipientName).toBe(`reader (${PREFIX}reader)`)
    const list = await call('admin', 'get').query({ userId: userIds[0], sort: '-id' }).expect(200)
    expect(list.body.data.items[0].recipientName).toBe(row.recipientName)
    await call('reader', 'get', `/${row.id}`).expect(403)
  })
})

describe('mine inbox isolation', () => {
  const mine = `${URL}/mine`
  const get = (who: 'reader' | 'plain', path = '') =>
    request(app.getHttpServer()).get(`${mine}${path}`).set(bearer(tokens[who]))
  const post = (who: 'reader' | 'plain', path: string) =>
    request(app.getHttpServer()).post(`${mine}${path}`).set(bearer(tokens[who]))

  it('lists and filters only my rows, reads one without a side effect, and hides another user id', async () => {
    const a = await add(body(unique(), { userId: userIds[0], category: 'system' }))
    const b = await add(body(unique(), { userId: userIds[0], category: 'business' }))
    const other = await add(body(unique(), { userId: userIds[1] }))
    const page = await get('reader').query({ sort: '-id' }).expect(200)
    expect(idsOf(page)).toContain(a.id)
    expect(idsOf(page)).toContain(b.id)
    expect(idsOf(page)).not.toContain(other.id)
    expect(
      idsOf(await get('reader').query({ unread: 'true', category: 'business' }).expect(200)),
    ).toContain(b.id)
    expect(idsOf(await get('reader').query({ category: 'system' }).expect(200))).not.toContain(b.id)
    expect((await get('reader', '/unread').expect(200)).body.data.unread).toBeGreaterThanOrEqual(2)
    await get('reader', `/${a.id}`).expect(200)
    expect((await get('reader', `/${a.id}`).expect(200)).body.data.readAt).toBeNull()
    await get('plain', `/${a.id}`).expect(404)
    await post('plain', `/${a.id}/read`).expect(404)
    expect((await get('reader', `/${a.id}`).expect(200)).body.data.readAt).toBeNull()
    await get('reader', `/${MISSING}`).expect(404)
    await get('reader').query({ category: 'invalid' }).expect(400)
  })

  it('reads my row once, then all mine; leaves the other user untouched', async () => {
    const a = await add(body(unique(), { userId: userIds[0] }))
    const b = await add(body(unique(), { userId: userIds[1] }))
    const before = (await get('reader', '/unread').expect(200)).body.data.unread
    expect((await post('reader', `/${a.id}/read`).expect(200)).body.data.unread).toBe(before - 1)
    expect((await post('reader', `/${a.id}/read`).expect(200)).body.data.unread).toBe(before - 1)
    expect((await post('reader', '/read-all').expect(200)).body.data.unread).toBe(0)
    expect(idsOf(await get('reader').query({ unread: 'true' }).expect(200))).toEqual([])
    expect((await get('plain', `/${b.id}`).expect(200)).body.data.readAt).toBeNull()
    expect((await get('plain', '/unread').expect(200)).body.data.unread).toBeGreaterThan(0)
    await request(app.getHttpServer()).get(mine).expect(401)
    await request(app.getHttpServer()).post(`${mine}/read-all`).expect(401)
  })
})
