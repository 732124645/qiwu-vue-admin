import { Controller, HttpCode, Post, Put, RequestMethod, type Type } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { MetadataScanner, ModulesContainer } from '@nestjs/core'
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { ApiExcludeController } from '@nestjs/swagger'
import { getDataSourceToken } from '@nestjs/typeorm'
import { CAPTCHA_MODE_PARAM, Err, REALTIME_EVENT, RT, type RealtimeMessage } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import ExcelJS from 'exceljs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { SkipActionLog } from '../../src/core/audit/action-log.js'
import { Public } from '../../src/core/auth/decorators.js'
import { AuthParams } from '../../src/core/auth/auth-params.js'
import { TokenService } from '../../src/core/auth/token.service.js'
import { AppConfigService } from '../../src/core/config/config.module.js'
import { DemoModeGuard } from '../../src/core/guard/demo-mode.guard.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { RealtimeService } from '../../src/core/realtime/realtime.service.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { ProfileService } from '../../src/modules/platform/iam/profile/profile.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { closeSockets, connect, socketOf } from '../setup/socket.js'

// Independent contract: deleting an exemption from the guard must fail this suite too.
const EXEMPT = new Set([
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/refresh',
  'POST /api/auth/verify-password',
  'POST /api/auth/captcha/check',
  'PUT /api/iam/profile/locale',
  'PUT /api/iam/profile/prefs/:key',
  'DELETE /api/iam/profile/prefs/:key',
  'POST /api/messaging/bulletins/feed/read-all',
  'POST /api/messaging/bulletins/feed/:id/read',
  'POST /api/messaging/inboxes/mine/read-all',
  'POST /api/messaging/inboxes/mine/:id/read',
  'POST /api/wf/ccs/:id/read',
])
const PW = 'Demo-mode#2026'
const PREFIX = 'demo-mode-e2e-'
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
let fixtureCalls = 0

const binary = (r: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = []
  r.on('data', (chunk: Buffer) => chunks.push(chunk))
  r.on('end', () => cb(null, Buffer.concat(chunks)))
  r.on('error', cb)
}

@Controller('demo-mode-fixture')
@ApiExcludeController()
class DemoFixtureController {
  @Post('new-write')
  @Public()
  @SkipActionLog()
  @HttpCode(200)
  write() {
    return ++fixtureCalls
  }

  @Post('not-auth/login')
  @Public()
  @SkipActionLog()
  suffix() {
    return ++fixtureCalls
  }

  @Put('iam/profile/prefs/:key/extra')
  @Public()
  @SkipActionLog()
  extra() {
    return ++fixtureCalls
  }
}

