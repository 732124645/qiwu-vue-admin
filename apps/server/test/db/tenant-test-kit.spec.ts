// The tenant test kit (test/setup/tenants.ts, test/setup/auth.ts): createTenant gives every tenant its own
// id and code (opened as the product opens one), dispose removes every row of the tenant (tenant tables
// and fixture tables alike) and the tenant itself, and signIn takes the user of the tenant asked for
// (multi-tenancy on: off, only the default tenant's users sign in). Every tenant gets a package of its own
// unless told otherwise; createPackage makes one for a spec.
import type { INestApplication } from '@nestjs/common'
import { getDataSourceToken } from '@nestjs/typeorm'
import type { DataSource } from 'typeorm'
import { createScopedNoteTables, dropScopedNoteTables } from '../fixtures/scoped-note/setup.js'
import { signIn } from '../setup/auth.js'
import { addRow, bootApp, createPackage, createTenant, type TestTenant } from '../setup/tenants.js'

let app: INestApplication
let ds: DataSource
let fixturesExisted = false
const made: TestTenant[] = []

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  fixturesExisted = (await ds.query("SHOW TABLES LIKE 'test_scoped_note'")).length > 0
  await createScopedNoteTables(ds)
})

afterAll(async () => {
  if (!ds) return
  for (const t of made) await t.dispose()
  if (!fixturesExisted) await dropScopedNoteTables(ds)
  await app.close()
})

const tenant = async () => {
  const t = await createTenant(app)
  made.push(t)
  return t
}
const insert = async (sql: string, params: unknown[]) =>
  Number((await ds.query<{ insertId: number }>(sql, params)).insertId)
/** A user of tenant `tid` (raw SQL, so its tenant is explicit). */
const user = (username: string, tid: number) =>
  insert(
    'INSERT INTO iam_user (username, password_hash, display_name, tenant_id) VALUES (?, ?, ?, ?)',
    [username, 'not-used-by-this-spec', username, tid],
  )
