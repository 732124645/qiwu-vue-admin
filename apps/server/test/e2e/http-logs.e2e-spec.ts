// The API logs beyond the generated read-only pages (hand-written; the generated specs are
// audit-http-trace / audit-http-fault): the access log interceptor under its mode param and
// `@SkipHttpTrace` (`-t trace`), the error filter's fault rows (`-t fault`) and the fault page's
// handling state (`-t handle`). Probe routes come from a spec-only controller.
import {
  Body,
  type CanActivate,
  Controller,
  Get,
  Logger,
  Module,
  Post,
  UseGuards,
} from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  DEFAULT_HTTP_TRACE_EXCLUDE,
  Err,
  HTTP_TRACE_EXCLUDE_PARAM,
  HTTP_TRACE_MODE_PARAM,
  httpFaultPerms,
} from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { SkipActionLog } from '../../src/core/audit/action-log.js'
import { SkipHttpTrace, traceExcluded } from '../../src/core/audit/http-trace.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { Sensitive } from '../../src/core/redact.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-hl-'
const PROBE = '/api/e2e-http-logs'
const FAULTS = '/api/audit/http-faults'
const MISSING = 999_999_999

class ProbeFailure extends Error {}

/** A guard failing with a 5xx: before the route's interceptors, so its @Sensitive fields are unknown. */
class FailingGuard implements CanActivate {
  canActivate(): boolean {
    throw new ProbeFailure('guard kaboom')
  }
}

// spec-only routes (every signed-in user); they log nothing to the action log
@Controller('e2e-http-logs')
class ProbeController {
  @Post('echo')
  @SkipActionLog()
  echo(@Body() body: unknown) {
    return { got: body !== undefined }
  }

  @Get('read')
  read() {
    return 'read'
  }

  @Post('skip')
  @SkipHttpTrace()
  @SkipActionLog()
  skip() {
    return 'skipped'
  }

  @Post('secret')
  @Sensitive('paramValue')
  @SkipActionLog()
  secret() {
    return 'secret'
  }

  @Post('boom')
  @Sensitive('paramValue')
  @SkipActionLog()
  boom(): never {
    throw new ProbeFailure('kaboom: probe failure')
  }

  @Post('guard-boom')
  @UseGuards(FailingGuard)
  @SkipActionLog()
  guardBoom() {
    return 'unreachable'
  }

  @Post('boom-plain')
  @SkipActionLog()
  boomPlain(): never {
    throw new Error('plain kaboom')
  }

  /** a careless message: echoes what was sent, inline secrets, a parameter dump */
  @Post('boom-secret')
  @Sensitive('paramValue')
  @SkipActionLog()
  boomSecret(@Body() body: { password: string; paramValue: string; keep: string }): never {
    throw new ProbeFailure(
      `failed for ${body.password} / ${body.paramValue} / ${body.keep}; apiKey=k3y-inline, "token":"tok-inline", parameters: [7, 'p-inline']`,
    )
  }

  /** a database driver error: its message quotes the value it refused */
  @Post('boom-driver')
  @SkipActionLog()
  boomDriver(): never {
    throw Object.assign(
      new Error("Incorrect integer value: 'DRIVER-S3CRET' for column 'age' at row 1"),
      { sqlState: 'HY000', code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD' },
    )
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens: Record<'admin' | 'viewer', string> = { admin: '', viewer: '' }
let adminId: number
let viewerId: number
let roleId: number
let seq = 0
/** a fresh `X-Request-Id` (= trace id) */
const traceId = () => `${PREFIX}${process.pid}-${++seq}`

const call = (
  who: keyof typeof tokens | null,
  method: 'get' | 'post' | 'put' | 'delete',
  url: string,
  trace = traceId(),
) => {
  const req = request(app.getHttpServer())[method](url).set('X-Request-Id', trace)
  return who ? req.set(bearer(tokens[who])) : req
}

/**
 * No trace row for `trace`: a traced sentinel request sent after it has its row first (both go through
 * the same mode read and insert path, so the earlier one has been decided by then).
 */
async function untraced(trace: string) {
  const sentinel = traceId()
  await call('admin', 'post', `${PROBE}/echo`, sentinel).send({}).expect(201)
  expect(await logOf(ds, sentinel, 'aud_http_trace')).not.toBeNull()
  const [row] = await ds.query('SELECT id FROM aud_http_trace WHERE trace_id = ?', [trace])
  expect(row).toBeUndefined()
}

async function setParam(key: string, value: string) {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await app.get(ParamService).invalidate(key)
}

const setMode = (mode: string) => setParam(HTTP_TRACE_MODE_PARAM, mode)
const setExclude = (paths: string) => setParam(HTTP_TRACE_EXCLUDE_PARAM, paths)

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, ProbeModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  await setMode('write')
  // browse + view of the error log, no handle
  roleId = await insertRow(ds.manager, 'iam_role', {
    code: `${PREFIX}viewer`,
    name: `${PREFIX}viewer`,
    data_scope: 'all',
  })
  for (const perm of [httpFaultPerms.browse, httpFaultPerms.view])
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
      roleId,
      await findId(ds.manager, 'iam_menu', { perms: perm }),
    ])
  viewerId = await insertRow(ds.manager, 'iam_user', {
    username: `${PREFIX}viewer`,
    display_name: 'viewer',
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [viewerId, roleId])
  adminId = Number((await findId(ds.manager, 'iam_user', { username: 'admin' }))!)
  tokens.admin = (await signIn(app)).accessToken
  tokens.viewer = (await signIn(app, `${PREFIX}viewer`)).accessToken
})

