// Platform users working inside another tenant (see docs/design-notes.md#tenancy), multi-tenancy on. A
// platform user holding `iam.tenant.enter` (root holds it) enters tenant B with a reason, from a web
// console session only: the session then works on B's data with the user's own perms, the platform ones
// left out (root keeps `*`), never narrowed to B's package; personal routes and the platform pages run
// in the user's own tenant. The session leaves B on `leave`, after two hours, once the switch is off or
// the perm is gone, or as it ends; entering another tenant leaves B first. Entering and leaving are rows
// of the default tenant (`biz_id` = the tenant) that nobody deletes but the retention purge; B's rows of
// a platform user carry the actor's tenant, B's administrator reads them masked and cannot delete them;
// every request inside B goes into the API access log, entering and leaving too. A console request
// expecting another data tenant than the session's (`X-Tenant-Expect`) is a 409.
import { setTimeout as sleep } from 'node:timers/promises'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  actionLogPerms,
  dictPerms,
  Err,
  HTTP_TRACE_MODE_PARAM,
  type MenuNode,
  type MePayload,
  positionPerms,
  tenantPerms,
  userPerms,
  wfPerms,
} from '@qiwu/shared'
import ExcelJS from 'exceljs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { vi } from 'vitest'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { type Session, TokenService } from '../../src/core/auth/token.service.js'
import { AppConfigService } from '../../src/core/config/config.module.js'
import type { Env } from '../../src/core/config/env.schema.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { MailChannel } from '../../src/modules/platform/messaging/mail-template/mail-channel.js'
import type { TracedTable } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import {
  addUser,
  bootApp,
  createPackage,
  createTenant,
  type PeopledTenant,
  signInDirect,
  type TestPackage,
  type TestTenant,
} from '../setup/tenants.js'

const PREFIX = 'te-'
const TRACE = `tenant-enter-${process.pid}-`
/** the address a platform user's requests come from (trust proxy: loopback) */
const STAFF_IP = '203.0.113.77'
const STAFF_UA = 'tenant-enter-browser/1.0'
const TWO_HOURS = 2 * 3_600_000

let on: NestExpressApplication
let ds: DataSource
let redis: Redis
/** B: a package without the workflow; C: one with every menu open to tenants */
let B: PeopledTenant
let C: TestTenant
let noWorkflow: TestPackage
let rootId: number
/** the default tenant: a platform user who may enter (data scope all) and one who may only browse tenants */
let staff: number
let viewer: number
let revokee: number
/** a platform user holding a builtin `tenant_admin` role of the default tenant (and the perm to enter) */
let homeAdmin: number
const roles: number[] = []
/** the last ids before this spec: every row above them is this spec's (cleanup) */
const last: Record<string, number> = {}
const LAST_TABLES = ['aud_action_log', 'aud_http_trace', 'aud_signin_log', 'msg_mail_record']
let mailTemplate: number

let seq = 0
const trace = (what: string) => `${TRACE}${what}-${++seq}`
const http = () => request(on.getHttpServer())
type Method = 'get' | 'post' | 'put' | 'delete'
/** A request of `token` with trace id `id`. */
const call = (method: Method, path: string, token: string, id = trace(method)) =>
  http()[method](path).set(bearer(token)).set('X-Request-Id', id)
const enter = (token: string, tenantId: number, id = trace('enter')) =>
  call('post', `/api/iam/tenants/${tenantId}/enter`, token, id).send({ reason: 'support case 7' })
const leave = (token: string, id = trace('leave')) =>
  call('post', '/api/iam/tenants/leave', token, id).send()
const meOf = async (token: string) =>
  (await call('get', '/api/auth/me', token).expect(200)).body.data as MePayload
const menuRoutes = async (token: string) => {
  const walk = (nodes: MenuNode[]): string[] =>
    nodes.flatMap((n) => [n.routeName ?? '', ...walk(n.children)])
  return walk((await call('get', '/api/auth/menus', token).expect(200)).body.data as MenuNode[])
}
const userIds = async (token: string) =>
  (
    (await call('get', '/api/iam/users', token).query({ pageSize: 100 }).expect(200)).body.data
      .items as { id: number }[]
  )
    .map((u) => u.id)
    .sort((x, y) => x - y)
const sortedIds = (...ids: number[]) => [...ids].sort((x, y) => x - y)
const tokenOf = async (userId: number) => (await signInDirect(on, userId))!.accessToken

