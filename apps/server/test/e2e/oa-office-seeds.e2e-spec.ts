import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { oaExpensePerms, oaSealPerms, oaTripPerms, wfPerms, type WfBeginNode } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource, EntityManager } from 'typeorm'
import { DEFAULT_TENANT_ID, withTenant } from '../../src/core/context/tenant.js'
import { seedOaExpense } from '../../src/db/seeds/project/oa-expense.seed.js'
import { seedOaGeneric } from '../../src/db/seeds/project/oa-generic.seed.js'
import { seedOaOffice } from '../../src/db/seeds/project/oa-office.seed.js'
import { seedOaSeal } from '../../src/db/seeds/project/oa-seal.seed.js'
import { seedOaTrip } from '../../src/db/seeds/project/oa-trip.seed.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer } from '../setup/auth.js'
import { bootApp, createTenant, signInDirect, type TestTenant } from '../setup/tenants.js'

const KEYS = ['oa-trip', 'oa-expense', 'oa-seal', 'oa-generic']
const PERMS = [
  ...Object.values(oaTripPerms),
  ...Object.values(oaExpensePerms),
  ...Object.values(oaSealPerms),
]
const PAGES = [
  '/oa/office',
  ...['trip', 'expense', 'seal'].flatMap((kind) => [
    `/oa/${kind}`,
    `/oa/${kind}/new`,
    `/oa/${kind}/:id`,
  ]),
]
const SEEDS = [seedOaTrip, seedOaExpense, seedOaSeal, seedOaGeneric]
const EMPLOYEE_ROLES = ['staff', 'member']
let app: NestExpressApplication
let ds: DataSource
const tenants: TestTenant[] = []
let first: TestTenant
let second: TestTenant

interface ModelRow {
  id: number
  model_key: string
  enabled: number
  current_version_id: number | null
  draft_json: WfBeginNode
}
interface MenuRow {
  id: number
  parent_id: number
  kind: string
  route_path: string
  component: string
  component_name: string
  visible: number
  keep_alive: number
}

/** 默认租户和平台菜单的变更只留在当前连接内，断言结束一律回滚，避免影响其他测试。 */
async function rollback(tid: number, fn: (q: EntityManager) => Promise<void>) {
  const runner = ds.createQueryRunner()
  await runner.connect()
  await runner.startTransaction()
  try {
    await withTenant(tid, () => fn(runner.manager))
  } finally {
    await runner.rollbackTransaction()
    await runner.release()
  }
}

/** 同一入口在默认租户和客户租户内运行，不能借用另一个租户的角色或表单。 */
async function seedModels(q: EntityManager) {
  for (const seed of SEEDS) await seed(q)
}

/** 只移除事务内的办公夹具，模拟首次安装；真实行由 rollback 恢复。 */
async function freshModels(q: EntityManager, tid: number) {
  await q.query('DELETE FROM wf_version WHERE tenant_id = ? AND model_key IN (?)', [tid, KEYS])
  await q.query('DELETE FROM wf_model WHERE tenant_id = ? AND model_key IN (?)', [tid, KEYS])
  await q.query('DELETE FROM wf_form WHERE tenant_id = ? AND name = ?', [
    tid,
    'seed.oa.genericForm',
  ])
  await seedModels(q)
}

async function models(q: EntityManager, tid: number) {
  return q.query<ModelRow[]>(
    'SELECT id, model_key, enabled, current_version_id, draft_json FROM wf_model WHERE tenant_id = ? AND model_key IN (?) AND deleted_at IS NULL ORDER BY model_key',
    [tid, KEYS],
  )
}

/** 快照保留停用和软删行，才能发现初始化错误地复活或重发版本。 */
async function snapshot(q: EntityManager, tid: number) {
  const model = await q.query(
    'SELECT * FROM wf_model WHERE tenant_id = ? AND model_key IN (?) ORDER BY id',
    [tid, KEYS],
  )
  const version = await q.query(
    'SELECT * FROM wf_version WHERE tenant_id = ? AND model_key IN (?) ORDER BY id',
    [tid, KEYS],
  )
  const form = await q.query('SELECT * FROM wf_form WHERE tenant_id = ? AND name = ? ORDER BY id', [
    tid,
    'seed.oa.genericForm',
  ])
  return JSON.parse(JSON.stringify({ model, version, form })) as unknown
}

