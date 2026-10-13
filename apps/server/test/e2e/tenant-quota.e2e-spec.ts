// Sign-up and the user quota with tenants (see docs/design-notes.md#tenancy), with two apps on one
// database: `on` (APP_MULTI_TENANT=true) and `off`, and tenant B (its own admin, bound to a host name).
// Sign-up serves the default tenant only: a sign-up naming another tenant, by code or host, answers like
// sign-up off, exactly as one naming no tenant does; with the switch off the code is ignored. A sign-up
// whose code names no tenant writes no action log row; a successful one's row is the default tenant's on
// both columns. Every path creating users (admin create, import, sign-up) locks the tenant row, then
// refuses past `user_quota` with 409 `B1013`; two creates racing for the last place get one user.
import { setTimeout as sleep } from 'node:timers/promises'
import { Logger } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, signupParams, userPerms } from '@qiwu/shared'
import ExcelJS from 'exceljs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { ParamService } from '../../src/core/settings/param.service.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { UserService } from '../../src/modules/platform/iam/user/user.service.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { bootApp, createTenant, type PeopledTenant } from '../setup/tenants.js'

const PREFIX = 'tq-'
const PASSWORD = 'TenantQuota#2026'
const HOST_B = 'b.tenant-quota.test'
const UNKNOWN = 'zz-no-such-tenant'
const PARAMS = [...Object.values(signupParams), 'captcha.mode'] as const
const QUOTA = { code: Err.IAM_TENANT_USER_QUOTA.code, msg: "The tenant's user quota is reached" }

let on: NestExpressApplication
let off: NestExpressApplication
let ds: DataSource
let redis: Redis
let params: ParamService
let B: PeopledTenant
let bToken: string
let rootToken: string
let memberRoleId: number
const original = new Map<string, string>()

const http = (app: NestExpressApplication) => request(app.getHttpServer())
let ip = 0
const nextIp = () => `198.19.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`
let seq = 0
const unique = (tag: string) => `${PREFIX}${tag}-${++seq}`

/** POST /api/auth/signup of a fresh username from a fresh IP, `host` as the Host header when given. */
function signup(
  app: NestExpressApplication,
  username: string,
  o: { tenantCode?: string; host?: string; trace?: string } = {},
) {
  const req = http(app)
    .post('/api/auth/signup')
    .set('Accept-Language', 'en-US')
    .set('X-Forwarded-For', nextIp())
  if (o.host) req.set('Host', o.host)
  if (o.trace) req.set('X-Request-Id', o.trace)
  const body: Record<string, unknown> = { username, password: PASSWORD }
  if (o.tenantCode !== undefined) body.tenantCode = o.tenantCode
  return req.send(body)
}
/** What a client sees of an answer (the trace id aside). */
const answer = (res: request.Response) => {
  const body = { ...(res.body as Record<string, unknown>) }
  delete body.traceId
  return { status: res.status, body }
}
/** The tenant and dept of every live user named `username`. */
const usersNamed = (username: string) =>
  ds.query<{ tenant_id: number; dept_id: number | null }[]>(
    'SELECT tenant_id, dept_id FROM iam_user WHERE username = ? AND deleted_at IS NULL',
    [username],
  )
const liveUsers = async (tid: number) =>
  Number(
    (
      await ds.query<{ n: number }[]>(
        'SELECT COUNT(*) AS n FROM iam_user WHERE tenant_id = ? AND deleted_at IS NULL',
        [tid],
      )
    )[0]!.n,
  )
const setQuota = (tid: number, quota: number | null) =>
  ds.query('UPDATE iam_tenant SET user_quota = ? WHERE id = ?', [quota, tid])
const setParam = async (key: string, value: string) => {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await params.invalidate(key)
}
/** POST /api/iam/users as `token`, in B's root dept unless the token is root's. */
const create = (token: string, username: string, deptId: number | null = B.deptId) =>
  http(on)
    .post('/api/iam/users')
    .set(bearer(token))
    .set('Accept-Language', 'en-US')
    .send({ username, displayName: username, deptId, password: PASSWORD })
/** POST /api/iam/users/import (insert) of one user per name into B's root dept, as B's admin. */
async function importUsers(...names: string[]) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('users')
  ws.addRow(['username', 'displayName', 'deptId', 'mobile', 'email', 'gender', 'enabled', 'note'])
  for (const name of names) ws.addRow([name, name, B.deptId, null, null, null, null, null])
  return http(on)
    .post('/api/iam/users/import')
    .set(bearer(bToken))
    .set('Accept-Language', 'en-US')
    .attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'users.xlsx')
    .expect(200)
}
/** The error cells of an import report (`reportId`) of B's admin. */
async function reportErrors(reportId: string): Promise<string[]> {
  const res = await http(on)
    .get(`/api/excel/reports/${reportId}`)
    .set(bearer(bToken))
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
  const out: string[] = []
  for (let r = 2; r <= ws.actualRowCount; r++)
    out.push(String(ws.getRow(r).getCell(ws.getRow(r).cellCount).value))
  return out
}

