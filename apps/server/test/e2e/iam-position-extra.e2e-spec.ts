// iam/position, hand-written beside the standard CRUD spec (iam-position.e2e-spec.ts, rendered by the
// codegen test template; docs/codegen-golden.md): what depends on this module's seeds and links: seeded
// names (seed.position.* keys) found and exported by their text, "in use" = a position a live user holds
// (no foreign key: the reference registry, position.entity.ts → 409 `in_use`; a removed assignment, its
// link soft-deleted, holds nothing).
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err } from '@qiwu/shared'
import ExcelJS from 'exceljs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'pos-extra-'
const URL = '/api/iam/positions'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let token: string
let assignedId: number

const call = (method: 'get' | 'post' | 'delete', path = '', body?: object) => {
  const req = request(app.getHttpServer())[method](`${URL}${path}`).set(bearer(token))
  return body ? req.send(body) : req
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  token = (await signIn(app)).accessToken
  // the seeded admin holds the first demo position (iam.seed.ts)
  assignedId = Number(
    (
      await ds.query(
        "SELECT up.position_id AS id FROM iam_user_positions up JOIN iam_user u ON u.id = up.user_id WHERE u.username = 'admin'",
      )
    )[0].id,
  )
})

afterAll(async () => {
  if (ds) {
    await ds.query(
      'DELETE up FROM iam_user_positions up JOIN iam_user u ON u.id = up.user_id WHERE u.username LIKE ?',
      [`${PREFIX}%`],
    )
    await ds.query('DELETE FROM iam_user WHERE username LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM iam_position WHERE code LIKE ?', [`${PREFIX}%`])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

it('name filter: seeded rows (name = seed.position.* key) are found by their text in any language', async () => {
  const names = async (name: string) =>
    (await call('get').query({ name }).expect(200)).body.data.items.map(
      (r: { name: string }) => r.name,
    )
  expect(await names('技术负责')).toEqual(['seed.position.engLead'])
  expect(await names('engineering LEAD')).toEqual(['seed.position.engLead'])
  expect(await names('Support spec')).toEqual(['seed.position.support'])
  expect(await names('seed.position.dev')).toEqual(['seed.position.developer']) // the key itself
  expect(await names(`${PREFIX}no-such-name`)).toEqual([])
})

it('export: a seeded name as its text in the request language', async () => {
  const res = await call('get', '/export')
    .query({ code: 'eng_lead' })
    .set('Accept-Language', 'en-US')
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = []
      r.on('data', (c: Buffer) => chunks.push(c))
      r.on('end', () => cb(null, Buffer.concat(chunks)))
    })
    .expect(200)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(res.body as unknown as Parameters<typeof wb.xlsx.load>[0])
  expect(wb.worksheets[0]!.getRow(2).getCell(2).value).toBe('Engineering lead')
})

it('409 in use: a position assigned to a user cannot be deleted, alone or in a batch', async () => {
  const code = `${PREFIX}${process.pid}`
  const { id } = (await call('post', '', { code, name: code }).expect(201)).body.data
  const res = await call('delete', `/${assignedId}`).expect(409)
  expect(res.body).toMatchObject({ code: Err.IN_USE.code, msg: '数据正在被使用，不能删除' })
  await call('post', '/batch-delete', { ids: [id, assignedId] }).expect(409)
  expect(
    await ds.query('SELECT id FROM iam_position WHERE id IN (?) AND deleted_at IS NULL', [
      [id, assignedId],
    ]),
  ).toHaveLength(2)

  // assigned, then unassigned: the link stays soft-deleted and no longer counts
  const users = (method: 'post' | 'put', path: string, body: object) =>
    request(app.getHttpServer())[method](`/api/iam/users${path}`).set(bearer(token)).send(body)
  const user = (
    await users('post', '', {
      username: `${PREFIX}u${process.pid}`,
      displayName: 'u',
      password: 'Given#Pass1',
      positionIds: [id],
    }).expect(201)
  ).body.data.id
  await call('delete', `/${id}`).expect(409)
  await users('put', `/${user}`, { positionIds: [] }).expect(200)
  await call('delete', `/${id}`).expect(200)
})