/** Every row of `table` with trace id `id`, polled until there are `n` (inserted after the response). */
async function rowsOf(id: string, n = 1, table: TracedTable = 'aud_action_log') {
  for (const until = Date.now() + 5000; ; await sleep(25)) {
    // arch-allow: sql-concat table name from the TracedTable union
    const rows = await ds.query(`SELECT * FROM ${table} WHERE trace_id = ? ORDER BY id`, [id])
    if (rows.length >= n || Date.now() > until) return rows as Record<string, unknown>[]
  }
}
/** The action log row of a request that wrote exactly one. */
const rowOf = async (id: string) => (await rowsOf(id))[0]!
const paramsOf = (row: Record<string, unknown>) => JSON.parse(String(row.params))
/** Whether the action log row is live (not soft-deleted). */
const live = async (id: number) =>
  (await ds.query('SELECT deleted_at FROM aud_action_log WHERE id = ?', [id]))[0]?.deleted_at ===
  null
const storedSession = async (sid: string) =>
  JSON.parse((await redis.get(redisKey('authSession', sid)))!) as Session

/** A tenant-1 role (data scope all) granted the menus carrying `perms`; returns its id. */
async function role(code: string, perms: string[]): Promise<number> {
  const { insertId } = await ds.query<{ insertId: number }>(
    "INSERT INTO iam_role (code, name, data_scope, tenant_id) VALUES (?, ?, 'all', 1)",
    [PREFIX + code, PREFIX + code],
  )
  const id = Number(insertId)
  roles.push(id)
  await ds.query(
    `INSERT INTO iam_role_menus (role_id, menu_id, tenant_id)
     SELECT ?, id, 1 FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL`,
    [id, perms],
  )
  return id
}

async function setTraceMode(mode: string) {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
    mode,
    HTTP_TRACE_MODE_PARAM,
  ])
  await on.get(ParamService).invalidate(HTTP_TRACE_MODE_PARAM)
}

beforeAll(async () => {
  on = await bootApp({ multiTenant: true })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get<Redis>(REDIS)
  await cleanRedis(redis)
  for (const table of LAST_TABLES)
    // arch-allow: sql-concat table names from the spec's list
    last[table] = Number((await ds.query(`SELECT COALESCE(MAX(id), 0) AS n FROM ${table}`))[0].n)
  const open = (
    await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE platform_only = 0 AND deleted_at IS NULL',
    )
  ).map((r) => Number(r.id))
  const workflow = (
    await ds.query<{ id: number }[]>(
      `SELECT m.id FROM iam_menu m
         JOIN iam_menu g ON g.route_name = 'workflow' AND g.parent_id = 0 AND g.deleted_at IS NULL
        WHERE m.tree_path LIKE CONCAT('/', g.id, '/%') AND m.deleted_at IS NULL`,
    )
  ).map((r) => Number(r.id))
  if (workflow.length < 2) throw new Error('the workflow menus are missing')
  noWorkflow = await createPackage(on, { menuIds: open.filter((id) => !workflow.includes(id)) })
  B = await createTenant(on, { users: true, packageId: noWorkflow.id })
  C = await createTenant(on)
  rootId = Number(
    (await ds.query("SELECT id FROM iam_user WHERE username = 'admin' AND tenant_id = 1"))[0].id,
  )
  const staffRole = await role('staff', [
    tenantPerms.enter,
    dictPerms.browse,
    userPerms.browse,
    userPerms['reset-password'],
    positionPerms.browse,
    positionPerms.create,
    wfPerms.model.browse,
    actionLogPerms.browse,
    actionLogPerms.remove,
  ])
  staff = await addUser(on, 1, `${PREFIX}staff`, { roleId: staffRole })
  viewer = await addUser(on, 1, `${PREFIX}viewer`, {
    roleId: await role('viewer', [tenantPerms.browse, userPerms.browse]),
  })
  revokee = await addUser(on, 1, `${PREFIX}revokee`, {
    roleId: await role('revokee', [tenantPerms.enter, userPerms.browse]),
  })
  const { insertId: adminRole } = await ds.query<{ insertId: number }>(
    "INSERT INTO iam_role (code, name, data_scope, is_builtin, tenant_id) VALUES ('tenant_admin', ?, 'all', 1, 1)",
    [`${PREFIX}home-admin`],
  )
  roles.push(Number(adminRole))
  homeAdmin = await addUser(on, 1, `${PREFIX}home-admin`, { roleId: Number(adminRole) })
  await ds.query('INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, 1)', [
    homeAdmin,
    await role('home-admin-enter', [tenantPerms.enter]),
  ])
  // B's `admin` holds B's tenant_admin role too: protected, managed by root and B's administrators only
  await ds.query(
    `INSERT INTO iam_user_roles (user_id, role_id, tenant_id)
     SELECT ?, id, ? FROM iam_role WHERE code = 'tenant_admin' AND tenant_id = ? AND deleted_at IS NULL`,
    [B.users.admin, B.id, B.id],
  )
  const { insertId } = await ds.query<{ insertId: number }>(
    `INSERT INTO msg_mail_template (code, locale, name, subject, body, enabled)
     VALUES (?, 'en-US', ?, 'Hello', '<p>Hello</p>', 1)`,
    [`${PREFIX}mail`, `${PREFIX}mail`],
  )
  mailTemplate = Number(insertId)
})

