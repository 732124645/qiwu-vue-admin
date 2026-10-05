// iam/profile UI preferences (`iam_user_pref`): upsert/read/reset of the caller's own keys, no
// permission needed, isolation between users, key whitelist and value schema (400), size cap (413),
// 401 without a session, rows soft-deleted with their user (the reference registry), Swagger paths.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, type TableColumnsPref } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { softDeleteRows } from '../../src/core/db/references.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'pref-e2e-'
const URL = '/api/iam/profile/prefs'
const KEY = 'table.iam.position'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens: Record<'a' | 'b', string> = { a: '', b: '' }
const userIds: number[] = []

const call = (
  who: keyof typeof tokens,
  method: 'get' | 'put' | 'delete',
  key = KEY,
  body?: object,
) => {
  const req = request(app.getHttpServer())
    [method](`${URL}/${encodeURIComponent(key)}`)
    .set(bearer(tokens[who]))
  return body ? req.send(body) : req
}
const cols = (...props: string[]): TableColumnsPref => ({
  v: 1,
  columns: props.map((prop, i) => ({ prop, visible: i % 2 === 0 })),
})

/** A user without any role: the routes need a session, not a permission. */
async function user(name: string) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  userIds.push(id)
  return { id, token: (await signIn(app, PREFIX + name)).accessToken }
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  tokens.a = (await user('a')).token
  tokens.b = (await user('b')).token
})

afterAll(async () => {
  if (ds && userIds.length) await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
  if (redis) await cleanRedis(redis)
  await app?.close()
})

it('unset → null; PUT inserts, PUT again replaces; DELETE resets (and is idempotent)', async () => {
  expect((await call('a', 'get').expect(200)).body.data).toEqual({ value: null })
  await call('a', 'put', KEY, { value: cols('code', 'name') }).expect(200)
  expect((await call('a', 'get').expect(200)).body.data).toEqual({ value: cols('code', 'name') })
  await call('a', 'put', KEY, { value: cols('name', 'code', 'note') }).expect(200)
  expect((await call('a', 'get')).body.data.value).toEqual(cols('name', 'code', 'note'))
  await call('a', 'delete').expect(200)
  expect((await call('a', 'get')).body.data).toEqual({ value: null })
  // a reset soft-deletes the row; the next PUT brings it back
  expect(
    await ds.query(
      'SELECT deleted_at IS NOT NULL AS gone FROM iam_user_pref WHERE user_id = ? AND pref_key = ?',
      [userIds[0], KEY],
    ),
  ).toEqual([{ gone: 1 }])
  await call('a', 'delete').expect(200)
})

it('keys and users are isolated: one never reads or resets the other', async () => {
  const other = 'table.iam.user-list.main'
  await call('a', 'put', KEY, { value: cols('a1') }).expect(200)
  await call('a', 'put', other, { value: cols('a2') }).expect(200)
  expect((await call('b', 'get')).body.data).toEqual({ value: null })
  await call('b', 'put', KEY, { value: cols('b1') }).expect(200)
  await call('b', 'delete', other).expect(200)
  expect((await call('a', 'get')).body.data.value).toEqual(cols('a1'))
  expect((await call('a', 'get', other)).body.data.value).toEqual(cols('a2'))
  expect((await call('b', 'get')).body.data.value).toEqual(cols('b1'))
})

it('400: keys outside `table.<segment>{2,4}` for every method', async () => {
  const bad = [
    'table.iam', // one segment
    'table.a.b.c.d.e', // five segments
    'layout.iam.position', // unknown family
    'Table.iam.position',
    'table.iam.Position',
    'table.iam:position.x',
    'table.iam..position',
    'table.iam.position.',
    'table.-iam.position',
    `table.iam.${'x'.repeat(90)}`, // > 96
  ]
  for (const key of bad)
    for (const res of [
      await call('a', 'get', key),
      await call('a', 'put', key, { value: cols('code') }),
      await call('a', 'delete', key),
    ])
      expect([key, res.status, res.body.code]).toEqual([key, 400, Err.VALIDATION_FAILED.code])
})

it('400: values that are not column settings, with translated field messages', async () => {
  const bad: unknown[] = [
    undefined,
    null,
    { v: 2, columns: [] },
    { v: 1 },
    { v: 1, columns: [{ prop: '1code', visible: true }] },
    { v: 1, columns: [{ prop: 'co de', visible: true }] },
    { v: 1, columns: [{ prop: 'x'.repeat(65), visible: true }] },
    { v: 1, columns: [{ prop: 'code', visible: 'yes' }] },
    { v: 1, columns: Array.from({ length: 101 }, (_, i) => ({ prop: `c${i}`, visible: true })) },
  ]
  for (const value of bad) {
    const res = await call('a', 'put', KEY, { value })
    expect([value, res.status]).toEqual([value, 400])
    expect(res.body.code).toBe(Err.VALIDATION_FAILED.code)
  }
  const zh = await call('a', 'put', KEY, { value: { v: 1, columns: [{ prop: 'code' }] } })
  expect(zh.body.errors).toEqual([{ path: 'value.columns.0.visible', msg: '是否显示不能为空' }])
  const en = await call('a', 'put', KEY, {
    value: { v: 1, columns: Array.from({ length: 101 }, () => ({ prop: 'c', visible: true })) },
  }).set('Accept-Language', 'en-US')
  expect(en.body.msg).toBe('Columns must have at most 100 items')
  // an empty list is valid; nothing invalid above was stored
  await call('a', 'put', KEY, { value: { v: 1, columns: [] } }).expect(200)
  expect((await call('a', 'get')).body.data.value).toEqual({ v: 1, columns: [] })
})

it('413: a valid value over 8 KB serialized is refused and nothing is stored', async () => {
  await call('a', 'delete').expect(200)
  const big: TableColumnsPref = {
    v: 1,
    columns: Array.from({ length: 100 }, (_, i) => ({
      prop: `c${String(i).padStart(3, '0')}${'x'.repeat(60)}`,
      visible: true,
    })),
  }
  const res = await call('a', 'put', KEY, { value: big }).expect(413)
  expect(res.body.code).toBe(Err.PAYLOAD_TOO_LARGE.code)
  expect((await call('a', 'get')).body.data).toEqual({ value: null })
})

it('401 without a session', async () => {
  const anon = request(app.getHttpServer())
  for (const res of [
    await anon.get(`${URL}/${KEY}`),
    await anon.put(`${URL}/${KEY}`).send({ value: cols('code') }),
    await anon.delete(`${URL}/${KEY}`),
  ]) {
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(Err.UNAUTHENTICATED.code)
  }
})

it('a deleted user takes its preferences along (soft: the reference registry cascades)', async () => {
  const { id, token } = await user('gone')
  await request(app.getHttpServer())
    .put(`${URL}/${KEY}`)
    .set(bearer(token))
    .send({ value: cols('code') })
    .expect(200)
  await ds.transaction((q) => softDeleteRows(q, 'iam_user', [id]))
  expect(
    await ds.query('SELECT 1 FROM iam_user_pref WHERE user_id = ? AND deleted_at IS NULL', [id]),
  ).toEqual([])
  expect(await ds.query('SELECT 1 FROM iam_user_pref WHERE user_id = ?', [id])).toHaveLength(1)
})

it('Swagger documents the preference routes', async () => {
  const doc = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body
  const path = doc.paths[`${URL}/{key}`]
  expect(Object.keys(path).sort()).toEqual(['delete', 'get', 'put'])
  expect(
    path.get.responses['200'].content['application/json'].schema.properties.data,
  ).toMatchObject({ properties: { value: expect.any(Object) } })
})