beforeAll(async () => {
  on = await bootApp({ multiTenant: true })
  off = await bootApp({ multiTenant: false })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  params = on.get(ParamService)
  await cleanRedis(redis)
  B = await createTenant(on, { users: true, domains: [HOST_B] })
  // B's admin creates and imports users of its own dept
  const menus = await ds.query<{ id: number }[]>(
    "SELECT id FROM iam_menu WHERE kind = 'action' AND perms IN (?) AND deleted_at IS NULL",
    [[userPerms.create, userPerms.import]],
  )
  if (menus.length !== 2) throw new Error('the user create and import action menus are missing')
  for (const m of menus)
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, ?)', [
      B.roleId,
      m.id,
      B.id,
    ])
  bToken = (await signIn(on, 'admin', {}, B.id)).accessToken
  rootToken = (await signIn(on)).accessToken
  memberRoleId = Number(
    (
      await ds.query<{ id: number }[]>(
        "SELECT id FROM iam_role WHERE code = 'member' AND tenant_id = 1 AND deleted_at IS NULL",
      )
    )[0]!.id,
  )
  const rows = await ds.query<{ param_key: string; param_value: string }[]>(
    'SELECT param_key, param_value FROM cfg_param WHERE param_key IN (?)',
    [PARAMS],
  )
  for (const r of rows) original.set(r.param_key, r.param_value)
  if (original.size !== PARAMS.length) throw new Error('a sign-up or captcha param is not seeded')
  await setParam('captcha.mode', 'off')
  await setParam(signupParams.enabled, 'true')
  await setParam(signupParams.defaultRoleId, String(memberRoleId))
  await setParam(signupParams.defaultDeptId, '')
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (ds) await setQuota(1, null)
})

afterAll(async () => {
  if (ds) {
    await B?.dispose()
    await setQuota(1, null)
    for (const [key, value] of original) await setParam(key, value)
    await ds.query(
      'DELETE ur FROM iam_user_roles ur JOIN iam_user u ON u.id = ur.user_id WHERE u.username LIKE ?',
      [`${PREFIX}%`],
    )
    await ds.query('DELETE FROM iam_user WHERE username LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM aud_action_log WHERE trace_id LIKE ?', [`${PREFIX}%`])
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
  await off?.close()
})

describe('sign-up serves the default tenant only', () => {
  it('another tenant, by code or by host, answers like sign-up off, as an unknown code and a disabled tenant do; nobody is written', async () => {
    await setParam(signupParams.enabled, 'false')
    const closed = answer(await signup(on, unique('closed')))
    await setParam(signupParams.enabled, 'true')
    expect(closed).toMatchObject({ status: 403, body: { code: Err.AUTH_SIGNUP_DISABLED.code } })

    const names: string[] = []
    const attempt = async (o: { tenantCode?: string; host?: string }) => {
      const name = unique('refused')
      names.push(name)
      return answer(await signup(on, name, o))
    }
    expect(await attempt({ tenantCode: B.code })).toEqual(closed)
    expect(await attempt({ tenantCode: B.code.toUpperCase() })).toEqual(closed)
    expect(await attempt({ tenantCode: UNKNOWN })).toEqual(closed)
    expect(await attempt({ host: HOST_B })).toEqual(closed)
    await ds.query('UPDATE iam_tenant SET enabled = 0 WHERE id = ?', [B.id])
    try {
      expect(await attempt({ tenantCode: B.code })).toEqual(closed)
    } finally {
      await ds.query('UPDATE iam_tenant SET enabled = 1 WHERE id = ?', [B.id])
    }
    for (const name of names) expect(await usersNamed(name)).toEqual([])
  })

  it('no code, `default` or the switch off (any code ignored) sign up to the default tenant', async () => {
    for (const [app, tenantCode] of [
      [on, undefined],
      [on, 'DEFAULT'],
      [off, B.code],
      [off, UNKNOWN],
    ] as const) {
      const name = unique('ok')
      await signup(app, name, { tenantCode }).expect(201)
      expect(await usersNamed(name)).toEqual([{ tenant_id: 1, dept_id: null }])
    }
  })

  it('the default role and dept params are read in the default tenant only', async () => {
    try {
      await setParam(signupParams.defaultRoleId, String(B.roleId))
      const refused = unique('b-role')
      expect((await signup(on, refused).expect(403)).body.code).toBe(Err.AUTH_SIGNUP_DISABLED.code)
      expect(await usersNamed(refused)).toEqual([])
      await setParam(signupParams.defaultRoleId, String(memberRoleId))
      await setParam(signupParams.defaultDeptId, String(B.deptId))
      const name = unique('b-dept')
      await signup(on, name).expect(201)
      expect(await usersNamed(name)).toEqual([{ tenant_id: 1, dept_id: null }])
    } finally {
      await setParam(signupParams.defaultRoleId, String(memberRoleId))
      await setParam(signupParams.defaultDeptId, '')
    }
  })

  it('a code naming no tenant writes no action log row (and no error); a sign-up acts in the default tenant', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const unknownTrace = `${PREFIX}${process.pid}-unknown`
    const okTrace = `${PREFIX}${process.pid}-ok`
    const name = unique('logged')
    await signup(on, unique('unlogged'), { tenantCode: UNKNOWN, trace: unknownTrace }).expect(403)
    await signup(on, name, { trace: okTrace }).expect(201)
    expect(await logOf(ds, okTrace)).toMatchObject({
      domain: 'iam.user',
      verb: 'signup',
      ok: 1,
      tenant_id: 1,
      actor_tenant_id: 1,
    })
    // the row of the request sent first would be in by now
    expect(await logOf(ds, unknownTrace, 'aud_action_log', 0)).toBeNull()
    expect(error).not.toHaveBeenCalled()
  })
})

