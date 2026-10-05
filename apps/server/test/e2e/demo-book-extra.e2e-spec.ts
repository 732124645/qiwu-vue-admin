// demo/book, hand-written beside the generated standard spec (demo-book.e2e-spec.ts, docs/codegen-golden.md):
// the writing side of its dept reference (no foreign key: project.module.ts registers demo_book.dept_id,
// BaseCrudService checks it): a book in a missing or deleted dept → 404 and nothing written, for root too.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'book-extra-'
const URL = '/api/demo/books'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let token: string
const DEPT = { live: 0, gone: 0, missing: 0 }

const call = (method: 'post' | 'put', path: string, body: object) =>
  request(app.getHttpServer())[method](`${URL}${path}`).set(bearer(token)).send(body)
const body = (isbn: string, deptId: number) => ({
  isbn,
  title: isbn,
  publishedOn: '2024-05-01',
  price: 1,
  genre: 'fiction',
  deptId,
})
const books = (isbn: string) =>
  ds.query('SELECT dept_id FROM demo_book WHERE isbn = ? AND deleted_at IS NULL', [isbn])

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  token = (await signIn(app)).accessToken // root: no data scope to hide behind
  for (const k of ['live', 'gone'] as const) {
    DEPT[k] = await insertRow(ds.manager, 'iam_dept', { tree_path: '/', name: `${PREFIX}${k}` })
    await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ?', [`/${DEPT[k]}/`, DEPT[k]])
  }
  await ds.query('UPDATE iam_dept SET deleted_at = NOW(3) WHERE id = ?', [DEPT.gone])
  DEPT.missing = DEPT.gone + 1000
})

afterAll(async () => {
  if (ds) {
    await ds.query('DELETE FROM demo_book WHERE isbn LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM iam_dept WHERE name LIKE ?', [`${PREFIX}%`])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

it('create in a deleted or missing dept → 404, nothing written; in a live one → 201', async () => {
  for (const dept of [DEPT.gone, DEPT.missing]) {
    await call('post', '', body(`${PREFIX}c${dept}`, dept)).expect(404)
    expect(await books(`${PREFIX}c${dept}`)).toEqual([])
  }
  await call('post', '', body(`${PREFIX}c-live`, DEPT.live)).expect(201)
})

it('update into a deleted or missing dept → 404, the row unchanged', async () => {
  const isbn = `${PREFIX}u`
  const { id } = (await call('post', '', body(isbn, DEPT.live)).expect(201)).body.data
  for (const deptId of [DEPT.gone, DEPT.missing]) {
    await call('put', `/${id}`, { deptId, title: 'moved' }).expect(404)
    expect(await books(isbn)).toEqual([{ dept_id: DEPT.live }])
  }
  await call('put', `/${id}`, { deptId: DEPT.live, title: 'kept' }).expect(200)
})
