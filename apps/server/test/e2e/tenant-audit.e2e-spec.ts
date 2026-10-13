// Audit with tenants (see docs/design-notes.md#tenancy), the switch on, between the default tenant (A)
// and tenant B. The action and sign-in logs stay in their tenant: lists and exports leave the other
// tenant's rows out, its ids are 404 like unknown ones and nothing of it changes, a clean empties the
// caller's tenant only, an unlock drops only its own tenant's failure counters, and the same entries
// live in both. A sign-in attempt naming an unknown tenant code belongs to no tenant (`tenant_id` NULL):
// no tenant's log shows it, only the platform root's `unresolved` filter does. The API logs record the
// signed-in caller's data tenant (anonymous requests none) and the platform root filters by it; they
// stay platform pages (403 to another tenant).
import { Body, Controller, Post, Req } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { ApiExcludeController } from '@nestjs/swagger'
import { getDataSourceToken } from '@nestjs/typeorm'
import { actionLogPerms, DEFAULT_TENANT_ID as A, Err, signinLogPerms } from '@qiwu/shared'
import ExcelJS from 'exceljs'
import type { Request } from 'express'
import { ClsService } from 'nestjs-cls'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { SkipActionLog } from '../../src/core/audit/action-log.js'
import { Public } from '../../src/core/auth/decorators.js'
import { LoginTenantResolver } from '../../src/core/auth/login-tenant.js'
import type { Principal } from '../../src/core/auth/principal.js'
import { clsSet } from '../../src/core/context/cls.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId } from '../../src/db/seeds/upsert.js'
import { SigninLogService } from '../../src/modules/platform/audit/signin-log/signin-log.service.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import {
  addRow,
  addUser,
  bootApp,
  createTenant,
  type PeopledTenant,
  signInDirect,
} from '../setup/tenants.js'

const PREFIX = 'ta-e2e-'
const MISSING = 999_999_999
const UNKNOWN_CODE = 'zz-no-such-tenant'
const LOG_TABLES = ['aud_action_log', 'aud_signin_log', 'aud_http_trace', 'aud_http_fault'] as const

/**
 * Spec-only routes failing with a 5xx: a signed-in one, a public one, and a public one that has resolved
 * its sign-in tenant first (as the sign-in routes do).
 */
@Controller('tenant-audit-fixture')
@ApiExcludeController()
class FaultFixture {
  constructor(private readonly tenants: LoginTenantResolver) {}

  @Post('boom')
  @SkipActionLog()
  boom(): never {
    throw new Error('tenant audit probe')
  }

  @Post('public-boom')
  @Public()
  @SkipActionLog()
  publicBoom(): never {
    throw new Error('tenant audit probe')
  }

  @Post('resolved-boom')
  @Public()
  @SkipActionLog()
  async resolvedBoom(@Req() req: Request, @Body() body: { tenantCode: string }): Promise<never> {
    await this.tenants.resolveLoginTenant(req, body.tenantCode)
    throw new Error('tenant audit probe')
  }
}

let on: NestExpressApplication
let ds: DataSource
let redis: Redis
let B: PeopledTenant
const tokens = { root: '', aAuditor: '', bOwner: '' }
type Who = keyof typeof tokens
/** each log table's last id before this spec: every row above it is this spec's (cleanup) */
const lastIds: Record<string, number> = {}
const aUsers: number[] = []
let aRole = 0

let seq = 0
const unique = () => `${PREFIX}${++seq}`
const trace = () => `${PREFIX}${process.pid}-${++seq}`
let ipSeq = 0
const nextIp = () => `198.18.77.${(++ipSeq % 250) + 1}`

const http = () => request(on.getHttpServer())
const call = (who: Who, method: 'get' | 'post' | 'put' | 'delete', path: string, body?: object) => {
  const req = http()[method](`/api${path}`).set(bearer(tokens[who]))
  return body ? req.send(body) : req
}
const expect404 = (res: request.Response) => {
  expect(res.status).toBe(404)
  expect(res.body.code).toBe(Err.NOT_FOUND.code)
}
const expect403 = (res: request.Response) => {
  expect(res.status).toBe(403)
  expect(res.body.code).toBe(Err.FORBIDDEN.code)
}
const idsOf = (res: request.Response): number[] =>
  res.body.data.items.map((r: { id: number }) => Number(r.id))

