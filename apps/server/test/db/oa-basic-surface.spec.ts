import { DataSource } from 'typeorm'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { OaBasicSurface20261026234705 } from '../../src/db/migrations/20261026234705-oa-basic-surface.js'
import { insertRow } from '../../src/db/seeds/upsert.js'

let ds: DataSource
const menus: number[] = []
const tasks: number[] = []
const packages: number[] = []

beforeAll(async () => {
  ds = await new DataSource(dataSourceOptions()).initialize()
})
afterAll(async () => {
  if (packages.length) {
    await ds.query('DELETE FROM iam_tenant_package_menus WHERE package_id IN (?)', [packages])
    await ds.query('DELETE FROM iam_tenant_package WHERE id IN (?)', [packages])
  }
  if (menus.length) {
    // qw:cross-tenant 测试清理自己插入的旧平台菜单引用，保留其他角色和菜单。
    await ds.query('DELETE FROM iam_role_menus WHERE menu_id IN (?)', [menus])
    await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [menus])
  }
  if (tasks.length) await ds.query('DELETE FROM job_task WHERE id IN (?)', [tasks])
  await ds?.destroy()
})

it('retires enabled legacy entry points and jobs without removing their metadata or unrelated grants', async () => {
  const page = await insertRow(ds.manager, 'iam_menu', {
    parent_id: 0,
    kind: 'page',
    route_name: 'oa-clock-records',
    route_path: '/oa/attendance',
    component: 'oa/attendance/index',
    name: 'test.legacy.clock',
    enabled: 1,
    visible: 1,
  })
  menus.push(page)
  const action = await insertRow(ds.manager, 'iam_menu', {
    parent_id: page,
    kind: 'action',
    perms: 'oa.clock.view',
    name: 'test.legacy.clock.view',
  })
  menus.push(action)
  const ordinary = await insertRow(ds.manager, 'iam_menu', {
    parent_id: 0,
    kind: 'page',
    route_name: 'test-basic-surface',
    route_path: '/test/basic',
    name: 'test.basic.surface',
  })
  menus.push(ordinary)
  const [{ id: role }] = await ds.query<{ id: number }[]>(
    "SELECT id FROM iam_role WHERE tenant_id = 1 AND code = 'member' AND deleted_at IS NULL",
  )
  await insertRow(ds.manager, 'iam_role_menus', { tenant_id: 1, role_id: role, menu_id: action })
  await insertRow(ds.manager, 'iam_role_menus', { tenant_id: 1, role_id: role, menu_id: ordinary })
  const packageId = await insertRow(ds.manager, 'iam_tenant_package', {
    name: 'test basic public surface',
  })
  packages.push(packageId)
  await ds.query(
    'INSERT INTO iam_tenant_package_menus (package_id, menu_id) VALUES (?, ?), (?, ?)',
    [packageId, action, packageId, ordinary],
  )
  const oldTask = await insertRow(ds.manager, 'job_task', {
    name: 'test legacy office retention',
    handler: 'oa.clock.retention',
    cron: '0 3 * * *',
    enabled: 1,
  })
  tasks.push(oldTask)
  const liveTask = await insertRow(ds.manager, 'job_task', {
    name: 'test ordinary retention',
    handler: 'test.basic.retention',
    cron: '0 4 * * *',
    enabled: 1,
  })
  tasks.push(liveTask)
  const before = await ds.query('SELECT * FROM job_task WHERE id = ?', [liveTask])
  const q = ds.createQueryRunner()
  try {
    const migration = new OaBasicSurface20261026234705()
    await migration.up(q)
    const retired = await ds.query<{ enabled: number; visible: number; deleted_at: Date }[]>(
      'SELECT enabled, visible, deleted_at FROM iam_menu WHERE id IN (?)',
      [[page, action]],
    )
    expect(retired).toHaveLength(2)
    for (const row of retired) {
      expect(row.enabled).toBe(0)
      expect(row.visible).toBe(0)
      expect(row.deleted_at).toBeInstanceOf(Date)
    }
    const [grant] = await ds.query<{ deleted_at: Date }[]>(
      'SELECT deleted_at FROM iam_role_menus WHERE tenant_id = 1 AND menu_id = ?',
      [action],
    )
    expect(grant.deleted_at).toBeInstanceOf(Date)
    const links = await ds.query<{ menu_id: number; deleted_at: Date | null }[]>(
      'SELECT menu_id, deleted_at FROM iam_tenant_package_menus WHERE package_id = ? ORDER BY menu_id',
      [packageId],
    )
    expect(links.find((link) => link.menu_id === action)?.deleted_at).toBeInstanceOf(Date)
    expect(links.find((link) => link.menu_id === ordinary)?.deleted_at).toBeNull()
    const [old] = await ds.query<{ enabled: number; deleted_at: Date }[]>(
      'SELECT enabled, deleted_at FROM job_task WHERE id = ?',
      [oldTask],
    )
    expect(old.enabled).toBe(0)
    expect(old.deleted_at).toBeInstanceOf(Date)
    expect(await ds.query('SELECT * FROM job_task WHERE id = ?', [liveTask])).toEqual(before)
    const [kept] = await ds.query<{ enabled: number; deleted_at: Date | null }[]>(
      'SELECT m.enabled, rm.deleted_at FROM iam_menu m JOIN iam_role_menus rm ON rm.menu_id=m.id WHERE rm.tenant_id=1 AND m.id=?',
      [ordinary],
    )
    expect(kept).toEqual({ enabled: 1, deleted_at: null })
    await migration.up(q)
    await migration.down()
    expect(
      (await ds.query('SELECT enabled FROM job_task WHERE id = ?', [oldTask]))[0].enabled,
    ).toBe(0)
  } finally {
    await q.release()
  }
})
