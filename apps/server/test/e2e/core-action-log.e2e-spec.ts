// core/audit @ActionLog (see docs/design-notes.md#audit): one aud_action_log row per call with the caller (id, username,
// dept), request (method, URL, IP, UA), masked and truncated params/result, ok or the error's message
// key, cost; bizId from the option or `:id`; fire-and-forget (a failing bizId or insert never breaks
// the request); @SkipActionLog routes and the auth endpoints write nothing; the password change does.
import { Body, Controller, Delete, HttpCode, Logger, Param, Post, Put } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { ActionLog, SkipActionLog } from '../../src/core/audit/action-log.js'
import { AuditWriter } from '../../src/core/audit/audit-writer.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { MASK, redactedJson, redactedUrl, Sensitive } from '../../src/core/redact.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { logOf } from '../setup/audit.js'
import { agentFor } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const thing = { domain: 'test.thing' }

@Controller('audit-probe')
class AuditProbeController {
  @Post('things')
  @ActionLog({
    ...thing,
    verb: 'create',
    bizId: (_req, r) => (r as { id: number } | undefined)?.id,
  })
  create(@Body() body: unknown) {
    return { id: 42, apiToken: 'tok-plain', echo: body }
  }

  @Put('things/:id')
  @HttpCode(200)
  @ActionLog({ ...thing, verb: 'modify' })
  update() {
    return 'y'.repeat(5000)
  }

  @Delete('things/:id')
  @ActionLog({ ...thing, verb: 'remove' })
  remove() {
    throw new BizError(Err.IN_USE)
  }

  @Post('boom')
  @ActionLog({ ...thing, verb: 'run' })
  boom() {
    throw new Error('connect ECONNREFUSED db-password=hunter2')
  }

  @Post('validated')
  @ActionLog({ ...thing, verb: 'import' })
  validated(@Body({ schema: z.object({ title: z.string().min(3) }) }) body: { title: string }) {
    return body
  }

  @Post('bad-biz-id')
  @HttpCode(200)
  @ActionLog({
    ...thing,
    verb: 'modify',
    bizId: () => {
      throw new Error('bizId bug')
    },
  })
  badBizId() {
    return 'fine'
  }

  @Post('skipped')
  @HttpCode(200)
  @SkipActionLog()
  skipped() {
    return 'fine'
  }

  @Post('sensitive')
  @HttpCode(200)
  @Sensitive('plainValue')
  @ActionLog({ ...thing, verb: 'modify' })
  sensitive(@Body() body: unknown) {
    return { echo: body }
  }

  @Post('plain/:id')
  @HttpCode(200)
  @ActionLog({ ...thing, verb: 'modify' })
  plain(@Param('id') id: string) {
    return id
  }
}

interface Row {
  trace_id: string
  domain: string
  verb: string
  biz_id: string | null
  user_id: number | null
  user_type: string
  username: string | null
  dept_name: string | null
  http_method: string
  url: string
  ip: string | null
  location: string | null
  user_agent: string | null
  params: string | null
  result: string | null
  ok: number
  error_msg: string | null
  cost_ms: number
  created_at: Date
}

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let agent: Awaited<ReturnType<typeof agentFor>>
let adminId: number
let seq = 0

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [AuditProbeController],
  }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  await ds.query('DELETE FROM aud_action_log')
  adminId = Number((await ds.query("SELECT id FROM iam_user WHERE username = 'admin'"))[0].id)
  agent = await agentFor(app)
})

afterAll(async () => {
  if (redis) await cleanRedis(redis)
  await app?.close()
})

/** A fresh trace id per request, so each test finds its own row. */
const trace = () => `act-${process.pid}-${++seq}`