/** 四种新办公流程必须真正发布，并由所属租户的管理员角色明确办理。 */
async function expectSafePublished(q: EntityManager, tid: number, code: string) {
  const rows = await models(q, tid)
  expect(rows.map((row) => row.model_key)).toEqual([...KEYS].sort())
  const [role] = await q.query<{ id: number }[]>(
    'SELECT id FROM iam_role WHERE tenant_id = ? AND code = ? AND is_builtin = 1 AND deleted_at IS NULL',
    [tid, code],
  )
  expect(role).toBeDefined()
  for (const row of rows) {
    expect(row.enabled).toBe(1)
    expect(Number(row.current_version_id)).toBeGreaterThan(0)
    const [version] = await q.query<
      { tenant_id: number; model_id: number; version: number; tree_json: WfBeginNode }[]
    >(
      'SELECT tenant_id, model_id, version, tree_json FROM wf_version WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [row.current_version_id, tid],
    )
    expect(version).toMatchObject({ tenant_id: tid, model_id: row.id, version: 1 })
    expect(version!.tree_json).toEqual(row.draft_json)
    expect(version!.tree_json.next).toMatchObject({
      type: 'review',
      assignee: { kind: 'roles', ids: [role!.id] },
      whenNobody: 'toManager',
      whenInitiatorIsReviewer: 'self',
    })
  }
}

/** 仅删除事务内的平台页面；已有业务权限行留下，验证升级安装也会首次授予这些权限。 */
async function freshOffice(q: EntityManager) {
  await q.query('DELETE FROM iam_menu WHERE route_path IN (?)', [PAGES])
  await seedOaOffice(q)
  return q.query<MenuRow[]>(
    'SELECT id, parent_id, kind, route_path, component, component_name, visible, keep_alive FROM iam_menu WHERE route_path IN (?) AND deleted_at IS NULL ORDER BY route_path',
    [PAGES],
  )
}

/** 读取员工角色的全部有效授权，不能用预期菜单子集掩盖意外增加的管理权限。 */
async function employeeGrants(q: EntityManager): Promise<Record<string, number[]>> {
  const rows = await q.query<{ code: string; menu_id: number }[]>(
    'SELECT r.code, rm.menu_id FROM iam_role_menus rm JOIN iam_role r ON r.id = rm.role_id AND r.tenant_id = rm.tenant_id WHERE rm.tenant_id = ? AND r.code IN (?) AND rm.deleted_at IS NULL AND r.deleted_at IS NULL ORDER BY r.code, rm.menu_id',
    [DEFAULT_TENANT_ID, EMPLOYEE_ROLES],
  )
  return Object.fromEntries(
    EMPLOYEE_ROLES.map((code) => [
      code,
      rows.filter((row) => row.code === code).map((row) => Number(row.menu_id)),
    ]),
  )
}

/** 授权前后比较完整集合及精确差集，既发现越界授权，也发现旧授权被意外移除。 */
function expectGrantDifference(
  before: Record<string, number[]>,
  after: Record<string, number[]>,
  candidates: number[],
) {
  for (const code of EMPLOYEE_ROLES) {
    const old = before[code]!
    const expected = [...new Set([...old, ...candidates])].sort((a, b) => a - b)
    expect(after[code]).toEqual(expected)
    expect(after[code]!.filter((id) => !old.includes(id))).toEqual(
      expected.filter((id) => !old.includes(id)),
    )
  }
}

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  first = await createTenant(app)
  tenants.push(first)
  second = await createTenant(app)
  tenants.push(second)
  await ds.query('UPDATE iam_user SET password_changed_at = NOW(3) WHERE tenant_id IN (?, ?)', [
    first.id,
    second.id,
  ])
})
afterAll(async () => {
  for (const tenant of tenants.reverse()) await tenant.dispose()
  await app?.close()
})