afterAll(async () => {
  if (ds) {
    // the rows of the last requests are written after their responses
    await sleep(300)
    await B?.dispose()
    await C?.dispose()
    await noWorkflow?.dispose()
    for (const table of LAST_TABLES)
      if (last[table] !== undefined)
        // arch-allow: sql-concat table names from the spec's list
        await ds.query(`DELETE FROM ${table} WHERE id > ?`, [last[table]])
    if (mailTemplate) await ds.query('DELETE FROM msg_mail_template WHERE id = ?', [mailTemplate])
    if (roles.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roles])
      await ds.query('DELETE FROM iam_user_roles WHERE role_id IN (?)', [roles])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roles])
    }
    await ds.query('DELETE FROM iam_user WHERE username LIKE ? AND tenant_id = 1', [`${PREFIX}%`])
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
})

describe('root inside B', () => {
  it("works on B's data and writes into B as itself (actor tenant 1); /me names B; personal and platform routes run in its own tenant, also under B's X-Tenant-Expect; entering and leaving are rows of the default tenant", async () => {
    const s = await signIn(on)
    const token = s.accessToken
    const entered = trace('enter')
    const before = Date.now()
    await enter(token, B.id, entered).expect(200)
    const enterRow = await rowOf(entered)
    expect(enterRow).toMatchObject({
      domain: 'iam.tenant',
      verb: 'enter',
      biz_id: String(B.id),
      user_id: rootId,
      tenant_id: 1,
      actor_tenant_id: 1,
    })
    const params = paramsOf(enterRow)
    expect(params.body).toEqual({ reason: 'support case 7' })
    const until = Date.parse(params.actingUntil)
    expect(until).toBeGreaterThanOrEqual(before + TWO_HOURS)
    expect(until).toBeLessThanOrEqual(Date.now() + TWO_HOURS)
    expect((await storedSession(s.session.sid)).actingUntil).toBe(until)

    expect(await userIds(token)).toEqual(sortedIds(B.ownerId, B.users.admin, B.users.alice))
    const wrote = trace('position')
    const { id: positionId } = (
      await call('post', '/api/iam/positions', token, wrote)
        .send({ code: `${PREFIX}root`, name: `${PREFIX}root` })
        .expect(201)
    ).body.data as { id: number }
    expect(await ds.query('SELECT tenant_id FROM iam_position WHERE id = ?', [positionId])).toEqual(
      [{ tenant_id: B.id }],
    )
    expect(await rowOf(wrote)).toMatchObject({
      domain: 'iam.position',
      verb: 'create',
      user_id: rootId,
      tenant_id: B.id,
      actor_tenant_id: 1,
    })

    const me = (
      await call('get', '/api/auth/me', token).set('X-Tenant-Expect', String(B.id)).expect(200)
    ).body.data as MePayload
    expect(me.user.id).toBe(rootId)
    expect(me.tenant).toMatchObject({ id: B.id, code: B.code, acting: true })
    await call('get', '/api/settings/dicts', token).set('X-Tenant-Expect', String(B.id)).expect(200)
    expect((await call('get', '/api/iam/profile', token).expect(200)).body.data.id).toBe(rootId)

    const left = trace('leave')
    await leave(token, left).expect(200)
    const leaveRow = await rowOf(left)
    expect(leaveRow).toMatchObject({
      domain: 'iam.tenant',
      verb: 'leave',
      biz_id: String(B.id),
      user_id: rootId,
      tenant_id: 1,
      actor_tenant_id: 1,
    })
    expect(paramsOf(leaveRow)).toEqual({ reason: 'left', actingUntil: params.actingUntil })
    expect((await meOf(token)).tenant).toMatchObject({ id: 1, acting: false })
    expect(await userIds(token)).not.toContain(B.ownerId)
  })

  it('every request inside B goes into the API access log, its GETs too, and so do entering and leaving, whatever the mode', async () => {
    const token = (await signIn(on)).accessToken
    await setTraceMode('off')
    try {
      const ids = { enter: trace('enter'), get: trace('get'), leave: trace('leave') }
      await enter(token, B.id, ids.enter).expect(200)
      await call('get', '/api/iam/users', token, ids.get).expect(200)
      await leave(token, ids.leave).expect(200)
      const [entered] = await rowsOf(ids.enter, 1, 'aud_http_trace')
      expect(entered).toMatchObject({ method: 'POST', user_id: rootId, tenant_id: 1 })
      const [read] = await rowsOf(ids.get, 1, 'aud_http_trace')
      expect(read).toMatchObject({ method: 'GET', url: '/api/iam/users', tenant_id: B.id })
      const [left] = await rowsOf(ids.leave, 1, 'aud_http_trace')
      expect(left).toMatchObject({ method: 'POST', url: '/api/iam/tenants/leave' })
    } finally {
      await setTraceMode('write')
    }
  })

  it('leaves B two hours on: the next requests, sent at once by a tab expecting B, log the end once, traced as its 409; then the session runs in its own tenant', async () => {
    const s = await signIn(on)
    await enter(s.accessToken, B.id).expect(200)
    const end = Date.now() - 1000
    const session = await storedSession(s.session.sid)
    session.actingUntil = end
    await redis.set(redisKey('authSession', s.session.sid), JSON.stringify(session), {
      KEEPTTL: true,
    })
    // three requests at once, each reading the expired stay: one leave row
    const ids = [trace('expired'), trace('expired'), trace('expired')]
    const answers = await Promise.all(
      ids.map((id) =>
        call('get', '/api/auth/me', s.accessToken, id).set('X-Tenant-Expect', String(B.id)),
      ),
    )
    for (const res of answers)
      expect([res.status, res.body.code]).toEqual([409, Err.AUTH_TENANT_SWITCHED.code])
    const leaves = () =>
      ds.query<Record<string, unknown>[]>(
        "SELECT * FROM aud_action_log WHERE verb = 'leave' AND trace_id IN (?) ORDER BY id",
        [ids],
      )
    await vi.waitFor(async () => expect(await leaves()).not.toEqual([]), { timeout: 5_000 })
    // the rows are written without awaiting: give a second one the time to show
    await sleep(300)
    const rows = await leaves()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    const next = String(row.trace_id)
    expect(row).toMatchObject({ verb: 'leave', biz_id: String(B.id), tenant_id: 1 })
    expect(paramsOf(row)).toEqual({ reason: 'expired', actingUntil: new Date(end).toISOString() })
    expect(await rowsOf(next, 1, 'aud_http_trace')).toEqual([
      expect.objectContaining({
        user_id: rootId,
        tenant_id: 1,
        status_code: 409,
        biz_code: Err.AUTH_TENANT_SWITCHED.code,
      }),
    ])
    expect((await storedSession(s.session.sid)).actingTenantId).toBeUndefined()
    expect((await meOf(s.accessToken)).tenant).toMatchObject({ id: 1, acting: false })
  })

  it('signing out inside B logs its leave (signout); being kicked one (session end)', async () => {
    const out = await signIn(on)
    await enter(out.accessToken, B.id).expect(200)
    const signout = trace('logout')
    await call('post', '/api/auth/logout', out.accessToken, signout).expect(200)
    const left = await rowOf(signout)
    expect(left).toMatchObject({ verb: 'leave', biz_id: String(B.id), user_id: rootId })
    expect(paramsOf(left).reason).toBe('signout')

    const kicked = await signIn(on)
    await enter(kicked.accessToken, B.id).expect(200)
    const other = (await signIn(on)).accessToken
    const kick = trace('kick')
    await call('delete', `/api/iam/sessions/${kicked.session.sid}`, other, kick).expect(200)
    const ended = (await rowsOf(kick, 2)).find((r) => r.verb === 'leave')!
    expect(ended).toMatchObject({ biz_id: String(B.id), user_id: rootId, tenant_id: 1 })
    expect(paramsOf(ended).reason).toBe('session_end')
  })

  it('entering C from inside B leaves B first (switched)', async () => {
    const token = (await signIn(on)).accessToken
    await enter(token, B.id).expect(200)
    const id = trace('enter')
    await enter(token, C.id, id).expect(200)
    const rows = await rowsOf(id, 2)
    expect(rows.map((r) => [r.verb, r.biz_id, paramsOf(r).reason ?? null]).sort()).toEqual(
      [
        ['enter', String(C.id), null],
        ['leave', String(B.id), 'switched'],
      ].sort(),
    )
    expect((await meOf(token)).tenant).toMatchObject({ id: C.id, acting: true })
    await leave(token).expect(200)
  })

  it('enters a disabled or an expired tenant (to look into it)', async () => {
    const token = (await signIn(on)).accessToken
    for (const [set, back] of [
      ['enabled = 0', 'enabled = 1'],
      ['expires_at = NOW(3) - INTERVAL 1 DAY', 'expires_at = NULL'],
    ]) {
      // arch-allow: sql-concat assignments from the list above
      await ds.query(`UPDATE iam_tenant SET ${set} WHERE id = ?`, [C.id])
      try {
        await enter(token, C.id).expect(200)
        expect(await userIds(token)).toEqual([C.ownerId])
        await leave(token).expect(200)
      } finally {
        // arch-allow: sql-concat assignments from the list above
        await ds.query(`UPDATE iam_tenant SET ${back} WHERE id = ?`, [C.id])
      }
    }
  })

  it("kicks only B's sessions from inside B", async () => {
    const token = (await signIn(on)).accessToken
    const own = await signIn(on)
    const alice = (await signInDirect(on, B.users.alice))!
    await enter(token, B.id).expect(200)
    const res = await call('delete', `/api/iam/sessions/${own.session.sid}`, token)
    expect(res.status).toBe(404)
    expect(await on.get(TokenService).load(own.session.sid)).not.toBeNull()
    await call('delete', `/api/iam/sessions/${alice.session.sid}`, token).expect(200)
    expect(await on.get(TokenService).load(alice.session.sid)).toBeNull()
    await leave(token).expect(200)
  })
})

