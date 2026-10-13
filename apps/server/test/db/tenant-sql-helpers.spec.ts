// The helpers that assemble raw SQL from table names (core/db/links.ts, core/db/references.ts,
// db/seeds/upsert.ts) against the test database, with a second tenant B (createTenant): a tenant table's
// rows are written, matched and pruned in the current tenant only; a platform row is referenced from
// every tenant, so its restrict checks and cascades see them all, and it is live for every tenant.
// Deletes run in a transaction this spec rolls back; the rows it sets up go in afterAll.
import { NotFoundException } from '@nestjs/common'
import { Err } from '@qiwu/shared'
import { DataSource, type EntityManager } from 'typeorm'
import { allTenants, DEFAULT_TENANT_ID, withTenant } from '../../src/core/context/tenant.js'
import { addLinks, type LinkTable, removeLinks, replaceLinks } from '../../src/core/db/links.js'
import { assertLive, referencedBy, softDeleteRows } from '../../src/core/db/references.js'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { findRow, insertRow, upsert } from '../../src/db/seeds/upsert.js'
import { createTenant, inTenant1, type TestTenant } from '../setup/tenants.js'

// the registrations of the modules owning these references (fs-object.entity.ts, provider.module.ts,
// iam.module.ts), repeated here without loading those modules (registering is idempotent)
referencedBy('fs_storage', { table: 'fs_object', column: 'storage_id' })
referencedBy('oauth_client', { table: 'oauth_consent', column: 'client_id', cascade: true })
referencedBy('iam_user', { table: 'iam_user_pref', column: 'user_id', cascade: true })

const USER_ROLES: LinkTable = { table: 'iam_user_roles', owner: 'user_id', target: 'role_id' }
const PACKAGE_MENUS: LinkTable = {
  table: 'iam_tenant_package_menus',
  owner: 'package_id',
  target: 'menu_id',
}
// ids no seeded row has: link rows need no live targets
const OWNER = 990_000_001
const OTHER_OWNER = 990_000_002
const ROLE = [990_000_011, 990_000_012, 990_000_013] as const
const PACKAGE = 990_000_021
const CODE = 'tenant-sql-helpers'
// roles B gets from the seed helpers (a new code each)
const B_CODES = [`${CODE}-b1`, `${CODE}-b2`]

let ds: DataSource
let B: TestTenant
let storageId: number
let clientId: number
let userId: number

const inB = <T>(fn: () => T): T => withTenant(B.id, fn)
const insert = async (sql: string, params: unknown[]) =>
  Number((await ds.query<{ insertId: number }>(sql, params)).insertId)

class Rollback extends Error {}
/** Runs `fn` in a transaction that is rolled back afterwards; returns what `fn` returned. */
async function rolledBack<T>(fn: (q: EntityManager) => Promise<T>): Promise<T> {
  let out: T | undefined
  await ds
    .transaction(async (q) => {
      out = await fn(q)
      throw new Rollback()
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e
    })
  return out as T
}

beforeAll(async () => {
  ds = await new DataSource(dataSourceOptions()).initialize()
  B = await createTenant(ds)
  storageId = await insert("INSERT INTO fs_storage (name, driver) VALUES (?, 'local')", [CODE])
  clientId = await insert(
    `INSERT INTO oauth_client (client_id, name, grant_types, redirect_uris, scopes, auto_approve_scopes)
     VALUES (?, ?, '[]', '[]', '[]', '[]')`,
    [CODE, CODE],
  )
  userId = await insert(
    'INSERT INTO iam_user (username, password_hash, display_name, tenant_id) VALUES (?, ?, ?, ?)',
    [CODE, 'not-used-by-this-spec', CODE, DEFAULT_TENANT_ID],
  )
})

afterAll(async () => {
  if (!ds?.isInitialized) return
  await B?.dispose()
  await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [[OWNER, OTHER_OWNER]])
  await ds.query('DELETE FROM iam_tenant_package_menus WHERE package_id = ?', [PACKAGE])
  await ds.query('DELETE FROM iam_user_pref WHERE user_id = ?', [userId ?? 0])
  await ds.query('DELETE FROM iam_user WHERE id = ?', [userId ?? 0])
  await ds.query('DELETE FROM iam_role WHERE code IN (?)', [[CODE, ...B_CODES]])
  await ds.query('DELETE FROM oauth_consent WHERE client_id = ?', [clientId ?? 0])
  await ds.query('DELETE FROM oauth_client WHERE id = ?', [clientId ?? 0])
  await ds.query('DELETE FROM fs_object WHERE storage_id = ?', [storageId ?? 0])
  await ds.query('DELETE FROM fs_storage WHERE id = ?', [storageId ?? 0])
  await ds.destroy()
})