/** GET `<path>/export` as the first sheet's data rows (the header row aside). */
async function exported(who: Who, path: string, query: object): Promise<unknown[][]> {
  const res = await call(who, 'get', `${path}/export`)
    .query(query)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = []
      r.on('data', (c: Buffer) => chunks.push(c))
      r.on('end', () => cb(null, Buffer.concat(chunks)))
    })
    .expect(200)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(res.body as Parameters<typeof wb.xlsx.load>[0])
  const ws = wb.worksheets[0]!
  return Array.from({ length: ws.actualRowCount - 1 }, (_, i) =>
    (ws.getRow(i + 2).values as unknown[]).slice(1),
  )
}

/** Whether the row is live (raw SQL: no tenant condition). */
const live = async (table: string, id: number) =>
  // arch-allow: sql-concat table names are this spec's constants
  (await ds.query(`SELECT 1 FROM ${table} WHERE id = ? AND deleted_at IS NULL`, [id])).length === 1

/** POST /api/auth/login with a wrong password from a fresh IP. */
const failLogin = (username: string, tenantCode?: string, traceId?: string) => {
  const req = http().post('/api/auth/login').set('X-Forwarded-For', nextIp())
  return (traceId ? req.set('X-Request-Id', traceId) : req).send({
    username,
    password: 'Wrong#2026-pass',
    ...(tenantCode ? { tenantCode } : {}),
  })
}

beforeAll(async () => {
  on = await bootApp({ multiTenant: true, controllers: [FaultFixture] })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  await cleanRedis(redis)
  for (const table of LOG_TABLES)
    lastIds[table] = Number(
      // arch-allow: sql-concat table names are this spec's constants
      (await ds.query(`SELECT COALESCE(MAX(id), 0) AS n FROM ${table}`))[0].n,
    )
  B = await createTenant(on, { users: true })
  // a plain auditor of the default tenant: both logs, every perm, no root
  aRole = await addRow(on, A, 'iam_role', {
    code: `${PREFIX}auditor`,
    name: `${PREFIX}auditor`,
    data_scope: 'all',
  })
  for (const perm of [...Object.values(actionLogPerms), ...Object.values(signinLogPerms)])
    await addRow(on, A, 'iam_role_menus', {
      role_id: aRole,
      menu_id: await findId(ds.manager, 'iam_menu', { perms: perm }),
    })
  aUsers.push(await addUser(on, A, `${PREFIX}auditor`, { roleId: aRole }))
  tokens.root = (await signIn(on)).accessToken
  tokens.aAuditor = (await signInDirect(on, aUsers[0]!))!.accessToken
  tokens.bOwner = (await signInDirect(on, B.ownerId))!.accessToken
})

afterAll(async () => {
  if (ds) {
    await B?.dispose()
    for (const table of LOG_TABLES)
      if (lastIds[table] !== undefined)
        // arch-allow: sql-concat table names are this spec's constants
        await ds.query(`DELETE FROM ${table} WHERE id > ?`, [lastIds[table]])
    if (aUsers.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [aUsers])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [aUsers])
    }
    if (aRole) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [aRole])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [aRole])
    }
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
})

interface LogPage {
  name: string
  path: string
  table: string
  /** the list filter holding the tag */
  filter: string
  /** a row of `tid`'s log made of `tag` (its operator in that tenant too) */
  row: (tag: string, tid: number) => Record<string, unknown>
}
const LOGS: LogPage[] = [
  {
    name: 'action log',
    path: '/audit/action-logs',
    table: 'aud_action_log',
    filter: 'domain',
    row: (tag, tid) => ({
      domain: tag,
      verb: 'modify',
      http_method: 'PUT',
      url: `/api/${tag}`,
      ok: 1,
      cost_ms: 1,
      actor_tenant_id: tid,
    }),
  },
  {
    name: 'sign-in log',
    path: '/audit/signin-logs',
    table: 'aud_signin_log',
    filter: 'username',
    row: (tag) => ({ kind: 'password', username: tag, client_id: 'console', ok: 1 }),
  },
]