describe("B's administrator and a platform user's rows", () => {
  it('sees them masked and marked as the platform’s (list, detail, export, IP filter); deleting or cleaning leaves them', async () => {
    const token = await tokenOf(staff)
    await enter(token, B.id).set('X-Forwarded-For', STAFF_IP).expect(200)
    const wrote = trace('position')
    await call('post', '/api/iam/positions', token, wrote)
      .set('X-Forwarded-For', STAFF_IP)
      .set('User-Agent', STAFF_UA)
      .send({ code: `${PREFIX}staff`, name: `${PREFIX}staff` })
      .expect(201)
    const row = await rowOf(wrote)
    expect(row).toMatchObject({
      user_id: staff,
      tenant_id: B.id,
      actor_tenant_id: 1,
      ip: STAFF_IP,
      user_agent: STAFF_UA,
    })
    const id = Number(row.id)
    await leave(token).expect(200)

    const owner = await tokenOf(B.ownerId)
    const masked = {
      id,
      username: `${PREFIX}staff`,
      actorTenantId: 1,
      ip: null,
      location: null,
      userAgent: null,
      deptName: null,
    }
    const list = (query: object) =>
      call('get', '/api/audit/action-logs', owner)
        .query({ pageSize: 100, ...query })
        .expect(200)
    const items = (await list({ domain: 'iam.position' })).body.data.items as { id: number }[]
    expect(items.find((r) => r.id === id)).toMatchObject(masked)
    expect(
      (await call('get', `/api/audit/action-logs/${id}`, owner).expect(200)).body.data,
    ).toMatchObject(masked)
    expect((await list({ ip: STAFF_IP.slice(0, 9) })).body.data.total).toBe(0)
    const exported = await call('get', '/api/audit/action-logs/export', owner)
      .query({ domain: 'iam.position' })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => cb(null, Buffer.concat(chunks)))
      })
      .expect(200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(exported.body as Parameters<typeof wb.xlsx.load>[0])
    const texts: string[] = []
    wb.worksheets[0]!.eachRow((r) => r.eachCell((c) => void texts.push(String(c.value))))
    expect(texts).toContain(`${PREFIX}staff`)
    expect(texts.filter((t) => t.includes(STAFF_IP))).toEqual([])

    expect((await call('delete', `/api/audit/action-logs/${id}`, owner)).status).toBe(404)
    const batch = await call('post', '/api/audit/action-logs/batch-delete', owner).send({
      ids: [id],
    })
    expect(batch.status).toBe(404)
    await call('post', '/api/audit/action-logs/clean', owner).expect(200)
    expect(await live(id)).toBe(true)
    // B's own rows went, the platform users' stayed
    const after = (await list({ domain: 'iam.position' })).body.data.items as {
      actorTenantId: number
    }[]
    expect(after).toContainEqual(expect.objectContaining(masked))
    expect(after.filter((r) => r.actorTenantId !== 1)).toEqual([])
  })
})