it('makes all five office request types startable when a tenant is opened', async () => {
  for (const tenant of [first, second]) {
    const token = (await signInDirect(app, tenant.ownerId))!.accessToken
    const result = await request(app.getHttpServer())
      .get('/api/wf/startable-models')
      .set(bearer(token))
      .expect(200)
    expect(result.body.data.map((model: { modelKey: string }) => model.modelKey)).toEqual(
      expect.arrayContaining(['leave', ...KEYS]),
    )
    for (const key of ['leave', ...KEYS])
      await request(app.getHttpServer())
        .get(`/api/wf/models/${key}/start-info`)
        .set(bearer(token))
        .expect(200)
    await expectSafePublished(ds.manager, tenant.id, 'tenant_admin')
  }
})

it('publishes fresh default-tenant models with the local root role without changing another tenant', async () => {
  await rollback(DEFAULT_TENANT_ID, async (q) => {
    const foreign = await snapshot(q, first.id)
    await freshModels(q, DEFAULT_TENANT_ID)
    await expectSafePublished(q, DEFAULT_TENANT_ID, 'root')
    expect(await snapshot(q, first.id)).toEqual(foreign)
  })
})

it('requires an explicit decision from an initiator who also holds the reviewer role', async () => {
  const token = (await signInDirect(app, first.ownerId))!.accessToken
  const started = await request(app.getHttpServer())
    .post('/api/wf/instances')
    .set(bearer(token))
    .send({
      modelKey: 'oa-generic',
      formValues: {
        title: 'Office supplies',
        description: 'Replace the shared equipment',
        expectedDate: '2026-11-01',
        attachments: '',
      },
    })
    .expect(201)
  const instanceId = Number(started.body.data.id)
  const [instance] = await ds.query<{ state: string }[]>(
    'SELECT state FROM wf_instance WHERE id = ? AND tenant_id = ?',
    [instanceId, first.id],
  )
  expect(instance?.state).toBe('running')
  const tasks = await ds.query<{ assignee_id: number; state: string }[]>(
    'SELECT assignee_id, state FROM wf_task WHERE instance_id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [instanceId, first.id],
  )
  expect(tasks).toEqual([expect.objectContaining({ assignee_id: first.ownerId, state: 'pending' })])
})

it('refuses to start when the reviewer role has no active user instead of approving silently', async () => {
  const token = (await signInDirect(app, second.ownerId))!.accessToken
  await ds.query(
    'UPDATE iam_user_roles SET deleted_at = NOW(3) WHERE user_id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [second.ownerId, second.id],
  )
  const before = await ds.query(
    'SELECT id, state FROM wf_instance WHERE tenant_id = ? ORDER BY id',
    [second.id],
  )
  await request(app.getHttpServer())
    .post('/api/wf/instances')
    .set(bearer(token))
    .send({
      modelKey: 'oa-generic',
      formValues: {
        title: 'Meeting room',
        description: 'Reserve a meeting room',
        expectedDate: '2026-11-02',
        attachments: '',
      },
    })
    .expect(422)
  expect(
    await ds.query('SELECT id, state FROM wf_instance WHERE tenant_id = ? ORDER BY id', [
      second.id,
    ]),
  ).toEqual(before)
})

