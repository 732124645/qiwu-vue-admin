// Opening a tenant (TenantProvisioner, see docs/design-notes.md#tenancy), multi-tenancy on. One transaction
// makes the tenant row, its tenant seeds (a root dept named after it, the builtin tenant_admin role, the
// process templates, its office models and attendance policy) and its administrator (the owner: tenant_admin, root dept, the
// initial password to be changed at the first sign-in); a failing step leaves none of it. The initial
// password is random per tenant, returned once and stored only as a SecretBox box, and new users of the
// tenant made without a password get it, never the default tenant's param. A user of the new tenant
// submits the leave page; the task goes to the holders of its tenant_admin role.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, leavePerms, USER_INITIAL_PASSWORD_PARAM, WF_TEMPLATE_KEY_PREFIX } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import { type DataSource, EntityManager } from 'typeorm'
import { SecretBox } from '../../src/core/crypto/secret-box.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { runSeeds } from '../../src/db/seeds/index.js'
import { WF_TEMPLATES } from '../../src/db/seeds/workflow/process-templates.seed.js'
import { GENERIC_MODEL } from '../../src/db/seeds/project/oa-generic.seed.js'
import { TRIP_MODEL } from '../../src/modules/oa/trip/trip-wf.handler.js'
import { EXPENSE_MODEL } from '../../src/modules/oa/expense/expense-wf.handler.js'
import { SEAL_MODEL } from '../../src/modules/oa/seal/seal-wf.handler.js'
import { LEAVE_MODEL } from '../../src/modules/biz/leave/leave-wf.handler.js'
import { TenantProvisioner } from '../../src/modules/platform/iam/tenant/tenant-provisioner.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import {
  addUser,
  bootApp,
  createTenant,
  signInDirect,
  TENANT_OWNER,
  type TestTenant,
} from '../setup/tenants.js'

const PREFIX = 'tpv-'
const OFFICE_MODELS = [TRIP_MODEL, EXPENSE_MODEL, SEAL_MODEL, GENERIC_MODEL]

let on: NestExpressApplication
let ds: DataSource
let redis: Redis
const made: TestTenant[] = []

const http = () => request(on.getHttpServer())
const tenant = async (name?: string) => {
  const t = await createTenant(on, { name })
  made.push(t)
  return t
}
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[]) =>
  (await ds.query<T[]>(sql, params))[0]!
const idOf = async (sql: string, params: unknown[]) =>
  Number((await one<{ id: number }>(sql, params)).id)
const rootDept = (tid: number) =>
  idOf('SELECT id FROM iam_dept WHERE parent_id = 0 AND tenant_id = ?', [tid])
const adminRole = (tid: number) =>
  idOf("SELECT id FROM iam_role WHERE code = 'tenant_admin' AND is_builtin = 1 AND tenant_id = ?", [
    tid,
  ])
const tables = [
  'iam_tenant',
  'iam_dept',
  'iam_role',
  'iam_user',
  'iam_user_roles',
  'wf_form',
  'oa_attendance_policy',
  'wf_model',
  'wf_version',
]
/** Row counts of what opening a tenant writes (no other spec runs meanwhile). */
const counts = async () =>
  Object.fromEntries(
    await Promise.all(
      // table names are this spec's own constants
      tables.map(async (t) => [t, Number((await one(`SELECT COUNT(*) AS n FROM ${t}`, [])).n)]),
    ),
  )
const admin = { username: TENANT_OWNER, displayName: TENANT_OWNER }
let ip = 0
/** POST /api/auth/login from an address of its own (no failure counter carries over). */
const login = (tenantCode: string, username: string, password: string) =>
  http()
    .post('/api/auth/login')
    .set('X-Forwarded-For', `198.19.0.${++ip}`)
    .send({ tenantCode, username, password })

beforeAll(async () => {
  on = await bootApp({ multiTenant: true })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  await cleanRedis(redis)
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  if (ds) for (const t of made) await t.dispose()
  if (redis) await cleanRedis(redis)
  await on?.close()
})

