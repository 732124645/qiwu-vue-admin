// demo/invoice, hand-written beside the generated standard spec (demo-invoice.e2e-spec.ts,
// docs/codegen-golden.md): the writing side of a reference held by a sub row (no foreign keys).
// The generated saveLines writes the lines itself (not through BaseCrudService), so it runs
// assertReferencesLive per line. The G0 lines hold no reference: this spec registers `qty` as one to
// iam_dept (a fixture, any integer column does) and expects 404 with nothing written, for root too.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { referencedBy } from '../../src/core/db/references.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

referencedBy('iam_dept', { table: 'demo_invoice_line', column: 'qty' })

const PREFIX = 'inv-extra-'
const URL = '/api/demo/invoices'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let token: string
const DEPT = { live: 0, gone: 0, missing: 0, later: 0 }

const call = (method: 'post' | 'put', path: string, body: object) =>
  request(app.getHttpServer())[method](`${URL}${path}`).set(bearer(token)).send(body)
const line = (item: string, qty: number, id?: number) => ({ id, item, qty, unitPrice: 1 })
const invoice = (invoiceNo: string, lines: object[]) => ({
  invoiceNo,
  buyer: invoiceNo,
  total: 1,
  state: 'issued',
  lines,
})
const linesOf = (invoiceNo: string) =>
  ds.query(
    `SELECT l.item, l.qty FROM demo_invoice_line l JOIN demo_invoice i ON i.id = l.invoice_id
      WHERE i.invoice_no = ? AND i.deleted_at IS NULL AND l.deleted_at IS NULL ORDER BY l.id`,
    [invoiceNo],
  )
const invoices = async (invoiceNo: string) =>
  Number(
    (await ds.query('SELECT COUNT(*) AS n FROM demo_invoice WHERE invoice_no = ?', [invoiceNo]))[0]
      .n,
  )

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  token = (await signIn(app)).accessToken // root: no data scope to hide behind
  for (const k of ['live', 'gone', 'later'] as const)
    DEPT[k] = await insertRow(ds.manager, 'iam_dept', { tree_path: '/', name: `${PREFIX}${k}` })
  await ds.query('UPDATE iam_dept SET deleted_at = NOW(3) WHERE id = ?', [DEPT.gone])
  DEPT.missing = DEPT.later + 1000
})

afterAll(async () => {
  if (ds) {
    await ds.query(
      `DELETE l FROM demo_invoice_line l JOIN demo_invoice i ON i.id = l.invoice_id
        WHERE i.invoice_no LIKE ?`,
      [`${PREFIX}%`],
    )
    await ds.query('DELETE FROM demo_invoice WHERE invoice_no LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM iam_dept WHERE name LIKE ?', [`${PREFIX}%`])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

it('create with a line pointing at a deleted or missing row → 404, neither invoice nor line written', async () => {
  for (const dept of [DEPT.gone, DEPT.missing]) {
    const no = `${PREFIX}c${dept}`
    await call('post', '', invoice(no, [line('ok', DEPT.live), line('bad', dept)])).expect(404)
    expect(await invoices(no)).toBe(0)
  }
  await call('post', '', invoice(`${PREFIX}c-live`, [line('ok', DEPT.live)])).expect(201)
})

it('update: a line changed or added to point at a deleted or missing row → 404, the lines unchanged; an unchanged value is not judged again', async () => {
  const no = `${PREFIX}u`
  const { id, lines } = (await call('post', '', invoice(no, [line('a', DEPT.later)])).expect(201))
    .body.data
  const lineId = lines[0].id
  for (const dept of [DEPT.gone, DEPT.missing]) {
    await call('put', `/${id}`, { lines: [line('a', dept, lineId)] }).expect(404)
    await call('put', `/${id}`, { lines: [line('a', DEPT.later, lineId), line('b', dept)] }).expect(
      404,
    )
    expect(await linesOf(no)).toEqual([{ item: 'a', qty: DEPT.later }])
  }
  // the line's row deleted meanwhile (behind the app's back): a write keeping the value passes
  await ds.query('UPDATE iam_dept SET deleted_at = NOW(3) WHERE id = ?', [DEPT.later])
  await call('put', `/${id}`, { lines: [line('a2', DEPT.later, lineId)] }).expect(200)
  expect(await linesOf(no)).toEqual([{ item: 'a2', qty: DEPT.later }])
})