it('preserves customized unpublished, disabled and deleted models together with all existing versions', async () => {
  await rollback(first.id, async (q) => {
    const rows = await models(q, first.id)
    const byKey = new Map(rows.map((row) => [row.model_key, row]))
    await q.query(
      'UPDATE wf_model SET name = ?, current_version_id = NULL, draft_json = ? WHERE id = ? AND tenant_id = ?',
      [
        'Custom travel approval',
        JSON.stringify({ id: 'begin', type: 'begin', name: 'Custom start' }),
        byKey.get('oa-trip')!.id,
        first.id,
      ],
    )
    await q.query('UPDATE wf_model SET enabled = 0 WHERE id = ? AND tenant_id = ?', [
      byKey.get('oa-expense')!.id,
      first.id,
    ])
    await q.query('UPDATE wf_model SET deleted_at = NOW(3) WHERE id = ? AND tenant_id = ?', [
      byKey.get('oa-seal')!.id,
      first.id,
    ])
    const generic = byKey.get('oa-generic')!
    const version = await insertRow(q, 'wf_version', {
      model_id: generic.id,
      model_key: generic.model_key,
      version: 2,
      tree_json: generic.draft_json,
      form_snapshot: { fields: { customField: 'string' } },
    })
    await q.query(
      'UPDATE wf_model SET name = ?, current_version_id = ? WHERE id = ? AND tenant_id = ?',
      ['Custom general approval', version, generic.id, first.id],
    )
    const before = await snapshot(q, first.id)
    const foreign = await snapshot(q, second.id)
    await seedModels(q)
    await seedModels(q)
    expect(await snapshot(q, first.id)).toEqual(before)
    expect(await snapshot(q, second.id)).toEqual(foreign)
  })
})

it('adds the desktop pages with hidden create and detail routes and grants the business permissions once', async () => {
  await rollback(DEFAULT_TENANT_ID, async (q) => {
    // 即使全局初始化已误授管理权限，也把夹具还原为未授权，确保本次增量确实能抓住越权授权。
    await q.query(
      'DELETE FROM iam_role_menus WHERE tenant_id = ? AND role_id IN (SELECT id FROM iam_role WHERE tenant_id = ? AND code IN (?)) AND menu_id IN (SELECT id FROM iam_menu WHERE perms = ?)',
      [DEFAULT_TENANT_ID, DEFAULT_TENANT_ID, EMPLOYEE_ROLES, wfPerms.model.modify],
    )
    const before = await employeeGrants(q)
    const pages = await freshOffice(q)
    expect(pages).toHaveLength(10)
    const [group] = await q.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE route_name = ? AND deleted_at IS NULL',
      ['oa'],
    )
    const home = pages.find((page) => page.route_path === '/oa/office')!
    expect(home).toMatchObject({
      parent_id: group!.id,
      kind: 'page',
      component: 'oa/office/index',
      component_name: 'OaOffice',
      visible: 1,
    })
    for (const [kind, name] of [
      ['trip', 'OaTrip'],
      ['expense', 'OaExpense'],
      ['seal', 'OaSeal'],
    ]) {
      const list = pages.find((page) => page.route_path === `/oa/${kind}`)!
      expect(list).toMatchObject({
        parent_id: group!.id,
        component: `oa/${kind}/index`,
        component_name: name,
        visible: 1,
      })
      for (const [action, path, suffix] of [
        ['new', 'new', 'New'],
        ['view', ':id', 'View'],
      ])
        expect(pages.find((page) => page.route_path === `/oa/${kind}/${path}`)).toMatchObject({
          parent_id: list.id,
          component: `oa/${kind}/${action}`,
          component_name: `${name}${suffix}`,
          visible: 0,
          keep_alive: 0,
        })
    }
    const actions = await q.query<{ id: number; parent_id: number; perms: string }[]>(
      'SELECT id, parent_id, perms FROM iam_menu WHERE kind = ? AND perms IN (?) AND deleted_at IS NULL',
      ['action', PERMS],
    )
    expect(actions.map((action) => action.perms).sort()).toEqual([...PERMS].sort())
    expect(
      actions.every((action) =>
        [group!.id, ...pages.map((page) => page.id)].includes(action.parent_id),
      ),
    ).toBe(true)
    const expected = [
      group!.id,
      ...pages.map((page) => page.id),
      ...actions.map((action) => action.id),
    ].sort((a, b) => a - b)
    expectGrantDifference(before, await employeeGrants(q), expected)
  })
})