describe.each(LOGS)('$name', (log) => {
  /** The same entry in A and in B. */
  async function twins() {
    const tag = unique()
    const a = await addRow(on, A, log.table, log.row(tag, A))
    const b = await addRow(on, B.id, log.table, log.row(tag, B.id))
    return { tag, a, b }
  }

  it('list and export: each tenant sees its own copy of the same entry only', async () => {
    const { tag, a, b } = await twins()
    const list = async (who: Who) =>
      idsOf(
        await call(who, 'get', log.path)
          .query({ [log.filter]: tag })
          .expect(200),
      )
    expect(await list('root')).toEqual([a])
    expect(await list('bOwner')).toEqual([b])
    expect(await exported('root', log.path, { [log.filter]: tag })).toHaveLength(1)
    expect(await exported('bOwner', log.path, { [log.filter]: tag })).toHaveLength(1)
  })

  it("the other tenant's ids are 404 (get, delete, batch) and nothing of it changes", async () => {
    const { a, b } = await twins()
    expect404(await call('bOwner', 'get', `${log.path}/${a}`))
    expect404(await call('root', 'get', `${log.path}/${b}`))
    expect404(await call('bOwner', 'delete', `${log.path}/${a}`))
    expect404(await call('bOwner', 'post', `${log.path}/batch-delete`, { ids: [a] }))
    // all or none: B's own row stays too
    expect404(await call('bOwner', 'post', `${log.path}/batch-delete`, { ids: [b, a] }))
    expect404(await call('root', 'delete', `${log.path}/${b}`))
    expect(await live(log.table, a)).toBe(true)
    expect(await live(log.table, b)).toBe(true)
    await call('bOwner', 'delete', `${log.path}/${b}`).expect(200)
    expect(await live(log.table, b)).toBe(false)
    expect(await live(log.table, a)).toBe(true)
  })

  it("B's administrator cleans B's log: A's entries stay", async () => {
    const { a, b } = await twins()
    await call('bOwner', 'post', `${log.path}/clean`).expect(200)
    expect(await live(log.table, b)).toBe(false)
    expect(await live(log.table, a)).toBe(true)
  })
})

it("an action log row of B's administrator is B's, acting from B", async () => {
  const id = trace()
  await call('bOwner', 'delete', `/audit/action-logs/${MISSING}`).set('X-Request-Id', id)
  expect(await logOf(ds, id)).toMatchObject({
    domain: 'audit.actionLog',
    verb: 'remove',
    tenant_id: B.id,
    actor_tenant_id: B.id,
  })
})