it('redactedJson masks secret-named keys at any depth, keeps the rest, cuts to max', () => {
  const body = {
    title: 'T',
    password: 'p1',
    nested: { apiKey: 'k', list: [{ secretAnswer: 's', code: 'c', dictCode: 'd', answer: 'a' }] },
    captchaTicket: 't',
    id: 10n,
  }
  expect(JSON.parse(redactedJson(body, 4096)!)).toEqual({
    title: 'T',
    password: MASK,
    nested: {
      apiKey: MASK,
      list: [{ secretAnswer: MASK, code: MASK, dictCode: 'd', answer: MASK }],
    },
    captchaTicket: MASK,
    id: '10',
  })
  expect(redactedJson('x'.repeat(10), 4)).toBe('"xxx')
  expect(redactedJson(undefined, 10)).toBeNull()
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  expect(redactedJson(cycle, 10)).toBeNull()
})

it('redactedJson / redactedUrl mask the @Sensitive fields too', () => {
  expect(JSON.parse(redactedJson({ a: { plainValue: 'v' }, b: 1 }, 4096, ['plainValue'])!)).toEqual(
    {
      a: { plainValue: MASK },
      b: 1,
    },
  )
  expect(redactedUrl('/x?plainValue=v&b=1', ['plainValue'])).toBe(`/x?plainValue=${MASK}&b=1`)
})

it('redactedUrl masks secret-named query values, keeps the path and the other params', () => {
  expect(redactedUrl('/api/x/1')).toBe('/api/x/1')
  expect(redactedUrl('/api/x?page=1&token=abc&code=42&dictCode=d&api%5Fkey=k&flag')).toBe(
    `/api/x?page=1&token=${MASK}&code=${MASK}&dictCode=d&api%5Fkey=${MASK}&flag`,
  )
})

it('success: caller, request, masked params and result, bizId from the result', async () => {
  const t = trace()
  await agent
    .post('/api/audit-probe/things?page=1&q=abc&accessToken=tok-in-url')
    .set({ 'X-Request-Id': t, 'User-Agent': 'vitest-ua' })
    .send({ title: 'T', password: 'p1', nested: { token: 'x', dictCode: 'd' } })
    .expect(201)
  const row = await logOf<Row>(ds, t)
  expect(row).toMatchObject({
    domain: 'test.thing',
    verb: 'create',
    biz_id: '42',
    user_id: adminId,
    username: 'admin',
    user_type: 'admin',
    dept_name: 'seed.dept.hq',
    http_method: 'POST',
    url: `/api/audit-probe/things?page=1&q=abc&accessToken=${MASK}`,
    ip: '127.0.0.1',
    location: null,
    user_agent: 'vitest-ua',
    ok: 1,
    error_msg: null,
  })
  expect(Number(row!.cost_ms)).toBeGreaterThanOrEqual(0)
  expect(JSON.parse(row!.params!)).toEqual({
    query: { page: '1', q: 'abc', accessToken: MASK },
    body: { title: 'T', password: MASK, nested: { token: MASK, dictCode: 'd' } },
  })
  expect(JSON.parse(row!.result!)).toMatchObject({ id: 42, apiToken: MASK })
  expect(JSON.stringify(row)).not.toContain('tok-in-url')
})

it('@Sensitive fields of the route are masked in the query, body and result (any depth)', async () => {
  const t = trace()
  await agent
    .post('/api/audit-probe/sensitive?plainValue=q-secret&page=1')
    .set('X-Request-Id', t)
    .send({ plainValue: 'b-secret', nested: [{ plainValue: 'n-secret' }], other: 'o' })
    .expect(200)
  const row = await logOf<Row>(ds, t)
  expect(row!.url).toBe(`/api/audit-probe/sensitive?plainValue=${MASK}&page=1`)
  expect(JSON.parse(row!.params!)).toEqual({
    query: { plainValue: MASK, page: '1' },
    body: { plainValue: MASK, nested: [{ plainValue: MASK }], other: 'o' },
  })
  expect(JSON.parse(row!.result!)).toEqual({
    echo: { plainValue: MASK, nested: [{ plainValue: MASK }], other: 'o' },
  })
  expect(JSON.stringify(row)).not.toMatch(/-secret/)
})