it('does not revive a removed office-group grant when a missing page is added later', async () => {
  await rollback(DEFAULT_TENANT_ID, async (q) => {
    const pages = await freshOffice(q)
    const [group] = await q.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE route_name = ? AND deleted_at IS NULL',
      ['oa'],
    )
    await q.query(
      'UPDATE iam_role_menus SET deleted_at = NOW(3) WHERE tenant_id = ? AND menu_id = ? AND role_id IN (SELECT id FROM iam_role WHERE tenant_id = ? AND code IN (?))',
      [DEFAULT_TENANT_ID, group!.id, DEFAULT_TENANT_ID, EMPLOYEE_ROLES],
    )
    const home = pages.find((page) => page.route_path === '/oa/office')!
    await q.query('DELETE FROM iam_menu WHERE id = ?', [home.id])
    const before = await employeeGrants(q)
    expect(EMPLOYEE_ROLES.every((code) => !before[code]!.includes(group!.id))).toBe(true)
    await seedOaOffice(q)
    const [added] = await q.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE route_path = ? AND deleted_at IS NULL',
      ['/oa/office'],
    )
    expect(added?.id).not.toBe(home.id)
    expectGrantDifference(before, await employeeGrants(q), [added!.id])
    const removed = await q.query<{ gone: number }[]>(
      'SELECT rm.deleted_at IS NOT NULL AS gone FROM iam_role_menus rm JOIN iam_role r ON r.id = rm.role_id AND r.tenant_id = rm.tenant_id WHERE rm.tenant_id = ? AND r.code IN (?) AND rm.menu_id = ?',
      [DEFAULT_TENANT_ID, EMPLOYEE_ROLES, group!.id],
    )
    expect(removed).toEqual([{ gone: 1 }, { gone: 1 }])
  })
})

it('does not grant an existing custom business page or its unassigned actions while adding other pages', async () => {
  await rollback(DEFAULT_TENANT_ID, async (q) => {
    await q.query('DELETE FROM iam_menu WHERE route_path IN (?)', [PAGES])
    const [group] = await q.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE route_name = ? AND deleted_at IS NULL',
      ['oa'],
    )
    const custom = await insertRow(q, 'iam_menu', {
      parent_id: group!.id,
      kind: 'page',
      route_name: 'oa-trip',
      route_path: '/oa/trip',
      component: 'oa/trip/index',
      component_name: 'OaTrip',
      name: 'Custom travel desk',
      sort_no: 808,
    })
    const actions = await q.query<{ id: number; perms: string }[]>(
      'SELECT id, perms FROM iam_menu WHERE kind = ? AND perms IN (?) AND deleted_at IS NULL',
      ['action', PERMS],
    )
    const tripActions = actions
      .filter((action) => Object.values(oaTripPerms).some((perm) => perm === action.perms))
      .map((action) => action.id)
    // 管理员从未给员工授权这些动作，硬删除事务夹具让错误的新增授权确实可被观察到。
    await q.query(
      'DELETE FROM iam_role_menus WHERE tenant_id = ? AND menu_id IN (?) AND role_id IN (SELECT id FROM iam_role WHERE tenant_id = ? AND code IN (?))',
      [DEFAULT_TENANT_ID, tripActions, DEFAULT_TENANT_ID, EMPLOYEE_ROLES],
    )
    const before = await employeeGrants(q)
    const [original] = await q.query('SELECT * FROM iam_menu WHERE id = ?', [custom])
    await seedOaOffice(q)
    expect((await q.query('SELECT * FROM iam_menu WHERE id = ?', [custom]))[0]).toEqual(original)
    const pages = await q.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE route_path IN (?) AND deleted_at IS NULL AND id <> ?',
      [PAGES, custom],
    )
    const after = await employeeGrants(q)
    expectGrantDifference(before, after, [
      group!.id,
      ...pages.map((page) => page.id),
      ...actions.filter((action) => !tripActions.includes(action.id)).map((action) => action.id),
    ])
    for (const code of EMPLOYEE_ROLES) {
      expect(after[code]).not.toContain(custom)
      expect(after[code]!.filter((id) => tripActions.includes(id))).toEqual([])
    }
  })
})