it("an unlock from B's sign-in log page drops B's failure counters only", async () => {
  const name = unique()
  const ip = nextIp()
  const fail = (tenantCode?: string) =>
    http()
      .post('/api/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ username: name, password: 'Wrong#2026-pass', ...(tenantCode ? { tenantCode } : {}) })
      .expect(401)
  await fail()
  await fail(B.code)
  const count = (...parts: string[]) => redis.get(redisKey('authFail', ...parts))
  expect(await count('tu', B.code, name)).toBe('1')
  await call('bOwner', 'post', '/audit/signin-logs/unlock', { username: name }).expect(200)
  expect(await count('tp', B.code, name, ip)).toBeNull()
  expect(await count('tu', B.code, name)).toBeNull()
  expect(await count('p', name, ip)).toBe('1')
  expect(await count('u', name)).toBe('1')
})

it('GET /me: the previous sign-in is one of the user’s own tenant', async () => {
  const user = await addUser(on, A, unique())
  aUsers.push(user)
  const row = (tenantId: number, at: string) =>
    addRow(on, tenantId, 'aud_signin_log', {
      kind: 'password',
      user_id: user,
      username: 'x',
      client_id: 'console',
      ok: 1,
      created_at: at,
    })
  await row(A, '2020-01-02 08:00:00')
  // a stray row of another tenant naming the user's id, later than its own
  await row(B.id, '2020-01-03 08:00:00')
  const { accessToken } = (await signInDirect(on, user))!
  const me = await http().get('/api/auth/me').set(bearer(accessToken)).expect(200)
  expect(me.body.data.lastSignInAt).toBe('2020-01-02T08:00:00.000Z')
})

describe('sign-in attempts of no tenant (an unknown code)', () => {
  const PATH = '/audit/signin-logs'
  let ghost = ''
  let none = 0
  let a = 0
  let b = 0
  const IP_A = '10.77.0.1'

  beforeAll(async () => {
    ghost = unique()
    await failLogin(ghost, UNKNOWN_CODE).expect(401)
    // written after the response: wait for it
    for (const until = Date.now() + 5000; !none && Date.now() < until;) {
      const [r] = await ds.query<{ id: number }[]>(
        'SELECT id FROM aud_signin_log WHERE username = ?',
        [ghost],
      )
      if (r) none = Number(r.id)
      else await new Promise((res) => setTimeout(res, 25))
    }
    if (!none) throw new Error('no sign-in log row for the unknown code')
    const row = { kind: 'password', username: ghost, client_id: 'console', ok: 0 }
    a = await addRow(on, A, 'aud_signin_log', { ...row, ip: IP_A })
    b = await addRow(on, B.id, 'aud_signin_log', { ...row, ip: '10.77.0.2' })
  })

  const list = (who: Who, query: object = {}) =>
    call(who, 'get', PATH).query({ username: ghost, ...query })

  it('the attempt is logged under no tenant', async () => {
    const [r] = await ds.query('SELECT tenant_id FROM aud_signin_log WHERE id = ?', [none])
    expect(r.tenant_id).toBeNull()
  })

  it('no tenant’s log shows them, root’s neither; the row itself is 404', async () => {
    expect(idsOf(await list('root').expect(200))).toEqual([a])
    expect(idsOf(await list('aAuditor').expect(200))).toEqual([a])
    const ofB = await list('bOwner').expect(200)
    expect(idsOf(ofB)).toEqual([b])
    // each row names its tenant (the page's tenant column)
    expect(ofB.body.data.items[0]).toMatchObject({ tenantId: B.id })
    expect(idsOf(await list('root', { unresolved: 0 }).expect(200))).toEqual([a])
    expect404(await call('root', 'get', `${PATH}/${none}`))
    expect404(await call('bOwner', 'get', `${PATH}/${none}`))
  })

  it('the platform root lists and exports them with `unresolved`: those rows only', async () => {
    const res = await list('root', { unresolved: 1 }).expect(200)
    expect(idsOf(res)).toEqual([none])
    expect(res.body.data.items[0]).toMatchObject({ tenantId: null })
    expect(res.body.data.total).toBe(1)
    const rows = await exported('root', PATH, { username: ghost, unresolved: 1 })
    expect(rows).toHaveLength(1)
    // the ip column: the sign-in's own, not A's copy
    expect(rows[0]![3]).not.toBe(IP_A)
    expect(rows[0]![1]).toBe(ghost)
  })

  it('anyone else asking for them is refused (403): a tenant administrator, a plain auditor of the default tenant', async () => {
    for (const who of ['bOwner', 'aAuditor'] as const) {
      expect403(await list(who, { unresolved: 1 }))
      expect403(await call(who, 'get', `${PATH}/export`).query({ username: ghost, unresolved: 1 }))
    }
  })

  it('a root principal outside the default tenant is refused too', async () => {
    const svc = on.get(SigninLogService)
    await on.get(ClsService).run(async () => {
      clsSet('principal', { userId: 1, root: true, tenantId: B.id } as Principal)
      await withTenant(B.id, async () => {
        const refused = svc.page({ page: 1, pageSize: 10, unresolved: true })
        await expect(refused).rejects.toBeInstanceOf(BizError)
        await expect(refused).rejects.toMatchObject({ err: Err.FORBIDDEN })
      })
    })
  })
})

describe('the API logs', () => {
  const TRACES = '/audit/http-traces'
  const FAULTS = '/audit/http-faults'
  const tenantOf = async (table: 'aud_http_trace' | 'aud_http_fault', id: string) =>
    (await logOf<{ tenant_id: number | null }>(ds, id, table))!.tenant_id
  const ids = {
    b: trace(),
    a: trace(),
    anonymous: trace(),
    bFault: trace(),
    anyFault: trace(),
    resolvedFault: trace(),
  }

  beforeAll(async () => {
    // non-GET requests are traced (the default mode)
    await call('bOwner', 'post', '/audit/action-logs/batch-delete', { ids: [MISSING] })
      .set('X-Request-Id', ids.b)
      .expect(404)
    await call('root', 'post', '/audit/action-logs/batch-delete', { ids: [MISSING] })
      .set('X-Request-Id', ids.a)
      .expect(404)
    // a sign-in whose tenant (B's code) resolves: still anonymous
    await failLogin(unique(), B.code, ids.anonymous).expect(401)
    await call('bOwner', 'post', '/tenant-audit-fixture/boom')
      .set('X-Request-Id', ids.bFault)
      .expect(500)
    await http()
      .post('/api/tenant-audit-fixture/public-boom')
      .set('X-Request-Id', ids.anyFault)
      .expect(500)
    await http()
      .post('/api/tenant-audit-fixture/resolved-boom')
      .set('X-Request-Id', ids.resolvedFault)
      .send({ tenantCode: B.code })
      .expect(500)
  })

  it("a request's row holds the signed-in caller's tenant, an anonymous one none", async () => {
    expect(await tenantOf('aud_http_trace', ids.b)).toBe(B.id)
    expect(await tenantOf('aud_http_trace', ids.a)).toBe(A)
    expect(await tenantOf('aud_http_trace', ids.anonymous)).toBeNull()
    expect(await tenantOf('aud_http_fault', ids.bFault)).toBe(B.id)
    expect(await tenantOf('aud_http_fault', ids.anyFault)).toBeNull()
    // B resolved as the sign-in tenant, nobody signed in
    expect(await tenantOf('aud_http_fault', ids.resolvedFault)).toBeNull()
  })

  it.each([
    ['access log', TRACES, 'b', 'a'],
    ['error log', FAULTS, 'bFault', 'anyFault'],
  ] as const)('%s: the platform root filters by tenant', async (_, path, ofB, other) => {
    const rows = async (traceId: string, tenantId: number) =>
      (await call('root', 'get', path).query({ traceId, tenantId }).expect(200)).body.data.items
    const [row] = await rows(ids[ofB], B.id)
    expect(row).toMatchObject({ traceId: ids[ofB], tenantId: B.id })
    expect(await rows(ids[ofB], A)).toEqual([])
    expect(await rows(ids[other], B.id)).toEqual([])
    expect(await exported('root', path, { traceId: ids[ofB], tenantId: B.id })).toHaveLength(1)
    expect(await exported('root', path, { traceId: ids[ofB], tenantId: A })).toHaveLength(0)
  })

  it("they stay platform pages: B's administrator is refused (403) and changes nothing", async () => {
    const fault = (await logOf<{ id: number }>(ds, ids.bFault, 'aud_http_fault'))!.id
    const trc = (await logOf<{ id: number }>(ds, ids.b, 'aud_http_trace'))!.id
    for (const res of [
      await call('bOwner', 'get', TRACES),
      await call('bOwner', 'get', `${TRACES}/export`),
      await call('bOwner', 'get', `${TRACES}/${trc}`),
      await call('bOwner', 'get', FAULTS),
      await call('bOwner', 'get', `${FAULTS}/export`),
      await call('bOwner', 'get', `${FAULTS}/${fault}`),
      await call('bOwner', 'put', `${FAULTS}/${fault}/state`, { state: 'resolved' }),
    ])
      expect403(res)
    const [{ state }] = await ds.query('SELECT state FROM aud_http_fault WHERE id = ?', [fault])
    expect(state).toBe('open')
  })
})