describe('links.ts', () => {
  const links = (owner: number) =>
    ds.query<{ role: number; tenant: number; live: number }[]>(
      `SELECT role_id AS role, tenant_id AS tenant, deleted_at IS NULL AS live
         FROM iam_user_roles WHERE user_id = ? ORDER BY role_id`,
      [owner],
    )

  it("replaces and removes the current tenant's links only; a new link is the current tenant's", async () => {
    // one link of tenant 1 and one of B under the same owner id (B's pointing across tenants)
    await ds.query(
      'INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, ?), (?, ?, ?)',
      [OWNER, ROLE[0], DEFAULT_TENANT_ID, OWNER, ROLE[1], B.id],
    )
    await inTenant1(() => replaceLinks(ds.manager, USER_ROLES, OWNER, [ROLE[2]]))
    expect(await links(OWNER)).toEqual([
      { role: ROLE[0], tenant: DEFAULT_TENANT_ID, live: 0 },
      { role: ROLE[1], tenant: B.id, live: 1 },
      { role: ROLE[2], tenant: DEFAULT_TENANT_ID, live: 1 },
    ])
    await inTenant1(() => removeLinks(ds.manager, USER_ROLES, OWNER, [ROLE[1], ROLE[2]]))
    expect(await links(OWNER)).toEqual([
      { role: ROLE[0], tenant: DEFAULT_TENANT_ID, live: 0 },
      { role: ROLE[1], tenant: B.id, live: 1 },
      { role: ROLE[2], tenant: DEFAULT_TENANT_ID, live: 0 },
    ])
    await inB(() => replaceLinks(ds.manager, USER_ROLES, OTHER_OWNER, [ROLE[0]]))
    expect(await links(OTHER_OWNER)).toEqual([{ role: ROLE[0], tenant: B.id, live: 1 }])
  })

  it('a tenant link needs a tenant; a platform link table has none', async () => {
    await expect(
      allTenants(() => addLinks(ds.manager, USER_ROLES, OWNER, [ROLE[0]])),
    ).rejects.toThrow('allTenants has no single tenant')
    await inB(() => addLinks(ds.manager, PACKAGE_MENUS, PACKAGE, [1, 2]))
    await allTenants(() => removeLinks(ds.manager, PACKAGE_MENUS, PACKAGE, [2]))
    expect(
      await ds.query(
        'SELECT menu_id AS menu, deleted_at IS NULL AS live FROM iam_tenant_package_menus WHERE package_id = ? ORDER BY menu_id',
        [PACKAGE],
      ),
    ).toEqual([
      { menu: 1, live: 1 },
      { menu: 2, live: 0 },
    ])
  })
})

describe('references.ts', () => {
  const removeStorage = () =>
    rolledBack((q) => inTenant1(() => softDeleteRows(q, 'fs_storage', [storageId])))

  it("a platform row's restrict check sees the references of every tenant (409)", async () => {
    await expect(removeStorage()).resolves.toBeUndefined()
    await insert(
      `INSERT INTO fs_object (storage_id, object_key, original_name, mime, size, biz_tag, uploader_id, tenant_id)
       VALUES (?, ?, 'b.txt', 'text/plain', 1, 'test', 1, ?)`,
      [storageId, `${CODE}/b.txt`, B.id],
    )
    await expect(removeStorage()).rejects.toMatchObject({ err: Err.IN_USE })
  })

  it("a platform row's cascade reaches every tenant; a tenant row's the current tenant only", async () => {
    const until = new Date(Date.now() + 86_400_000)
    await ds.query(
      `INSERT INTO oauth_consent (user_id, client_id, scope, expires_at, tenant_id)
       VALUES (?, ?, 'profile', ?, ?), (?, ?, 'profile', ?, ?)`,
      [userId, clientId, until, DEFAULT_TENANT_ID, OWNER, clientId, until, B.id],
    )
    const consents = await rolledBack(async (q) => {
      await inTenant1(() => softDeleteRows(q, 'oauth_client', [clientId]))
      return q.query(
        'SELECT tenant_id AS tenant, deleted_at IS NULL AS live FROM oauth_consent WHERE client_id = ? ORDER BY tenant_id',
        [clientId],
      )
    })
    expect(consents).toEqual([
      { tenant: DEFAULT_TENANT_ID, live: 0 },
      { tenant: B.id, live: 0 },
    ])

    // a preference of B naming the user of tenant 1 (data that crosses tenants) stays
    await ds.query(
      `INSERT INTO iam_user_pref (user_id, pref_key, value, tenant_id)
       VALUES (?, 'mine', '{}', ?), (?, 'other', '{}', ?)`,
      [userId, DEFAULT_TENANT_ID, userId, B.id],
    )
    const prefs = await rolledBack(async (q) => {
      await inTenant1(() => softDeleteRows(q, 'iam_user', [userId]))
      return q.query(
        'SELECT pref_key AS k, deleted_at IS NULL AS live FROM iam_user_pref WHERE user_id = ? ORDER BY pref_key',
        [userId],
      )
    })
    expect(prefs).toEqual([
      { k: 'mine', live: 0 },
      { k: 'other', live: 1 },
    ])
  })

  it("assertLive: a tenant row must be the current tenant's, a platform row is everyone's", async () => {
    await expect(
      inB(() => assertLive(ds.manager, 'fs_storage', storageId)),
    ).resolves.toBeUndefined()
    await expect(
      inTenant1(() => assertLive(ds.manager, 'iam_user', userId)),
    ).resolves.toBeUndefined()
    await expect(inB(() => assertLive(ds.manager, 'iam_user', userId))).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })
})