describe('a platform user (not root) holding the perm to enter', () => {
  it("works inside B with its own perms, platform perms left out and not narrowed to B's package; a menu write elsewhere keeps it inside; leaving needs no perm", async () => {
    const token = await tokenOf(staff)
    await call('get', '/api/settings/dicts', token).expect(200)
    const entered = trace('enter')
    await enter(token, B.id, entered).expect(200)
    expect(await rowOf(entered)).toMatchObject({
      verb: 'enter',
      biz_id: String(B.id),
      user_id: staff,
      tenant_id: 1,
      actor_tenant_id: 1,
    })
    expect(await userIds(token)).toEqual(sortedIds(B.ownerId, B.users.admin, B.users.alice))
    const wrote = trace('position')
    await call('post', '/api/iam/positions', token, wrote)
      .send({ code: `${PREFIX}inside`, name: `${PREFIX}inside` })
      .expect(201)
    expect(await rowOf(wrote)).toMatchObject({
      user_id: staff,
      tenant_id: B.id,
      actor_tenant_id: 1,
    })
    // B's package holds no workflow: the user's own perms and features still reach it
    await call('get', '/api/wf/models', token).query({ page: 1, pageSize: 1 }).expect(200)
    await call('get', '/api/wf/tasks/todo', token).expect(200)
    const routes = await menuRoutes(token)
    expect(routes).toContain('workflow')
    expect(routes).toContain('iam-user')
    expect(routes).not.toContain('settings-dict')
    expect(routes).not.toContain('iam-tenant')
    const me = await meOf(token)
    expect(me.tenant).toMatchObject({ id: B.id, acting: true })
    expect(me.perms).toContain(userPerms.browse)
    expect(me.perms).not.toContain(dictPerms.browse)
    expect(me.perms).not.toContain(tenantPerms.enter)
    // platform perms are left out inside B; the refusal is traced too
    const refused = trace('dicts')
    expect((await call('get', '/api/settings/dicts', token, refused)).status).toBe(403)
    expect(await rowsOf(refused, 1, 'aud_http_trace')).toEqual([
      expect.objectContaining({ user_id: staff, status_code: 403 }),
    ])
    for (const tid of [B.id, C.id]) expect((await enter(token, tid)).status).toBe(403)
    // B's owner is protected: only root resets its password
    const reset = await call('put', `/api/iam/users/${B.ownerId}/password`, token).send({
      password: 'Reset#2026-pass',
    })
    expect(reset.status).toBe(422)
    expect(reset.body.code).toBe(Err.IAM_USER_PROTECTED.code)
    // a reload for another reason judges the own perms: still inside
    await on.get(PermVersion).bumpAll()
    expect((await meOf(token)).tenant).toMatchObject({ id: B.id, acting: true })

    const left = trace('leave')
    await leave(token, left).expect(200)
    expect(await rowOf(left)).toMatchObject({
      verb: 'leave',
      biz_id: String(B.id),
      user_id: staff,
      tenant_id: 1,
    })
    await call('get', '/api/settings/dicts', token).expect(200)
    expect(await menuRoutes(token)).toContain('settings-dict')
    await enter(token, C.id).expect(200)
    expect(await userIds(token)).toEqual([C.ownerId])
    await leave(token).expect(200)
  })

  it("a reload reads the user's own grants, whatever tenant the context names", async () => {
    // qw:cross-tenant a reload inside the entered tenant's context still loads the user's own grants
    const user = await withTenant(B.id, () => on.get(PermVersion).load(staff))
    expect(user?.tenantId).toBe(1)
    expect(user?.perms).toEqual(expect.arrayContaining([tenantPerms.enter, dictPerms.browse]))
  })

  it("is none of B's administrators, even holding the default tenant's tenant_admin role: B's protected users stay out of reach (422)", async () => {
    const token = await tokenOf(homeAdmin)
    expect((await meOf(token)).roles).toContain('tenant_admin')
    await enter(token, B.id).expect(200)
    const reset = await call('put', `/api/iam/users/${B.users.admin}/password`, token).send({
      password: 'Reset#2026-pass',
    })
    expect(reset.status).toBe(422)
    expect(reset.body.code).toBe(Err.IAM_USER_PROTECTED.code)
    await leave(token).expect(200)
  })

  it('cleaning its own tenant’s log afterwards keeps the rows of entering and leaving; deleting one by id is a 404', async () => {
    const token = await tokenOf(staff)
    const ids = { enter: trace('enter'), leave: trace('leave') }
    await enter(token, B.id, ids.enter).expect(200)
    await leave(token, ids.leave).expect(200)
    const kept = [Number((await rowOf(ids.enter)).id), Number((await rowOf(ids.leave)).id)]
    await call('post', '/api/audit/action-logs/clean', token).expect(200)
    for (const id of kept) {
      expect(await live(id)).toBe(true)
      expect((await call('delete', `/api/audit/action-logs/${id}`, token)).status).toBe(404)
    }
    const batch = await call('post', '/api/audit/action-logs/batch-delete', token).send({
      ids: kept,
    })
    expect(batch.status).toBe(404)
    for (const id of kept) expect(await live(id)).toBe(true)
  })

  it('leaves B once the perm to enter is taken away: the next request is logged (revoked) and runs in its own tenant', async () => {
    const token = await tokenOf(revokee)
    await enter(token, B.id).expect(200)
    expect(await userIds(token)).toContain(B.ownerId)
    const [{ id: roleId }] = await ds.query<{ id: number }[]>(
      'SELECT role_id AS id FROM iam_user_roles WHERE user_id = ?',
      [revokee],
    )
    await ds.query(
      `DELETE rm FROM iam_role_menus rm JOIN iam_menu m ON m.id = rm.menu_id
        WHERE rm.role_id = ? AND m.perms = ?`,
      [roleId, tenantPerms.enter],
    )
    await on.get(PermVersion).bumpUser(revokee)
    const next = trace('revoked')
    const me = (await call('get', '/api/auth/me', token, next).expect(200)).body.data as MePayload
    expect(me.tenant).toMatchObject({ id: 1, acting: false })
    const row = await rowOf(next)
    expect(row).toMatchObject({ verb: 'leave', biz_id: String(B.id), user_id: revokee })
    expect(paramsOf(row).reason).toBe('revoked')
    expect(await userIds(token)).not.toContain(B.ownerId)
  })
})