describe('opening a tenant', () => {
  it('makes its root dept, builtin tenant_admin role, process templates, office models, attendance policy and the administrator who owns it', async () => {
    const t = await tenant(`${PREFIX}Acme`)
    const dept = await rootDept(t.id)
    expect(
      await ds.query('SELECT parent_id, tree_path, name FROM iam_dept WHERE tenant_id = ?', [t.id]),
    ).toEqual([{ parent_id: 0, tree_path: `/${dept}/`, name: `${PREFIX}Acme` }])
    const role = await adminRole(t.id)
    expect(
      await ds.query(
        'SELECT id, code, name, data_scope, is_builtin FROM iam_role WHERE tenant_id = ?',
        [t.id],
      ),
    ).toEqual([
      {
        id: role,
        code: 'tenant_admin',
        name: 'seed.role.tenantAdmin',
        data_scope: 'all',
        is_builtin: 1,
      },
    ])
    // its perms come from the menus, not from grant rows
    expect(
      await ds.query('SELECT role_id FROM iam_role_menus WHERE tenant_id = ?', [t.id]),
    ).toEqual([])
    const models = await ds.query<{ model_key: string }[]>(
      'SELECT model_key FROM wf_model WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY model_key',
      [t.id],
    )
    expect(models.map((m) => m.model_key)).toEqual(
      [
        LEAVE_MODEL,
        ...OFFICE_MODELS,
        ...WF_TEMPLATES.map((tpl) => WF_TEMPLATE_KEY_PREFIX + tpl.key),
      ].sort(),
    )
    // 可运行流程只发布在本租户，由本租户管理员审批，不能引用默认租户角色。
    const versions = await ds.query<
      { model_key: string; version: number; tenant_id: number; tree_json: unknown }[]
    >(
      `SELECT m.model_key, v.version, v.tenant_id, v.tree_json FROM wf_model m JOIN wf_version v ON v.id = m.current_version_id
        WHERE m.tenant_id = ? AND m.model_key IN (?) AND m.deleted_at IS NULL ORDER BY m.model_key`,
      [t.id, [LEAVE_MODEL, ...OFFICE_MODELS]],
    )
    expect(versions.map((version) => version.model_key)).toEqual(
      [LEAVE_MODEL, ...OFFICE_MODELS].sort(),
    )
    for (const version of versions) {
      expect({ version: version.version, tenant_id: version.tenant_id }).toEqual({
        version: 1,
        tenant_id: t.id,
      })
      expect(version.tree_json).toMatchObject({
        next: { type: 'review', assignee: { kind: 'roles', ids: [role] } },
      })
    }
    expect(
      await ds.query(
        'SELECT enabled, timezone, location_mode, retention_days FROM oa_attendance_policy WHERE tenant_id = ?',
        [t.id],
      ),
    ).toEqual([
      { enabled: 1, timezone: 'Asia/Shanghai', location_mode: 'none', retention_days: 180 },
    ])
    for (const table of [
      'oa_trip_request',
      'oa_expense_claim',
      'oa_expense_item',
      'oa_seal_request',
      'oa_clock_record',
    ])
      expect(await one(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`, [t.id])).toEqual({
        n: 0,
      })
    expect(
      await ds.query(
        'SELECT id, username, dept_id, password_changed_at, enabled FROM iam_user WHERE tenant_id = ?',
        [t.id],
      ),
    ).toEqual([
      {
        id: t.ownerId,
        username: TENANT_OWNER,
        dept_id: dept,
        password_changed_at: null,
        enabled: 1,
      },
    ])
    expect(
      await ds.query('SELECT user_id, role_id FROM iam_user_roles WHERE tenant_id = ?', [t.id]),
    ).toEqual([{ user_id: t.ownerId, role_id: role }])
    expect(await one('SELECT owner_user_id FROM iam_tenant WHERE id = ?', [t.id])).toEqual({
      owner_user_id: t.ownerId,
    })
    const owner = await signInDirect(on, t.ownerId)
    expect(owner!.session).toMatchObject({ tenantId: t.id, tenantAdmin: true, root: false })
  })

  it('leaves nothing behind when a step fails: no tenant row, no seeded rows, no user', async () => {
    const provisioner = on.get(TenantProvisioner)
    const before = await counts()
    // over the user quota: the administrator does not fit
    const quota = provisioner.provision({
      code: `${PREFIX}quota`,
      name: 'quota',
      userQuota: 0,
      admin,
    })
    await expect(quota).rejects.toBeInstanceOf(BizError)
    await expect(quota).rejects.toMatchObject({ err: Err.IAM_TENANT_USER_QUOTA })
    expect(await counts()).toEqual(before)
    // the last write fails, after the administrator was made
    const query = EntityManager.prototype.query
    vi.spyOn(EntityManager.prototype, 'query').mockImplementation(function (
      this: EntityManager,
      sql,
      params,
    ) {
      if (sql.startsWith('UPDATE iam_tenant SET owner_user_id'))
        return Promise.reject(new Error('injected'))
      return query.call(this, sql, params)
    })
    await expect(
      provisioner.provision({ code: `${PREFIX}late`, name: 'late', admin }),
    ).rejects.toThrow('injected')
    expect(await counts()).toEqual(before)
  })

  it('stores the initial password only as a SecretBox box, hands it out once, and gives every tenant its own; the administrator signs in with it and must change it first', async () => {
    const b = await tenant()
    const c = await tenant()
    expect(b.initialPassword).not.toBe(c.initialPassword)
    const row = await one<{ enc: string; hash: string }>(
      `SELECT t.initial_password_enc AS enc, u.password_hash AS hash
         FROM iam_tenant t JOIN iam_user u ON u.id = t.owner_user_id WHERE t.id = ?`,
      [b.id],
    )
    expect(SecretBox.isBox(row.enc)).toBe(true)
    expect(row.enc).not.toContain(b.initialPassword)
    expect(on.get(SecretBox).decrypt(row.enc)).toBe(b.initialPassword)
    expect(await bcrypt.compare(b.initialPassword, row.hash)).toBe(true)
    // a later db:seed does not hand it out again
    expect((await runSeeds(ds, ['tenant'])).join('\n')).not.toContain(b.initialPassword)

    const res = await login(b.code, TENANT_OWNER, b.initialPassword).expect(200)
    const token = res.body.data.accessToken as string
    const me = await http().get('/api/auth/me').set(bearer(token)).expect(200)
    expect(me.body.data.flags.mustChangePassword).toBe(true)
    const users = await http().get('/api/iam/users').set(bearer(token))
    expect(users.body.code).toBe(Err.AUTH_PASSWORD_CHANGE_REQUIRED.code)
    // another tenant's administrator does not take it
    expect((await login(c.code, TENANT_OWNER, b.initialPassword)).body.code).toBe(
      Err.AUTH_BAD_CREDENTIALS.code,
    )
  })

  it("gives a user made without a password its tenant's initial password, not the default tenant's param nor another tenant's", async () => {
    const b = await tenant()
    const c = await tenant()
    const token = (await signIn(on, TENANT_OWNER, {}, b.id)).accessToken
    const username = `${PREFIX}new`
    await http()
      .post('/api/iam/users')
      .set(bearer(token))
      .send({ username, displayName: username })
      .expect(201)
    const param = await one<{ v: string }>(
      'SELECT param_value AS v FROM cfg_param WHERE param_key = ?',
      [USER_INITIAL_PASSWORD_PARAM],
    )
    for (const wrong of [param.v, c.initialPassword])
      expect((await login(b.code, username, wrong)).body.code).toBe(Err.AUTH_BAD_CREDENTIALS.code)
    await login(b.code, username, b.initialPassword).expect(200)
  })

  it("lets a user of the new tenant submit the leave page: the task goes to the tenant's tenant_admin holders", async () => {
    const b = await tenant()
    const dept = await rootDept(b.id)
    const { insertId } = await ds.query<{ insertId: number }>(
      "INSERT INTO iam_role (code, name, data_scope, tenant_id) VALUES (?, ?, 'own_dept', ?)",
      [`${PREFIX}leave`, `${PREFIX}leave`, b.id],
    )
    await ds.query(
      `INSERT INTO iam_role_menus (role_id, menu_id, tenant_id)
       SELECT ?, id, ? FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL`,
      [insertId, b.id, [leavePerms.browse, leavePerms.create]],
    )
    await addUser(on, b.id, `${PREFIX}emp`, { deptId: dept, roleId: Number(insertId) })
    const token = (await signIn(on, `${PREFIX}emp`, {}, b.id)).accessToken
    const res = await http()
      .post('/api/biz/leaves')
      .set(bearer(token))
      .send({
        leaveKind: 'annual',
        startAt: '2026-10-08T01:00:00.000Z',
        endAt: '2026-10-09T10:00:00.000Z',
        days: 2,
        reason: `${PREFIX}leave`,
      })
      .expect(201)
    expect(res.body.data.state).toBe('in_review')
    expect(
      await ds.query(
        `SELECT t.assignee_id, m.tenant_id FROM wf_task t
           JOIN wf_instance i ON i.id = t.instance_id
           JOIN wf_version v ON v.id = i.version_id
           JOIN wf_model m ON m.id = v.model_id
          WHERE t.instance_id = ? AND t.state = 'pending'`,
        [res.body.data.instanceId],
      ),
    ).toEqual([{ assignee_id: b.ownerId, tenant_id: b.id }])
  })
})