describe.each(['false', 'true'])('APP_DEMO_MODE=%s', (mode) => {
  let app: NestExpressApplication
  let ds: DataSource
  let redis: Redis
  let userId: number
  let token: string
  let root: string
  const userIds: number[] = []
  const inboxIds: number[] = []
  const bulletinIds: number[] = []
  const ccIds: number[] = []
  let ipSeq = 0
  const nextIp = () => `198.18.21.${++ipSeq}`
  const http = () => request(app.getHttpServer())
  const as = () => bearer(token)
  const param = async (value: string) => {
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
      value,
      CAPTCHA_MODE_PARAM,
    ])
    await app.get(ParamService).invalidate(CAPTCHA_MODE_PARAM)
  }
  const user = async (name: string, changed: Date | null = new Date()) => {
    const id = await insertRow(ds.manager, 'iam_user', {
      username: PREFIX + name,
      display_name: name,
      password_hash: await bcrypt.hash(PW, 4),
      password_changed_at: changed,
    })
    userIds.push(id)
    return id
  }
  const inbox = async (owner: number) => {
    const id = await insertRow(ds.manager, 'msg_inbox', {
      user_id: owner,
      template_code: 'test.demoMode',
      locale: 'en-US',
      category: 'system',
      title: 'Demo mode test',
      body: 'Test message',
      status: 'delivered',
    })
    inboxIds.push(id)
    return id
  }

  beforeAll(async () => {
    vi.stubEnv('APP_DEMO_MODE', mode)
    const mod = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [DemoFixtureController],
    })
      // AppModule's ConfigModule.forRoot is evaluated at import time; each app gets freshly parsed env.
      .overrideProvider(ConfigService)
      .useValue(new ConfigService(EnvSchema.parse(process.env)))
      .compile()
    app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
    await app.listen(0, '127.0.0.1')
    ds = app.get<DataSource>(getDataSourceToken())
    redis = app.get(REDIS)
    await cleanRedis(redis)
    await param('off')
    userId = await user(mode)
    token = (await signIn(app, PREFIX + mode)).accessToken
    root = (await signIn(app)).accessToken
    fixtureCalls = 0
  })

  afterAll(async () => {
    closeSockets()
    if (ds) {
      await param('off')
      if (inboxIds.length) await ds.query('DELETE FROM msg_inbox WHERE id IN (?)', [inboxIds])
      if (bulletinIds.length) {
        await ds.query('DELETE FROM msg_bulletin_receipt WHERE bulletin_id IN (?)', [bulletinIds])
        await ds.query('DELETE FROM msg_bulletin WHERE id IN (?)', [bulletinIds])
      }
      if (ccIds.length) await ds.query('DELETE FROM wf_cc WHERE id IN (?)', [ccIds])
      if (userIds.length) {
        await ds.query('DELETE FROM iam_user_pref WHERE user_id IN (?)', [userIds])
        await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
      }
      await ds.query('DELETE FROM aud_signin_log WHERE username LIKE ?', [`${PREFIX}%`])
      await ds.query('DELETE FROM aud_action_log WHERE domain LIKE ?', [`${PREFIX}%`])
      await ds.query('DELETE FROM aud_action_log WHERE username LIKE ?', [`${PREFIX}%`])
      await ds.query('DELETE FROM aud_http_trace WHERE username LIKE ?', [`${PREFIX}%`])
      await ds.query('DELETE FROM aud_http_fault WHERE username LIKE ?', [`${PREFIX}%`])
    }
    if (redis) await cleanRedis(redis)
    await app?.close()
    vi.unstubAllEnvs()
  })

  it('uses the parsed flag; the same real write either updates the DB or stops before the handler', async () => {
    expect(app.get(AppConfigService).get('APP_DEMO_MODE')).toBe(mode === 'true')
    const handler = vi.spyOn(app.get(ProfileService), 'update')
    const res = await http()
      .put('/api/iam/profile')
      .set(as())
      .set('Accept-Language', 'en-US')
      .send({ displayName: 'Changed' })
    const [row] = await ds.query<{ display_name: string }[]>(
      'SELECT display_name FROM iam_user WHERE id = ?',
      [userId],
    )
    if (mode === 'false') {
      expect(res.status).toBe(200)
      expect(row!.display_name).toBe('Changed')
      expect(handler).toHaveBeenCalledOnce()
    } else {
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({
        code: 'A0431',
        msg: 'This action is unavailable in demo mode.',
      })
      expect(res.body.traceId).toEqual(expect.any(String))
      expect(row!.display_name).toBe('true')
      expect(handler).not.toHaveBeenCalled()
    }
    handler.mockRestore()
  })

  it('new public writes default to denied before authentication, validation or the handler', async () => {
    const res = await http().post('/api/demo-mode-fixture/new-write')
    expect(res.status).toBe(mode === 'true' ? 403 : 200)
    expect(fixtureCalls).toBe(mode === 'true' ? 0 : 1)
    if (mode === 'true') {
      expect(res.body.code).toBe(Err.DEMO_READ_ONLY.code)
      expect((await http().post('/api/auth/signup').send({}).expect(403)).body.code).toBe('A0431')
      expect((await http().put('/api/iam/profile').send({}).expect(403)).body.code).toBe('A0431')
      expect(
        (await http().put('/api/iam/profile').set(bearer(root)).send({}).expect(403)).body.code,
      ).toBe('A0431')
    }
  })

  if (mode === 'false') return

  it('enumerates every registered controller method, including hidden/new routes; only the 13 exact writes pass', () => {
    const guard = new DemoModeGuard(app.get(AppConfigService))
    const scanner = new MetadataScanner()
    const found = new Set<string>()
    let writes = 0
    const paths = (value: string | string[]) => (Array.isArray(value) ? value : [value])
    for (const mod of app.get(ModulesContainer).values()) {
      for (const wrapper of mod.controllers.values()) {
        const controller = wrapper.metatype
        if (!controller) continue
        const proto = controller.prototype
        for (const name of scanner.getAllMethodNames(proto)) {
          const handler = proto[name]
          const method: RequestMethod | undefined = Reflect.getMetadata(METHOD_METADATA, handler)
          if (method === undefined) continue
          const methods =
            method === RequestMethod.ALL
              ? ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'SEARCH']
              : [RequestMethod[method]]
          for (const prefix of paths(Reflect.getMetadata(PATH_METADATA, controller) ?? '')) {
            for (const suffix of paths(Reflect.getMetadata(PATH_METADATA, handler) ?? '')) {
              const path =
                '/' +
                ['api', prefix, suffix]
                  .map((p) => p.replace(/^\/+|\/+$/g, ''))
                  .filter(Boolean)
                  .join('/')
              for (const verb of methods) {
                const key = `${verb} ${path}`
                const ctx = new ExecutionContextHost(
                  [{ method: verb, route: { path } }],
                  controller as Type,
                  handler,
                )
                found.add(key)
                if (verb === 'GET' || verb === 'HEAD' || EXEMPT.has(key)) {
                  expect(guard.canActivate(ctx)).toBe(true)
                } else {
                  writes++
                  expect(() => guard.canActivate(ctx)).toThrowError(BizError)
                  try {
                    guard.canActivate(ctx)
                  } catch (error) {
                    expect((error as BizError).err).toBe(Err.DEMO_READ_ONLY)
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(found.size).toBeGreaterThan(0)
    expect(writes).toBeGreaterThan(0)
    expect(EXEMPT.size).toBe(13)
    for (const key of EXEMPT) expect(found.has(key)).toBe(true)
    expect(found.has('POST /api/demo-mode-fixture/new-write')).toBe(true)
    process.stdout.write(
      `demo-mode inventory: ${found.size} method/routes, ${writes} denied writes, ${EXEMPT.size} exemptions\n`,
    )
  })

  it('rejects suffix/prefix/header tricks and missing route metadata; non-HTTP contexts pass', async () => {
    for (const [verb, path] of [
      ['post', '/api/demo-mode-fixture/not-auth/login'],
      ['put', '/api/demo-mode-fixture/iam/profile/prefs/table.iam.user/extra'],
    ] as const) {
      expect(
        (await http()[verb](path).set('X-Original-URL', '/api/auth/login').expect(403)).body.code,
      ).toBe('A0431')
    }
    const guard = new DemoModeGuard(app.get(AppConfigService))
    for (const path of [
      '/api/auth/login/extra',
      '/api/iam/profile/prefs/:key/extra',
      '/not-auth/login',
      undefined,
    ]) {
      const ctx = new ExecutionContextHost([
        { method: 'POST', route: { path }, originalUrl: '/api/auth/login' },
      ])
      expect(() => guard.canActivate(ctx)).toThrowError(BizError)
    }
    const ctx = new ExecutionContextHost([])
    ctx.setType('ws')
    expect(guard.canActivate(ctx)).toBe(true)
    expect(fixtureCalls).toBe(0)
  })

  it('GET and HEAD retain authentication/permissions; public mobile version checks stay available', async () => {
    await http().get('/api/iam/profile').expect(401)
    await http().head('/api/iam/profile').expect(401)
    await http().get('/api/iam/profile').set(as()).expect(200)
    await http().head('/api/iam/profile').set(as()).expect(200)
    await http().get('/api/iam/users').set(as()).expect(403)
    await http().head('/api/iam/users').set(as()).expect(403)
    const query = { platform: 'android', version: 1, nativeVersion: 1 }
    await http().get('/api/settings/app-versions/latest').query(query).expect(200)
    await http().head('/api/settings/app-versions/latest').query(query).expect(200)
  })

  it('login, verify-password, refresh and logout work, with password/Origin/cookie checks intact', async () => {
    const login = await http()
      .post('/api/auth/login')
      .set('X-Forwarded-For', nextIp())
      .send({ username: PREFIX + mode, password: PW })
      .expect(200)
    const access = login.body.data.accessToken as string
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!
    await http().post('/api/auth/verify-password').expect(401)
    await http().post('/api/auth/logout').expect(401)
    expect(
      (
        await http()
          .post('/api/auth/verify-password')
          .set(bearer(access))
          .send({ password: 'Wrong#2026' })
          .expect(400)
      ).body.code,
    ).toBe(Err.AUTH_PASSWORD_WRONG.code)
    await http()
      .post('/api/auth/verify-password')
      .set(bearer(access))
      .send({ password: PW })
      .expect(200)
    const refresh = () =>
      http().post('/api/auth/refresh').set('Host', 'localhost').set('X-Forwarded-For', nextIp())
    expect(
      (await refresh().set('Cookie', cookie).set('Origin', 'https://evil.test').expect(403)).body
        .code,
    ).toBe(Err.AUTH_ORIGIN_REJECTED.code)
    await refresh().set('Origin', 'http://localhost').expect(401)
    const rotated = await refresh()
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost')
      .expect(200)
    const logout = await http()
      .post('/api/auth/logout')
      .set(bearer(rotated.body.data.accessToken))
      .expect(200)
    expect(logout.headers['set-cookie']).toBeDefined()
    await http().get('/api/auth/me').set(bearer(rotated.body.data.accessToken)).expect(401)
  })

  it('demo password-attempt exhaustion counts and ends only the caller session', async () => {
    const name = `shared-${mode}`
    const id = await user(name)
    const caller = await signIn(app, PREFIX + name)
    const visitor = await signIn(app, PREFIX + name)
    const { lockThreshold } = (await app.get(AuthParams).load()).security
    const verify = (access: string, password: string) =>
      http()
        .post('/api/auth/verify-password')
        .set(bearer(access))
        .set('X-Forwarded-For', nextIp())
        .send({ password })
    for (let n = 1; n < lockThreshold; n++) {
      expect((await verify(caller.accessToken, 'Wrong#2026').expect(400)).body.code).toBe(
        Err.AUTH_PASSWORD_WRONG.code,
      )
      await http().get('/api/auth/me').set(bearer(visitor.accessToken)).expect(200)
    }
    expect((await verify(caller.accessToken, 'Wrong#2026').expect(401)).body.code).toBe(
      Err.AUTH_SESSION_EXPIRED.code,
    )
    const tokens = app.get(TokenService)
    expect(await tokens.load(caller.session.sid)).toBeNull()
    await http().get('/api/auth/me').set(bearer(caller.accessToken)).expect(401)
    await verify(caller.accessToken, 'Wrong#2026').expect(401)
    await http().get('/api/auth/me').set(bearer(visitor.accessToken)).expect(200)
    expect(await tokens.load(visitor.session.sid)).not.toBeNull()
    const callerKey = redisKey('authFail', 'cur', id, caller.session.sid)
    const visitorKey = redisKey('authFail', 'cur', id, visitor.session.sid)
    expect(Number(await redis.get(callerKey))).toBe(lockThreshold)
    expect(await redis.get(redisKey('authFail', 'cur', id))).toBeNull()
    await verify(visitor.accessToken, 'Wrong#2026').expect(400)
    expect(Number(await redis.get(visitorKey))).toBe(1)
    await verify(visitor.accessToken, PW).expect(200)
    expect(await redis.get(visitorKey)).toBeNull()
    expect(Number(await redis.get(callerKey))).toBe(lockThreshold)
    expect(Number(await redis.get(redisKey('authFail', 'vp', 'u', id)))).toBe(lockThreshold + 2)
    await http()
      .post('/api/auth/refresh')
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost')
      .set('Cookie', `qw_rt=${visitor.refreshToken}`)
      .expect(200)
    await vi.waitFor(async () => {
      const rows = await ds.query(
        'SELECT kind, ok, msg_key FROM aud_signin_log WHERE user_id = ?',
        [id],
      )
      expect(rows).toEqual([
        expect.objectContaining({
          kind: 'locked',
          ok: 0,
          msg_key: 'signin.password_check_exceeded',
        }),
      ])
    })
  })

  it('demo masks network fields in all audit lists/details/exports and sessions, with storage intact', async () => {
    const username = PREFIX + mode
    const domain = `${PREFIX}network-${mode}`
    const location = 'Visitor City'
    const entries = [
      { ip: '203.0.113.187', masked: '203.0.*.*' },
      { ip: '2001:db8:1234:abcd::9876', masked: '2001:db8::*' },
    ]
    const signinIds: number[] = []
    const actionIds: number[] = []
    const traceIds: number[] = []
    const faultIds: number[] = []
    const sids: string[] = []
    for (const { ip } of entries) {
      sids.push((await signIn(app, username, { ip, ua: CHROME })).session.sid)
      signinIds.push(
        await insertRow(ds.manager, 'aud_signin_log', {
          kind: 'password',
          user_id: userId,
          username,
          client_id: 'console',
          ip,
          location,
          browser: 'Chrome 131.0.0.0',
          os: 'macOS 10.15.7',
          ok: 1,
        }),
      )
      actionIds.push(
        await insertRow(ds.manager, 'aud_action_log', {
          domain,
          verb: 'modify',
          user_id: userId,
          username,
          http_method: 'PUT',
          url: '/api/iam/profile/locale',
          ip,
          location,
          user_agent: CHROME,
          ok: 1,
          cost_ms: 1,
        }),
      )
      traceIds.push(
        await insertRow(ds.manager, 'aud_http_trace', {
          username,
          method: 'POST',
          url: '/api/auth/login',
          status_code: 200,
          biz_code: '0',
          started_at: new Date(),
          cost_ms: 1,
          ip,
          user_agent: CHROME,
        }),
      )
      faultIds.push(
        await insertRow(ds.manager, 'aud_http_fault', {
          username,
          method: 'GET',
          url: '/api/demo/fault',
          error_name: 'Error',
          ip,
          user_agent: CHROME,
        }),
      )
    }
    const get = (path: string, query: object = {}) =>
      http().get(path).set(bearer(root)).query(query).expect(200)
    const signin = '/api/audit/signin-logs'
    const action = '/api/audit/action-logs'
    const trace = '/api/audit/http-traces'
    const fault = '/api/audit/http-faults'
    const signinRows = (await get(signin, { username, pageSize: 200 })).body.data.items
    const actionRows = (await get(action, { domain })).body.data.items
    const traceRows = (await get(trace, { username, pageSize: 200 })).body.data.items
    const faultRows = (await get(fault, { username, pageSize: 200 })).body.data.items
    const sessions = (await get('/api/iam/sessions', { username, pageSize: 200 })).body.data.items
    for (const [n, { masked }] of entries.entries()) {
      const network = { ip: masked }
      const signinDetail = (await get(`${signin}/${signinIds[n]}`)).body.data
      const actionDetail = (await get(`${action}/${actionIds[n]}`)).body.data
      for (const row of [
        signinRows.find((r: { id: number }) => r.id === signinIds[n]),
        signinDetail,
      ])
        expect(row).toMatchObject({
          ...network,
          location: '*',
          browser: 'Chrome',
          os: '*',
        })
      for (const row of [
        actionRows.find((r: { id: number }) => r.id === actionIds[n]),
        actionDetail,
      ])
        expect(row).toMatchObject({
          ...network,
          location: '*',
          userAgent: 'Chrome',
        })
      for (const [path, ids, rows] of [
        [trace, traceIds, traceRows],
        [fault, faultIds, faultRows],
      ] as const) {
        const detail = (await get(`${path}/${ids[n]}`)).body.data
        for (const row of [rows.find((r: { id: number }) => r.id === ids[n]), detail])
          expect(row).toMatchObject({ ...network, userAgent: 'Chrome' })
      }
      expect(sessions.find((r: { sid: string }) => r.sid === sids[n])).toMatchObject({
        ...network,
        userAgent: 'Chrome',
        browser: 'Chrome',
        os: '*',
        location: '*',
        current: false,
      })
    }
    for (const [path, query] of [
      [signin, { username }],
      [action, { domain }],
      [trace, { username }],
      [fault, { username }],
    ] as const) {
      const res = await http()
        .get(`${path}/export`)
        .set(bearer(root))
        .query(query)
        .buffer(true)
        .parse(binary)
        .expect(200)
      expect(res.headers['content-type']).toContain('spreadsheetml.sheet')
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(res.body as Parameters<typeof workbook.xlsx.load>[0])
      const cells: unknown[] = []
      workbook.worksheets[0]!.eachRow((row) => row.eachCell((cell) => cells.push(cell.value)))
      for (const { ip, masked } of entries) {
        expect(cells).toContain(masked)
        expect(JSON.stringify(cells)).not.toContain(ip)
      }
      for (const raw of [CHROME, location, 'Chrome 131.0.0.0', 'macOS 10.15.7'])
        expect(JSON.stringify(cells)).not.toContain(raw)
    }
    const storedSignin = await ds.query(
      'SELECT ip, location, browser, os FROM aud_signin_log WHERE id IN (?) ORDER BY id',
      [signinIds],
    )
    const storedAction = await ds.query(
      'SELECT ip, location, user_agent FROM aud_action_log WHERE id IN (?) ORDER BY id',
      [actionIds],
    )
    const storedTrace = await ds.query(
      'SELECT ip, user_agent FROM aud_http_trace WHERE id IN (?) ORDER BY id',
      [traceIds],
    )
    const storedFault = await ds.query(
      'SELECT ip, user_agent FROM aud_http_fault WHERE id IN (?) ORDER BY id',
      [faultIds],
    )
    for (const [n, { ip }] of entries.entries()) {
      expect(storedSignin[n]).toMatchObject({
        ip,
        location,
        browser: 'Chrome 131.0.0.0',
        os: 'macOS 10.15.7',
      })
      expect(storedAction[n]).toMatchObject({ ip, location, user_agent: CHROME })
      expect(storedTrace[n]).toMatchObject({ ip, user_agent: CHROME })
      expect(storedFault[n]).toMatchObject({ ip, user_agent: CHROME })
      expect(await app.get(TokenService).load(sids[n]!)).toMatchObject({ ip, ua: CHROME })
    }
  })

  it('demo ignores full-IP filters for every audit list/export and the session list', async () => {
    const name = 'ip-filter'
    await user(name)
    const username = PREFIX + name
    const paths = ['signin-logs', 'action-logs', 'http-traces', 'http-faults']
    for (const ip of ['203.0.113.187', '2001:db8:1234:abcd::9876']) {
      await signIn(app, username, { ip })
      for (const [table, fields] of [
        ['aud_signin_log', { kind: 'password', client_id: 'console', ok: 1 }],
        [
          'aud_action_log',
          {
            domain: PREFIX + name,
            verb: 'modify',
            http_method: 'PUT',
            url: '/api/iam/profile/locale',
            ok: 1,
            cost_ms: 1,
          },
        ],
        [
          'aud_http_trace',
          {
            method: 'GET',
            url: '/api/health',
            status_code: 200,
            biz_code: '0',
            started_at: new Date(),
            cost_ms: 1,
          },
        ],
        ['aud_http_fault', { method: 'GET', url: '/api/demo/fault', error_name: 'Error' }],
      ] as const)
        await insertRow(ds.manager, table, { username, ip, ...fields })
    }
    for (const path of [...paths.map((p) => `/api/audit/${p}`), '/api/iam/sessions']) {
      const query = { username, pageSize: 200 }
      const list = async (ip?: string) =>
        (
          await http()
            .get(path)
            .set(bearer(root))
            .query({ ...query, ...(ip ? { ip } : {}) })
            .expect(200)
        ).body.data
      const baseline = await list()
      expect(baseline.total).toBe(2)
      for (const ip of ['203.0.113.187', '2001:db8:1234:abcd::9876', '192.0.2.99'])
        expect(await list(ip)).toEqual(baseline)
      if (path === '/api/iam/sessions') continue
      const exported = async (ip?: string) => {
        const res = await http()
          .get(`${path}/export`)
          .set(bearer(root))
          .query({ ...query, ...(ip ? { ip } : {}) })
          .buffer(true)
          .parse(binary)
          .expect(200)
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(res.body as Parameters<typeof workbook.xlsx.load>[0])
        const cells: unknown[] = []
        workbook.worksheets[0]!.eachRow((row) => row.eachCell((cell) => cells.push(cell.value)))
        return cells
      }
      const baselineExport = await exported()
      for (const ip of ['203.0.113.187', '2001:db8:1234:abcd::9876', '192.0.2.99'])
        expect(await exported(ip)).toEqual(baselineExport)
    }
  })

  it('captcha check still consumes both correct and wrong answers exactly once', async () => {
    await param('image')
    try {
      for (const correct of [true, false]) {
        const ip = nextIp()
        const challenge = await http()
          .get('/api/auth/captcha')
          .query({ scene: 'signin' })
          .set('X-Forwarded-For', ip)
          .expect(200)
        const id = challenge.body.data.id as string
        const stored = JSON.parse((await redis.get(redisKey('captcha', id)))!) as { answer: string }
        const check = (answer: string) =>
          http().post('/api/auth/captcha/check').set('X-Forwarded-For', ip).send({ id, answer })
        const res = await check(correct ? stored.answer : 'WRONG').expect(correct ? 200 : 400)
        if (correct) expect(res.body.data.captchaTicket).toEqual(expect.any(String))
        else expect(res.body.code).toBe(Err.AUTH_CAPTCHA_INVALID.code)
        expect(await redis.get(redisKey('captcha', id))).toBeNull()
        expect((await check(stored.answer).expect(400)).body.code).toBe(
          Err.AUTH_CAPTCHA_INVALID.code,
        )
      }
    } finally {
      await param('off')
    }
  })

  it('locale and prefs save/delete only the caller, with authentication and key validation intact', async () => {
    const base = '/api/iam/profile'
    await http().put(`${base}/locale`).send({ locale: 'en-US' }).expect(401)
    await http().put(`${base}/prefs/table.iam.user`).send({ value: {} }).expect(401)
    await http().delete(`${base}/prefs/table.iam.user`).expect(401)
    await http().put(`${base}/locale`).set(as()).send({ locale: 'en-US' }).expect(200)
    expect((await http().get(base).set(as()).expect(200)).body.data.locale).toBe('en-US')
    await http()
      .put(`${base}/prefs/table.iam.user`)
      .set(as())
      .send({ value: { v: 1, columns: [{ prop: 'email', visible: false }] } })
      .expect(200)
    expect(
      (await http().get(`${base}/prefs/table.iam.user`).set(as()).expect(200)).body.data.value,
    ).toEqual({ v: 1, columns: [{ prop: 'email', visible: false }] })
    await http().put(`${base}/prefs/invalid!`).set(as()).send({ value: {} }).expect(400)
    await http().delete(`${base}/prefs/invalid!`).set(as()).expect(400)
    await http().delete(`${base}/prefs/table.iam.user`).set(as()).expect(200)
    expect(
      (await http().get(`${base}/prefs/table.iam.user`).set(as()).expect(200)).body.data.value,
    ).toBeNull()
  })

  it('bulletin read/read-all, inbox read/read-all and cc read reach real owned rows; strangers still get 404', async () => {
    for (let n = 0; n < 2; n++)
      bulletinIds.push(
        await insertRow(ds.manager, 'msg_bulletin', {
          title: `Demo ${n}`,
          kind: 'notice',
          body: '<p>Test</p>',
          published: 1,
          published_at: new Date(),
        }),
      )
    const read = `/api/messaging/bulletins/feed/${bulletinIds[0]}/read`
    await http().post(read).expect(401)
    await http().post('/api/messaging/bulletins/feed/read-all').expect(401)
    await http().post(read).set(as()).expect(200)
    await http().post('/api/messaging/bulletins/feed/read-all').set(as()).expect(200)
    const receipts = await ds.query(
      'SELECT bulletin_id FROM msg_bulletin_receipt WHERE user_id = ? AND bulletin_id IN (?)',
      [userId, bulletinIds],
    )
    expect(receipts).toHaveLength(2)
    const first = await inbox(userId)
    const second = await inbox(userId)
    const other = await inbox(await user('other'))
    const mine = '/api/messaging/inboxes/mine'
    await http().post(`${mine}/${first}/read`).expect(401)
    await http().post(`${mine}/read-all`).expect(401)
    await http().post(`${mine}/${other}/read`).set(as()).expect(404)
    await http().get(`${mine}/${other}`).set(as()).expect(404)
    await http().post(`${mine}/${first}/read`).set(as()).expect(200)
    await http().post(`${mine}/read-all`).set(as()).expect(200)
    const rows = await ds.query<{ id: number; read_at: Date | null }[]>(
      'SELECT id, read_at FROM msg_inbox WHERE id IN (?) ORDER BY id',
      [[first, second, other]],
    )
    expect(rows.map((r) => r.read_at instanceof Date)).toEqual([true, true, false])
    // No FK on wf_cc: the read endpoint needs only this owned receipt, not a process start.
    for (const owner of [userId, userIds.at(-1)!])
      ccIds.push(
        await insertRow(ds.manager, 'wf_cc', {
          instance_id: 999999,
          node_id: 'test',
          user_id: owner,
        }),
      )
    await http().post(`/api/wf/ccs/${ccIds[0]}/read`).expect(401)
    await http().post(`/api/wf/ccs/${ccIds[1]}/read`).set(as()).expect(404)
    await http().post(`/api/wf/ccs/${ccIds[0]}/read`).set(as()).expect(200)
    const ccs = await ds.query<{ read_at: Date | null }[]>(
      'SELECT read_at FROM wf_cc WHERE id IN (?) ORDER BY id',
      [ccIds],
    )
    expect(ccs.map((r) => r.read_at instanceof Date)).toEqual([true, false])
  })

  it('ordinary accounts still require a password change; demo does not clear session flags', async () => {
    await user('fresh', null)
    const fresh = (
      await http()
        .post('/api/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({ username: PREFIX + 'fresh', password: PW })
        .expect(200)
    ).body.data.accessToken as string
    expect(
      (await http().get('/api/auth/me').set(bearer(fresh)).expect(200)).body.data.flags
        .mustChangePassword,
    ).toBe(true)
    expect(
      (
        await http()
          .post('/api/auth/verify-password')
          .set(bearer(fresh))
          .send({ password: PW })
          .expect(403)
      ).body.code,
    ).toBe(Err.AUTH_PASSWORD_CHANGE_REQUIRED.code)
    expect(
      (
        await http()
          .put('/api/iam/profile/password')
          .set(bearer(fresh))
          .send({ oldPassword: PW, newPassword: 'New-demo#2026' })
          .expect(403)
      ).body.code,
    ).toBe('A0431')
  })

  it('OAuth, profile/password/avatar, SMS, signup, receipt, codegen and scheduler writes remain blocked for root', async () => {
    for (const path of [
      '/api/oauth2/authorize',
      '/api/oauth2/token',
      '/api/oauth2/introspect',
      '/api/oauth2/revoke',
      '/api/demo/realtime/send',
      '/api/auth/signup',
      '/api/auth/sms/code',
      '/api/auth/sms/login',
      '/api/auth/password/reset-by-sms',
      '/api/auth/wx-mp/login',
      '/api/auth/wx-mp/bind',
      '/api/iam/profile/avatar',
      '/api/messaging/sms/receipt/test',
      '/api/codegen/tables/write',
      '/api/scheduler/tasks/999999/run',
    ])
      expect((await http().post(path).set(bearer(root)).send({}).expect(403)).body.code).toBe(
        'A0431',
      )
  })

  it('an exempt write still enforces its original rate limit', async () => {
    const save = () =>
      http()
        .put('/api/iam/profile/locale')
        .set(as())
        .set('X-Forwarded-For', '198.18.99.1')
        .send({ locale: 'en-US' })
    for (let n = 0; n < 30; n++) await save().expect(200)
    expect((await save().expect(429)).body.code).toBe(Err.TOO_MANY_REQUESTS.code)
  })

  it('demo allows authenticated socket handshakes and server pushes', async () => {
    const socket = await connect(socketOf(app, { token }))
    const msg: RealtimeMessage = {
      type: RT.demoMessage,
      payload: {
        from: { id: userId, name: 'Test' },
        text: 'Server push in demo mode',
        at: new Date().toISOString(),
      },
    }
    const received = new Promise<RealtimeMessage>((resolve) => socket.once(REALTIME_EVENT, resolve))
    app.get(RealtimeService).toUser(userId, msg)
    expect(await received).toEqual(msg)
    socket.close()
  })
})