describe('platform routes inside B', () => {
  it("run in the default tenant: a param change is logged there (B's administrator sees nothing), a mail template test is recorded there; dict options read as usual", async () => {
    const token = (await signIn(on)).accessToken
    await enter(token, B.id).expect(200)
    const [{ id: paramId }] = await ds.query<{ id: number }[]>(
      'SELECT id FROM cfg_param WHERE param_key = ?',
      [HTTP_TRACE_MODE_PARAM],
    )
    const changed = trace('param')
    await call('put', `/api/settings/params/${paramId}`, token, changed).send({}).expect(200)
    const row = await rowOf(changed)
    expect(row).toMatchObject({ domain: 'settings.param', tenant_id: 1, actor_tenant_id: 1 })
    const owner = await tokenOf(B.ownerId)
    const seen = (
      await call('get', '/api/audit/action-logs', owner)
        .query({ domain: 'settings.param', pageSize: 100 })
        .expect(200)
    ).body.data.items as { id: number }[]
    expect(seen.map((r) => r.id)).not.toContain(Number(row.id))

    const deliver = vi.spyOn(on.get(MailChannel, { strict: false }), 'deliver')
    deliver.mockResolvedValue()
    try {
      const { recordId } = (
        await call('post', `/api/messaging/mail-templates/${mailTemplate}/test`, token)
          .send({ to: 'probe@example.com', params: {} })
          .expect(200)
      ).body.data as { recordId: number }
      expect(
        await ds.query('SELECT tenant_id FROM msg_mail_record WHERE id = ?', [recordId]),
      ).toEqual([{ tenant_id: 1 }])
      const records = (
        await call('get', '/api/messaging/mail-records', owner).query({ pageSize: 100 }).expect(200)
      ).body.data.items as { id: number }[]
      expect(records.map((r) => r.id)).not.toContain(recordId)
    } finally {
      deliver.mockRestore()
    }

    const dict = (await call('get', '/api/settings/dicts/iam.gender/entries', token).expect(200))
      .body.data as { entries: unknown[] }
    expect(dict.entries.length).toBeGreaterThan(0)
    await leave(token).expect(200)
  })
})