afterAll(async () => {
  if (ds) {
    await setMode('write')
    await setExclude(DEFAULT_HTTP_TRACE_EXCLUDE)
    for (const table of ['aud_http_trace', 'aud_http_fault', 'aud_action_log'])
      // arch-allow: sql-concat table names from the list above
      await ds.query(`DELETE FROM ${table} WHERE trace_id LIKE ?`, [`${PREFIX}%`])
    await ds.query('DELETE FROM iam_user_roles WHERE user_id = ?', [viewerId])
    await ds.query('DELETE FROM iam_user WHERE id = ?', [viewerId])
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
    await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('trace: the API access log', () => {
  it('trace: write mode (the default) records a write with its caller, masked query and body, status, code, cost', async () => {
    const trace = traceId()
    const before = Date.now()
    await call('admin', 'post', `${PROBE}/echo?token=t0p&page=2`, trace)
      .set('User-Agent', 'hl-agent')
      .send({ name: 'n', password: 'Secret#1', nested: { apiKey: 'k', keep: [1, 2] } })
      .expect(201)
    const row = await logOf(ds, trace, 'aud_http_trace')
    expect(row).toMatchObject({
      user_id: adminId,
      username: 'admin',
      user_type: 'admin',
      client_id: 'console',
      method: 'POST',
      url: `${PROBE}/echo`,
      status_code: 201,
      biz_code: '0',
      msg: null,
      ip: '127.0.0.1',
      user_agent: 'hl-agent',
    })
    expect(JSON.parse(row.query)).toEqual({ token: '***', page: '2' })
    expect(JSON.parse(row.body)).toEqual({
      name: 'n',
      password: '***',
      nested: { apiKey: '***', keep: [1, 2] },
    })
    expect(row.cost_ms).toBeGreaterThanOrEqual(0)
    expect(new Date(row.started_at).getTime()).toBeGreaterThanOrEqual(before - 1000)
  })

  it('trace: reads (GET) are not recorded in write mode', async () => {
    const read = traceId()
    await call('admin', 'get', `${PROBE}/read`, read).expect(200)
    await untraced(read)
  })

  it('trace: errors are recorded with their status, code and message key (read translated); guard refusals (401) are not', async () => {
    const invalid = traceId()
    await call('admin', 'put', `${FAULTS}/${MISSING}/state`, invalid)
      .send({ state: 'bogus' })
      .expect(400)
    expect(await logOf(ds, invalid, 'aud_http_trace')).toMatchObject({
      status_code: 400,
      biz_code: Err.VALIDATION_FAILED.code,
      msg: Err.VALIDATION_FAILED.key,
    })
    const missing = traceId()
    await call('admin', 'put', `${FAULTS}/${MISSING}/state`, missing)
      .send({ state: 'resolved' })
      .expect(404)
    const notFound = await logOf(ds, missing, 'aud_http_trace')
    expect(notFound).toMatchObject({
      status_code: 404,
      biz_code: Err.NOT_FOUND.code,
      msg: Err.NOT_FOUND.key,
    })
    // stored as the key, read in the reader's language (detail and list)
    const detail = (lang: string) =>
      call('admin', 'get', `/api/audit/http-traces/${notFound.id}`)
        .set('Accept-Language', lang)
        .expect(200)
    expect((await detail('zh-CN')).body.data.msg).toBe('请求的资源不存在')
    expect((await detail('en-US')).body.data.msg).toBe('The requested resource does not exist')
    const listed = await call('admin', 'get', '/api/audit/http-traces')
      .query({ traceId: missing })
      .set('Accept-Language', 'en-US')
      .expect(200)
    expect(listed.body.data.items[0].msg).toBe('The requested resource does not exist')
    const anonymous = traceId()
    await call(null, 'post', `${PROBE}/echo`, anonymous).send({}).expect(401)
    await untraced(anonymous)
  })

  it('trace: the mode param: off records nothing, all adds reads, anything else is write; @SkipHttpTrace never', async () => {
    try {
      await setMode('off')
      const off = traceId()
      await call('admin', 'post', `${PROBE}/echo`, off).send({}).expect(201)
      await setMode('all')
      await untraced(off)
      const read = traceId()
      await call('admin', 'get', `${PROBE}/read`, read).expect(200)
      expect(await logOf(ds, read, 'aud_http_trace')).toMatchObject({
        method: 'GET',
        status_code: 200,
      })
      const skipped = traceId()
      await call('admin', 'post', `${PROBE}/skip`, skipped).expect(201)
      const health = traceId()
      await call(null, 'get', '/api/health', health).expect(200)
      await untraced(skipped)
      await untraced(health)
      await setMode(' bogus ')
      const unknownMode = traceId()
      await call('admin', 'get', `${PROBE}/read`, unknownMode).expect(200)
      await untraced(unknownMode)
    } finally {
      await setMode('write')
    }
  })

  it('trace: monitor reads and the bulletin feed GETs (polls) are never recorded, even in all mode; a cache clear is', async () => {
    try {
      await setMode('all')
      // the decorators alone (the default exclude_paths covers these reads too)
      await setExclude('')
      const reads = [
        '/api/monitor/server',
        '/api/monitor/redis',
        '/api/monitor/mysql',
        '/api/monitor/cache/namespaces',
        '/api/monitor/cache/keys?ns=dict',
        '/api/monitor/cache/value?key=dict:x',
        '/api/messaging/bulletins/feed',
        `/api/messaging/bulletins/feed/${MISSING}`,
      ]
      const traces = reads.map(() => traceId())
      for (const [i, url] of reads.entries()) {
        const res = await call('admin', 'get', url, traces[i])
        expect([url, res.status < 500]).toEqual([url, true])
      }
      const clear = traceId()
      await call('admin', 'delete', '/api/monitor/cache/keys?key=idem:x', clear).expect(200)
      expect(await logOf(ds, clear, 'aud_http_trace')).toMatchObject({ method: 'DELETE' })
      for (const trace of traces) await untraced(trace)
    } finally {
      await setMode('write')
      await setExclude(DEFAULT_HTTP_TRACE_EXCLUDE)
    }
  })

  it('trace: exclude_paths entries are path prefixes, optionally after a method; malformed ones match nothing', () => {
    const entries = `/api/health, GET /api/monitor/\n  post /api/x/  ,bogus, GET /api/a /api/b, `
    expect(traceExcluded(entries, 'GET', '/api/health')).toBe(true)
    expect(traceExcluded(entries, 'GET', '/api/monitor/server')).toBe(true)
    expect(traceExcluded(entries, 'DELETE', '/api/monitor/cache/keys')).toBe(false)
    expect(traceExcluded(entries, 'POST', '/api/x/y')).toBe(true)
    expect(traceExcluded(entries, 'GET', '/api/x/y')).toBe(false)
    for (const path of ['/api/a', '/api/b', 'bogus', '/api/other'])
      expect(traceExcluded(entries, 'GET', path)).toBe(false)
    expect(traceExcluded('', 'GET', '/api/health')).toBe(false)
  })

  it('trace: exclude_paths keeps matching requests out even in all mode; an edit through the settings API applies at once', async () => {
    try {
      await setMode('all')
      await setExclude(`GET ${PROBE}/read, ${PROBE}/secr`)
      const read = traceId()
      await call('admin', 'get', `${PROBE}/read`, read).expect(200)
      const secret = traceId()
      await call('admin', 'post', `${PROBE}/secret`, secret).send({}).expect(201)
      await untraced(read)
      await untraced(secret)
      // no restart: the settings API invalidates the cached value, the next request follows it
      const [param] = await ds.query('SELECT id FROM cfg_param WHERE param_key = ?', [
        HTTP_TRACE_EXCLUDE_PARAM,
      ])
      await call('admin', 'put', `/api/settings/params/${param.id}`)
        .send({ paramValue: `${PROBE}/secr` })
        .expect(200)
      const readAgain = traceId()
      await call('admin', 'get', `${PROBE}/read`, readAgain).expect(200)
      expect(await logOf(ds, readAgain, 'aud_http_trace')).toMatchObject({ method: 'GET' })
      const secretAgain = traceId()
      await call('admin', 'post', `${PROBE}/secret`, secretAgain).send({}).expect(201)
      await untraced(secretAgain)
    } finally {
      await setMode('write')
      await setExclude(DEFAULT_HTTP_TRACE_EXCLUDE)
    }
  })

  it('trace: @Sensitive fields are masked in the query and the body', async () => {
    const trace = traceId()
    await call('admin', 'post', `${PROBE}/secret?paramValue=q&x=1`, trace)
      .send({ paramValue: 'v', other: 'o' })
      .expect(201)
    const row = await logOf(ds, trace, 'aud_http_trace')
    expect(JSON.parse(row.query)).toEqual({ paramValue: '***', x: '1' })
    expect(JSON.parse(row.body)).toEqual({ paramValue: '***', other: 'o' })
  })
})

describe('fault: the API error log', () => {
  it('fault: a 5xx writes an open row (class, message, stack frames, masked request); the response stays generic', async () => {
    const trace = traceId()
    const res = await call('admin', 'post', `${PROBE}/boom?paramValue=q`, trace)
      .set('User-Agent', 'hl-agent')
      .send({ password: 'Secret#1', paramValue: 'v', keep: 'k' })
      .expect(500)
    expect(res.body).toMatchObject({ code: Err.INTERNAL.code, data: null, traceId: trace })
    expect(res.body.msg).not.toContain('kaboom')
    const row = await logOf(ds, trace, 'aud_http_fault')
    expect(row).toMatchObject({
      user_id: adminId,
      username: 'admin',
      method: 'POST',
      url: `${PROBE}/boom`,
      ip: '127.0.0.1',
      user_agent: 'hl-agent',
      error_name: 'ProbeFailure',
      error_message: 'kaboom: probe failure',
      state: 'open',
      handled_by: null,
      handled_at: null,
    })
    // frames only: the message line(s) above them are not repeated
    expect(row.stack).toMatch(/^\s+at /)
    expect(row.stack).not.toContain('kaboom')
    expect(row.stack.length).toBeLessThanOrEqual(8192)
    expect(JSON.parse(row.query)).toEqual({ paramValue: '***' })
    expect(JSON.parse(row.body)).toEqual({ password: '***', paramValue: '***', keep: 'k' })
    // the access log has it too, as a 500
    expect(await logOf(ds, trace, 'aud_http_trace')).toMatchObject({
      status_code: 500,
      biz_code: Err.INTERNAL.code,
    })
    const plain = traceId()
    await call('admin', 'post', `${PROBE}/boom-plain`, plain).expect(500)
    expect(await logOf(ds, plain, 'aud_http_fault')).toMatchObject({
      error_name: 'Error',
      error_message: 'plain kaboom',
    })
  })

  it('fault: the message loses what the request sent as a secret, inline secret pairs, parameter dumps and a driver error’s quoted values', async () => {
    const trace = traceId()
    // the process log line of the same 5xx (the error filter's) is masked the same way
    const spy = vi.spyOn(Logger.prototype, 'error')
    let processLog: unknown[][]
    try {
      await call('admin', 'post', `${PROBE}/boom-secret?token=q-s3cret-token`, trace)
        .send({ password: 'Secret#1', paramValue: 'pv-hidden', keep: 'visible' })
        .expect(500)
    } finally {
      processLog = [...spy.mock.calls]
      spy.mockRestore()
    }
    expect(processLog).toContainEqual([
      {
        fault: {
          type: 'ProbeFailure',
          message: 'failed for *** / *** / visible; apiKey=***, "token":***, parameters: [***]',
          stack: expect.stringMatching(/^\s+at /),
        },
      },
      'request failed',
    ])
    const logged = JSON.stringify(processLog)
    const row = await logOf(ds, trace, 'aud_http_fault')
    expect(row.error_name).toBe('ProbeFailure')
    expect(row.error_message).toBe(
      'failed for *** / *** / visible; apiKey=***, "token":***, parameters: [***]',
    )
    const stored = JSON.stringify(row)
    for (const secret of [
      'Secret#1',
      'pv-hidden',
      'k3y-inline',
      'tok-inline',
      'p-inline',
      'q-s3cret',
    ]) {
      expect(stored).not.toContain(secret)
      expect(logged).not.toContain(secret)
    }

    const driver = traceId()
    await call('admin', 'post', `${PROBE}/boom-driver`, driver).expect(500)
    expect(await logOf(ds, driver, 'aud_http_fault')).toMatchObject({
      error_name: 'Error',
      error_message:
        "ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: Incorrect integer value: '***' for column '***' at row 1",
    })
  })

  it('fault: a 5xx before the route (its @Sensitive fields unknown) keeps no query or body', async () => {
    const trace = traceId()
    await call('admin', 'post', `${PROBE}/guard-boom?paramValue=q`, trace)
      .send({ paramValue: 'v' })
      .expect(500)
    expect(await logOf(ds, trace, 'aud_http_fault')).toMatchObject({
      url: `${PROBE}/guard-boom`,
      error_name: 'ProbeFailure',
      error_message: 'guard kaboom',
      query: null,
      body: null,
    })
  })

  it('fault: errors below 500 (400, 404, 401) write no fault row', async () => {
    const traces = [traceId(), traceId(), traceId()]
    await call('admin', 'put', `${FAULTS}/${MISSING}/state`, traces[0])
      .send({ state: 1 })
      .expect(400)
    await call('admin', 'get', `${FAULTS}/${MISSING}`, traces[1]).expect(404)
    await call(null, 'post', `${PROBE}/boom`, traces[2]).expect(401)
    // a 5xx after them is written: theirs would have been decided first
    const sentinel = traceId()
    await call('admin', 'post', `${PROBE}/boom-plain`, sentinel).expect(500)
    expect(await logOf(ds, sentinel, 'aud_http_fault')).not.toBeNull()
    const rows = await ds.query('SELECT id FROM aud_http_fault WHERE trace_id IN (?)', [traces])
    expect(rows).toEqual([])
  })
})

describe('handle: the error handling state', () => {
  const add = () =>
    insertRow(ds.manager, 'aud_http_fault', {
      trace_id: traceId(),
      method: 'POST',
      url: '/api/e2e',
      error_name: 'Error',
    })

  it('handle: resolved / ignored record the caller and the time, open clears them; action-logged', async () => {
    const id = await add()
    const trace = traceId()
    const before = Date.now()
    const resolved = await call('admin', 'put', `${FAULTS}/${id}/state`, trace)
      .send({ state: 'resolved' })
      .expect(200)
    expect(resolved.body.data).toMatchObject({ id, state: 'resolved', handledBy: adminId })
    expect(new Date(resolved.body.data.handledAt).getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(await logOf(ds, trace, 'aud_action_log')).toMatchObject({
      domain: 'audit.httpFault',
      verb: 'handle',
      biz_id: String(id),
      ok: 1,
    })
    const reopened = await call('admin', 'put', `${FAULTS}/${id}/state`)
      .send({ state: 'open' })
      .expect(200)
    expect(reopened.body.data).toMatchObject({ state: 'open', handledBy: null, handledAt: null })
    await call('admin', 'put', `${FAULTS}/${id}/state`).send({ state: 'ignored' }).expect(200)
    const stored = (await call('admin', 'get', `${FAULTS}/${id}`).expect(200)).body.data
    expect(stored).toMatchObject({ state: 'ignored', handledBy: adminId })
    // the list filters by state
    const ignored = await call('admin', 'get', FAULTS)
      .query({ state: 'ignored', pageSize: 200 })
      .expect(200)
    expect(ignored.body.data.items.map((r: { id: number }) => r.id)).toContain(id)
  })

  it('handle: 403 without the handle permission, 400 on a bad state, 404 on an unknown id: nothing changes', async () => {
    const id = await add()
    const res = await call('viewer', 'put', `${FAULTS}/${id}/state`).send({ state: 'resolved' })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(Err.FORBIDDEN.code)
    // the viewer still reads it
    await call('viewer', 'get', `${FAULTS}/${id}`).expect(200)
    for (const body of [{}, { state: 'done' }, { state: 'OPEN' }])
      await call('admin', 'put', `${FAULTS}/${id}/state`).send(body).expect(400)
    await call('admin', 'put', `${FAULTS}/${MISSING}/state`).send({ state: 'ignored' }).expect(404)
    const [row] = await ds.query('SELECT state, handled_by FROM aud_http_fault WHERE id = ?', [id])
    expect(row).toEqual({ state: 'open', handled_by: null })
  })
})