const rowsOf = async (table: string, tid: number) =>
  // table names are this spec's own constants
  Number((await ds.query(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`, [tid]))[0].n)

it('every tenant gets its own id and a code from the spec file name', async () => {
  const a = await tenant()
  const b = await tenant()
  expect(b.id).not.toBe(a.id)
  expect(b.code).not.toBe(a.code)
  for (const t of [a, b]) {
    expect(t.id).toBeGreaterThan(1)
    expect(t.code).toMatch(/^t-tenant-test-kit-\d+$/)
    expect(t.code).toMatch(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/)
  }
  const rows = await ds.query('SELECT code, enabled FROM iam_tenant WHERE id IN (?) ORDER BY id', [
    [a.id, b.id],
  ])
  expect(rows).toEqual([
    { code: a.code, enabled: 1 },
    { code: b.code, enabled: 1 },
  ])
})

it('dispose deletes the rows of the tenant in tenant and fixture tables, then the tenant', async () => {
  const t = await tenant()
  const before = await rowsOf('iam_user', 1)
  // what opening it made: its administrator with the tenant_admin role, its process models
  const opened = { iam_user: 1, iam_role: 1, iam_user_roles: 1 }
  expect(await rowsOf('wf_model', t.id)).toBeGreaterThan(0)
  const userId = await user('kit-user', t.id)
  const roleId = await insert(
    'INSERT INTO iam_role (code, name, data_scope, tenant_id) VALUES (?, ?, ?, ?)',
    ['kit-role', 'kit-role', 'all', t.id],
  )
  await ds.query('INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, ?)', [
    userId,
    roleId,
    t.id,
  ])
  await insert('INSERT INTO test_dept (tree_path, name, tenant_id) VALUES (?, ?, ?)', [
    '/1/',
    'kit',
    t.id,
  ])
  const noteId = await insert('INSERT INTO test_scoped_note (title, tenant_id) VALUES (?, ?)', [
    'kit',
    t.id,
  ])
  await ds.query('INSERT INTO test_note_link (note_id, target_id, tenant_id) VALUES (?, ?, ?)', [
    noteId,
    noteId,
    t.id,
  ])
  const tables = [
    'iam_user',
    'iam_role',
    'iam_user_roles',
    'test_dept',
    'test_scoped_note',
    'test_note_link',
  ]
  const counts = async () =>
    Object.fromEntries(await Promise.all(tables.map(async (n) => [n, await rowsOf(n, t.id)])))
  expect(await counts()).toEqual(
    Object.fromEntries(tables.map((n) => [n, 1 + (opened[n as keyof typeof opened] ?? 0)])),
  )

  await t.dispose()
  expect(await counts()).toEqual(Object.fromEntries(tables.map((n) => [n, 0])))
  expect(await rowsOf('wf_model', t.id)).toBe(0)
  expect(await ds.query('SELECT id FROM iam_tenant WHERE id = ?', [t.id])).toEqual([])
  expect(await rowsOf('iam_user', 1)).toBe(before)
})

it("a peopled tenant holds the default tenant's dept, role, position and process model under the same names; addRow writes the tenant asked for", async () => {
  const b = await createTenant(app, { users: true })
  made.push(b)
  // the tenants holding a row `where` of `table` (this spec's constants), of the default one and b
  const holders = async (table: string, where: string) =>
    (
      await ds.query(
        `SELECT DISTINCT tenant_id FROM ${table} WHERE ${where} AND tenant_id IN (1, ?) ORDER BY tenant_id`,
        [b.id],
      )
    ).map((r: { tenant_id: number }) => Number(r.tenant_id))
  expect(await holders('iam_dept', "name = 'seed.dept.hq'")).toEqual([1, b.id])
  expect(await holders('iam_role', "code = 'member'")).toEqual([1, b.id])
  expect(
    await holders('iam_position', "code = 'developer' AND name = 'seed.position.developer'"),
  ).toEqual([1, b.id])
  expect(await holders('wf_model', "model_key = 'leave'")).toEqual([1, b.id])
  expect(
    await ds.query('SELECT user_id, tenant_id FROM iam_user_positions WHERE position_id = ?', [
      b.positionId,
    ]),
  ).toEqual([{ user_id: b.users.alice, tenant_id: b.id }])
  const pos = await addRow(app, b.id, 'iam_position', { code: 'kit-pos', name: 'kit-pos' })
  expect(await ds.query('SELECT tenant_id FROM iam_position WHERE id = ?', [pos])).toEqual([
    { tenant_id: b.id },
  ])
})

it("signIn takes the user of the tenant asked for: the default tenant's unless told otherwise", async () => {
  const b = await tenant()
  const otherAdmin = await user('admin', b.id)
  const [{ id: admin }] = await ds.query(
    "SELECT id FROM iam_user WHERE username = 'admin' AND tenant_id = 1 AND deleted_at IS NULL",
  )
  expect((await signIn(app)).session.userId).toBe(Number(admin))
  expect((await signIn(app, 'admin', {}, b.id)).session.userId).toBe(otherAdmin)
})

it('a tenant gets a package of its own opening every live menu open to tenants, gone with it; one asked for (or none) is used as is', async () => {
  const menusOf = async (pkg: number) =>
    (
      await ds.query<{ menu_id: number }[]>(
        'SELECT menu_id FROM iam_tenant_package_menus WHERE package_id = ? ORDER BY menu_id',
        [pkg],
      )
    ).map((r) => Number(r.menu_id))
  const packageOf = async (tid: number) => {
    const [row] = await ds.query<{ package_id: number | null }[]>(
      'SELECT package_id FROM iam_tenant WHERE id = ?',
      [tid],
    )
    return row!.package_id === null ? null : Number(row!.package_id)
  }
  const packages = async (ids: number[]) =>
    (
      await ds.query<{ id: number; name: string; enabled: number }[]>(
        'SELECT id, name, enabled FROM iam_tenant_package WHERE id IN (?) ORDER BY id',
        [ids],
      )
    ).map((r) => ({ ...r, id: Number(r.id) }))
  const open = (
    await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE platform_only = 0 AND deleted_at IS NULL ORDER BY id',
    )
  ).map((r) => Number(r.id))
  const a = await createTenant(app)
  const own = a.packageId!
  expect(await packageOf(a.id)).toBe(own)
  expect(await menusOf(own)).toEqual(open)
  expect(await packages([own])).toEqual([
    { id: own, name: expect.stringMatching(/^p-tenant-test-kit-\d+$/), enabled: 1 },
  ])
  const none = await createTenant(app, { packageId: null })
  expect(none.packageId).toBeNull()
  expect(await packageOf(none.id)).toBeNull()
  const p = await createPackage(app, { menuIds: open.slice(0, 1), enabled: false })
  const c = await createTenant(app, { packageId: p.id })
  expect(await packageOf(c.id)).toBe(p.id)
  expect(await packages([p.id])).toEqual([{ id: p.id, name: p.name, enabled: 0 }])
  expect(await menusOf(p.id)).toEqual(open.slice(0, 1))
  for (const t of [a, none, c]) await t.dispose()
  // the tenant's own package went with it; the one the spec made stays the spec's
  expect(await packages([own, p.id])).toEqual([{ id: p.id, name: p.name, enabled: 0 }])
  expect(await menusOf(own)).toEqual([])
  await p.dispose()
  expect(await packages([p.id])).toEqual([])
  expect(await menusOf(p.id)).toEqual([])
})