describe('who may enter', () => {
  it("not a platform user without the perm (403), nor B's users, its tenant_admin too (403, leaving too); only a web console session (403; a third-party access token 401), into another existing tenant (404); a refused leave is traced; a reason is required (400); off, no route (404)", async () => {
    expect((await enter(await tokenOf(viewer), B.id)).status).toBe(403)
    for (const userId of [B.users.alice, B.ownerId]) {
      const token = await tokenOf(userId)
      expect((await enter(token, B.id)).status).toBe(403)
      expect((await enter(token, C.id)).status).toBe(403)
      expect((await leave(token)).status).toBe(403)
    }
    const mobile = await signIn(on, 'admin', { clientId: 'mobile' })
    expect((await enter(mobile.accessToken, B.id)).status).toBe(403)
    expect((await storedSession(mobile.session.sid)).actingTenantId).toBeUndefined()
    const root = (await signIn(on)).accessToken
    // not inside another tenant: nothing to leave, and the refusal is in the API access log whatever its mode
    await setTraceMode('off')
    try {
      const refused = trace('leave')
      expect((await leave(root, refused)).status).toBe(403)
      expect(await rowsOf(refused, 1, 'aud_http_trace')).toEqual([
        expect.objectContaining({
          url: '/api/iam/tenants/leave',
          user_id: rootId,
          status_code: 403,
        }),
      ])
    } finally {
      await setTraceMode('write')
    }
    // a third-party (OAuth) access token neither enters nor leaves
    const oauth = (await signInDirect(on, rootId, { clientId: 'probe-app' }))!.accessToken
    expect((await enter(oauth, B.id)).status).toBe(401)
    expect((await leave(oauth)).status).toBe(401)
    for (const tid of [1, 999_999_999]) expect((await enter(root, tid)).status).toBe(404)
    for (const body of [{}, { reason: ' ' }, { reason: 'x'.repeat(201) }]) {
      const res = await call('post', `/api/iam/tenants/${B.id}/enter`, root).send(body)
      expect(res.status).toBe(400)
    }
    const cfg = on.get(AppConfigService)
    const get = cfg.get.bind(cfg)
    const spy = vi
      .spyOn(cfg, 'get')
      .mockImplementation(((key: keyof Env) =>
        key === 'APP_MULTI_TENANT' ? false : get(key)) as AppConfigService['get'])
    try {
      expect((await enter(root, B.id)).status).toBe(404)
      expect((await leave(root)).status).toBe(404)
    } finally {
      spy.mockRestore()
    }
    expect((await meOf(root)).tenant).toMatchObject({ id: 1, acting: false })
  })
})

describe('X-Tenant-Expect', () => {
  it('a write from a tab expecting another tenant than the session works in now is a 409 A1040 and stores nothing; mobile sessions are not checked', async () => {
    const token = (await signIn(on)).accessToken
    await enter(token, B.id).expect(200)
    const stale = await call('post', '/api/iam/positions', token)
      .set('X-Tenant-Expect', '1')
      .send({ code: `${PREFIX}stale`, name: `${PREFIX}stale` })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe(Err.AUTH_TENANT_SWITCHED.code)
    expect(
      await ds.query('SELECT id FROM iam_position WHERE code = ?', [`${PREFIX}stale`]),
    ).toEqual([])
    const me = await call('get', '/api/auth/me', token).set('X-Tenant-Expect', '1')
    expect(me.status).toBe(409)
    await call('get', '/api/auth/me', token).set('X-Tenant-Expect', String(B.id)).expect(200)
    await leave(token).set('X-Tenant-Expect', String(B.id)).expect(200)
    const mobile = (await signIn(on, 'admin', { clientId: 'mobile' })).accessToken
    await call('get', '/api/auth/me', mobile).set('X-Tenant-Expect', String(B.id)).expect(200)
  })
})