it('bizId defaults to :id; params cut to 4 KB and result to 2 KB', async () => {
  const t = trace()
  await agent
    .put('/api/audit-probe/things/7')
    .set('X-Request-Id', t)
    .send({ note: 'n'.repeat(6000) })
    .expect(200)
  const row = await logOf<Row>(ds, t)
  expect(row).toMatchObject({ verb: 'modify', biz_id: '7', ok: 1 })
  expect(row!.params).toHaveLength(4096)
  expect(row!.result).toHaveLength(2048)
  const t2 = trace()
  await agent.post('/api/audit-probe/plain/abc').set('X-Request-Id', t2).expect(200)
  expect(await logOf<Row>(ds, t2)).toMatchObject({ biz_id: 'abc', params: null })
})

it.each([
  ['delete', '/api/audit-probe/things/9', 409, Err.IN_USE.key, '9'],
  ['post', '/api/audit-probe/boom', 500, Err.INTERNAL.key, null],
  ['post', '/api/audit-probe/validated', 400, Err.VALIDATION_FAILED.key, null],
] as const)(
  'failure %s %s → ok 0, error_msg = the message key, no result',
  async (method, url, status, key, bizId) => {
    const t = trace()
    await agent[method](url).set('X-Request-Id', t).send({ title: 'x' }).expect(status)
    const row = await logOf<Row>(ds, t)
    expect(row).toMatchObject({ ok: 0, error_msg: key, result: null, biz_id: bizId })
    expect(JSON.stringify(row)).not.toContain('hunter2')
  },
)

// "no row" is proven by the writer never being called: the interceptor hands a row over before the
// response goes out, so there is nothing to wait for (a sleep would pass a late insert under load)
it('never breaks the request: a throwing bizId skips the row, a failing insert is only logged', async () => {
  const action = vi.spyOn(app.get(AuditWriter), 'action')
  const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  try {
    const res = await agent
      .post('/api/audit-probe/bad-biz-id')
      .set('X-Request-Id', trace())
      .expect(200)
    expect(res.body.data).toBe('fine')
    expect(action).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledWith(expect.anything(), 'action log skipped')

    await ds.query('RENAME TABLE aud_action_log TO aud_action_log_away')
    try {
      await agent.post('/api/audit-probe/plain/1').set('X-Request-Id', trace()).expect(200)
      // the table comes back only once the insert has failed (and was logged)
      await vi.waitFor(
        () => expect(logged).toHaveBeenCalledWith(expect.anything(), 'action log insert failed'),
        { timeout: 5000 },
      )
    } finally {
      await ds.query('RENAME TABLE aud_action_log_away TO aud_action_log')
    }
  } finally {
    action.mockRestore()
    logged.mockRestore()
  }
})

it('@SkipActionLog routes and the auth endpoints write no row', async () => {
  const action = vi.spyOn(app.get(AuditWriter), 'action')
  try {
    await agent.post('/api/audit-probe/skipped').set('X-Request-Id', trace()).expect(200)
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set({ 'X-Request-Id': trace(), 'X-Forwarded-For': '203.0.113.9' })
      .send({ username: 'admin', password: 'wrong-password' })
      .expect(401)
    expect(action).not.toHaveBeenCalled()
    // the spy does see a logged route: the check above is not vacuous
    await agent.post('/api/audit-probe/plain/2').set('X-Request-Id', trace()).expect(200)
    expect(action).toHaveBeenCalledTimes(1)
  } finally {
    action.mockRestore()
  }
})

it('the own password change is logged with every password masked', async () => {
  const t = trace()
  await agent
    .put('/api/iam/profile/password')
    .set('X-Request-Id', t)
    .send({ oldPassword: 'not-the-password', newPassword: 'Another@Pass2026' })
    .expect(400)
  const row = await logOf<Row>(ds, t)
  expect(row).toMatchObject({
    domain: 'iam.profile',
    verb: 'change-password',
    ok: 0,
    error_msg: Err.AUTH_OLD_PASSWORD_WRONG.key,
    username: 'admin',
  })
  expect(JSON.parse(row!.params!)).toEqual({ body: { oldPassword: MASK, newPassword: MASK } })
  expect(row!.params).not.toContain('Another@Pass2026')
})