it('adds no office pages or grants below an office group deleted before installation', async () => {
  await rollback(DEFAULT_TENANT_ID, async (q) => {
    await q.query('DELETE FROM iam_menu WHERE route_path IN (?)', [PAGES])
    await q.query('UPDATE iam_menu SET deleted_at = NOW(3) WHERE route_name = ?', ['oa'])
    const before = await employeeGrants(q)
    const group = await q.query('SELECT * FROM iam_menu WHERE route_name = ?', ['oa'])
    await seedOaOffice(q)
    expect(await q.query('SELECT id FROM iam_menu WHERE route_path IN (?)', [PAGES])).toEqual([])
    expect(await q.query('SELECT * FROM iam_menu WHERE route_name = ?', ['oa'])).toEqual(group)
    expect(await employeeGrants(q)).toEqual(before)
  })
})

it('adds no missing child pages or grants below a deleted business page', async () => {
  await rollback(DEFAULT_TENANT_ID, async (q) => {
    const pages = await freshOffice(q)
    const trip = pages.find((page) => page.route_path === '/oa/trip')!
    await q.query('DELETE FROM iam_menu WHERE route_path IN (?)', [
      ['/oa/trip/new', '/oa/trip/:id'],
    ])
    await q.query('UPDATE iam_menu SET deleted_at = NOW(3) WHERE id = ?', [trip.id])
    const before = await employeeGrants(q)
    const parent = await q.query('SELECT * FROM iam_menu WHERE id = ?', [trip.id])
    await seedOaOffice(q)
    expect(
      await q.query('SELECT id FROM iam_menu WHERE route_path IN (?)', [
        ['/oa/trip/new', '/oa/trip/:id'],
      ]),
    ).toEqual([])
    expect(await q.query('SELECT * FROM iam_menu WHERE id = ?', [trip.id])).toEqual(parent)
    expect(await employeeGrants(q)).toEqual(before)
  })
})

it('does not revive removed grants, overwrite edited menus or change another tenant on a rerun', async () => {
  await rollback(DEFAULT_TENANT_ID, async (q) => {
    const pages = await freshOffice(q)
    const page = pages.find((row) => row.route_path === '/oa/trip')!
    const removed = pages.find((row) => row.route_path === '/oa/seal/new')!
    await q.query(
      'UPDATE iam_menu SET name = ?, visible = 0, enabled = 0, parent_id = 0, sort_no = 909 WHERE id = ?',
      ['Custom trip page', page.id],
    )
    await q.query('UPDATE iam_menu SET deleted_at = NOW(3) WHERE id = ?', [removed.id])
    await q.query(
      'UPDATE iam_role_menus SET deleted_at = NOW(3) WHERE tenant_id = ? AND menu_id = ? AND deleted_at IS NULL',
      [DEFAULT_TENANT_ID, page.id],
    )
    const beforePages = await q.query(
      'SELECT * FROM iam_menu WHERE route_path IN (?) ORDER BY id',
      [PAGES],
    )
    const beforeGrants = await q.query(
      'SELECT * FROM iam_role_menus WHERE tenant_id = ? AND menu_id IN (?) ORDER BY role_id, menu_id',
      [DEFAULT_TENANT_ID, pages.map((row) => row.id)],
    )
    const foreignGrants = await q.query(
      'SELECT * FROM iam_role_menus WHERE tenant_id = ? ORDER BY role_id, menu_id',
      [first.id],
    )
    await seedOaOffice(q)
    await seedOaOffice(q)
    expect(
      await q.query('SELECT * FROM iam_menu WHERE route_path IN (?) ORDER BY id', [PAGES]),
    ).toEqual(beforePages)
    expect(
      await q.query(
        'SELECT * FROM iam_role_menus WHERE tenant_id = ? AND menu_id IN (?) ORDER BY role_id, menu_id',
        [DEFAULT_TENANT_ID, pages.map((row) => row.id)],
      ),
    ).toEqual(beforeGrants)
    expect(
      await q.query('SELECT * FROM iam_role_menus WHERE tenant_id = ? ORDER BY role_id, menu_id', [
        first.id,
      ]),
    ).toEqual(foreignGrants)
  })
})