describe('upsert.ts', () => {
  const roles = () =>
    ds.query<{ id: number; tenant: number; name: string }[]>(
      'SELECT id, tenant_id AS tenant, name FROM iam_role WHERE code = ? ORDER BY tenant_id',
      [CODE],
    )

  it("matches and inserts the current tenant's rows of a tenant table, or the tenant the caller names", async () => {
    const theirs = await insert(
      "INSERT INTO iam_role (code, name, data_scope, tenant_id) VALUES (?, 'theirs', 'own_rows', ?)",
      [CODE, B.id],
    )
    const mine = await inTenant1(() =>
      upsert(ds.manager, 'iam_role', { code: CODE }, { name: 'mine' }, { data_scope: 'own_rows' }),
    )
    expect(mine).not.toBe(theirs)
    expect(await roles()).toEqual([
      { id: mine, tenant: DEFAULT_TENANT_ID, name: 'mine' },
      { id: theirs, tenant: B.id, name: 'theirs' },
    ])
    expect(await inTenant1(() => findRow(ds.manager, 'iam_role', { code: CODE }))).toEqual({
      id: mine,
      deleted: false,
    })
    expect(await inB(() => findRow(ds.manager, 'iam_role', { code: CODE }))).toEqual({
      id: theirs,
      deleted: false,
    })
    // a tenant named by the caller wins over the context's
    await inTenant1(() =>
      upsert(ds.manager, 'iam_role', { code: CODE, tenant_id: B.id }, { name: 'renamed' }),
    )
    expect((await roles()).map((r) => r.name)).toEqual(['mine', 'renamed'])
    await expect(allTenants(() => findRow(ds.manager, 'iam_role', { code: CODE }))).rejects.toThrow(
      'allTenants has no single tenant',
    )
  })

  it("a new row of a tenant table is the current tenant's, not the column default's (tenant 1)", async () => {
    const upserted = await inB(() =>
      upsert(
        ds.manager,
        'iam_role',
        { code: B_CODES[0] },
        { name: 'b1' },
        { data_scope: 'own_rows' },
      ),
    )
    const inserted = await inB(() =>
      insertRow(ds.manager, 'iam_role', { code: B_CODES[1], name: 'b2', data_scope: 'own_rows' }),
    )
    expect(
      await ds.query(
        'SELECT id, tenant_id AS tenant FROM iam_role WHERE code IN (?) ORDER BY code',
        [B_CODES],
      ),
    ).toEqual([
      { id: upserted, tenant: B.id },
      { id: inserted, tenant: B.id },
    ])
  })

  it("a platform table's rows are everyone's: no tenant in the key nor in a new row", async () => {
    const id = await inTenant1(() =>
      insertRow(ds.manager, 'iam_tenant_package_menus', { package_id: PACKAGE, menu_id: 3 }),
    )
    expect(id).toBe(0)
    expect(await inB(() => findRow(ds.manager, 'oauth_client', { client_id: CODE }))).toEqual({
      id: clientId,
      deleted: false,
    })
  })
})