describe('the user quota', () => {
  it('admin create and import stop at the tenant’s quota with 409 B1013; deleted users and other tenants do not count', async () => {
    const live = await liveUsers(B.id)
    await setQuota(B.id, live + 1)
    const first = unique('b-create')
    await create(bToken, first).expect(201)
    const over = await create(bToken, unique('b-over')).expect(409)
    expect(over.body).toMatchObject(QUOTA)
    expect(await liveUsers(B.id)).toBe(live + 1)

    // B full, the default tenant (no quota) is not
    await create(rootToken, unique('root-create'), null).expect(201)

    await ds.query('UPDATE iam_user SET deleted_at = NOW(3) WHERE username = ? AND tenant_id = ?', [
      first,
      B.id,
    ])
    const imported = unique('b-import')
    expect((await importUsers(imported)).body.data).toMatchObject({ inserted: 1, failed: 0 })
    expect(await usersNamed(imported)).toEqual([{ tenant_id: B.id, dept_id: B.deptId }])

    const refused = unique('b-import-over')
    const full = (await importUsers(refused)).body.data
    expect(full).toMatchObject({ inserted: 0, failed: 1 })
    expect(await reportErrors(full.reportId)).toEqual([QUOTA.msg])
    expect(await usersNamed(refused)).toEqual([])
    expect(await liveUsers(B.id)).toBe(live + 1)
    await setQuota(B.id, null)
    await create(bToken, unique('b-unlimited')).expect(201)
  })

  it('two creates racing for the last place: one user, the other 409 B1013', async () => {
    const live = await liveUsers(B.id)
    await setQuota(B.id, live + 1)
    const users = on.get(UserService, { strict: false })
    const proto = UserService.prototype as unknown as {
      assertLiveDept: (...args: unknown[]) => Promise<void>
    }
    const assertLiveDept = proto.assertLiveDept
    let arrived = 0
    let release!: () => void
    const met = new Promise<void>((r) => (release = r))
    // past the quota check each create waits for the other: both get there unless the tenant lock
    // holds the second one back until the first commits
    vi.spyOn(users as unknown as typeof proto, 'assertLiveDept').mockImplementation(async function (
      this: UserService,
      ...args: unknown[]
    ) {
      if (++arrived === 2) release()
      await Promise.race([met, sleep(1500)])
      return assertLiveDept.apply(this, args)
    })
    const results = await Promise.all([
      create(bToken, unique('race')),
      create(bToken, unique('race')),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect(results.find((r) => r.status === 409)!.body).toMatchObject(QUOTA)
    expect(await liveUsers(B.id)).toBe(live + 1)
    await setQuota(B.id, null)
  })

  it('sign-up stops at the default tenant’s quota', async () => {
    await setQuota(1, await liveUsers(1))
    const refused = unique('quota')
    expect((await signup(on, refused).expect(409)).body).toMatchObject(QUOTA)
    expect(await usersNamed(refused)).toEqual([])
    await setQuota(1, (await liveUsers(1)) + 1)
    const name = unique('quota')
    await signup(on, name).expect(201)
    expect(await usersNamed(name)).toEqual([{ tenant_id: 1, dept_id: null }])
  })
})
