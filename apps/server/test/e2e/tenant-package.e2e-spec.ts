// Tenant packages (see docs/design-notes.md#tenancy), with two apps on one database: `on`
// (APP_MULTI_TENANT=true) and `off`. A package is the set of menus a tenant other than the default one may
// use, enforced where a session is loaded: its users' perms are their roles' grants within it (minus the
// platform's), its tenant_admin holds the whole of it, `/menus` and `/me.features` show only what it
// reaches and `@RequireFeature` routes outside it are no routes (404). Without a package, or with a
// disabled one, a tenant uses nothing. The role grant tree of such a tenant keeps to its package; grants
// outside it stay without effect and count again once the package holds them again. The default tenant is
// never limited. Package writes (menus, enabled) reach signed-in users at their next request.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  deptPerms,
  dictPerms,
  Err,
  type MenuNode,
  type MePayload,
  menuPerms,
  type RoleMenuNode,
  type TenantPackageDetailVo,
  type TenantPackageVo,
  tenantPerms,
  userPerms,
  wfPerms,
} from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
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

const PREFIX = 'tpk-'
const BASE = '/api/iam/tenant-packages'

let on: NestExpressApplication
let off: NestExpressApplication
let ds: DataSource
let redis: Redis
/** every live menu open to tenants; the workflow group with everything under it */
let open: number[]
let workflow: number[]
/** every menu open to tenants but the workflow's */
let noWorkflow: TestPackage
/** B: package `noWorkflow`, `member` granted a workflow perm and the user list */
let B: PeopledTenant
/** C: no package */
let C: TestTenant
/** the default tenant: a user granted a workflow perm, its role */
let aUser: number
let aRole: number
const madeMenus: number[] = []
/** default-tenant roles of `platformUser` */
const madeRoles: number[] = []

const http = (app: NestExpressApplication = on) => request(app.getHttpServer())
const tokenOf = async (userId: number) => (await signInDirect(on, userId))!.accessToken
const call = (
  method: 'get' | 'post' | 'put' | 'delete',
  url: string,
  token: string,
  app: NestExpressApplication = on,
) => http(app)[method](url).set(bearer(token)).set('Accept-Language', 'en-US')
const rootToken = async () => (await signIn(on)).accessToken
const menuOf = async (perms: string) =>
  Number(
    (
      await ds.query<{ id: number }[]>(
        'SELECT id FROM iam_menu WHERE perms = ? AND deleted_at IS NULL LIMIT 1',
        [perms],
      )
    )[0]!.id,
  )
const grant = (roleId: number, tenantId: number, perms: string[]) =>
  ds.query(
    `INSERT INTO iam_role_menus (role_id, menu_id, tenant_id)
     SELECT ?, id, ? FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL`,
    [roleId, tenantId, perms],
  )
/** A token of a new default-tenant user of scope `all`, granted the menus carrying `perms`. */
const platformUser = async (perms: string[]) => {
  const code = `${PREFIX}r${madeRoles.length}`
  const { insertId } = await ds.query<{ insertId: number }>(
    "INSERT INTO iam_role (code, name, data_scope, tenant_id) VALUES (?, ?, 'all', 1)",
    [code, code],
  )
  const roleId = Number(insertId)
  madeRoles.push(roleId)
  await grant(roleId, 1, perms)
  return tokenOf(await addUser(on, 1, `${PREFIX}u${roleId}`, { roleId }))
}
/** A live action (or, `kind` given, a page) under menu `parentId`, deleted with `drop`. */
const probeMenu = (parentId: number, name: string, perms: string, kind = 'action') =>
  insertRow(ds.manager, 'iam_menu', { parent_id: parentId, kind, name: `${PREFIX}${name}`, perms })
const drop = async (menus: number[]) => {
  for (const t of ['iam_role_menus', 'iam_tenant_package_menus'])
    await ds.query(`DELETE FROM ${t} WHERE menu_id IN (?)`, [menus])
  await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [menus])
}
const pageOf = async (routeName: string) =>
  Number(
    (
      await ds.query<{ id: number }[]>(
        'SELECT id FROM iam_menu WHERE route_name = ? AND deleted_at IS NULL',
        [routeName],
      )
    )[0]!.id,
  )
/** Every route name of a menu forest. */
const routes = (nodes: MenuNode[]): string[] =>
  nodes.flatMap((n) => [...(n.routeName ? [n.routeName] : []), ...routes(n.children)])
/** Every id of a grant tree. */
const ids = (nodes: RoleMenuNode[]): number[] => nodes.flatMap((n) => [n.id, ...ids(n.children)])
const sorted = (list: Iterable<number>) => [...list].sort((a, b) => a - b)
const meOf = async (token: string) =>
  (await call('get', '/api/auth/me', token).expect(200)).body.data as MePayload
const menusOf = async (token: string) =>
  (await call('get', '/api/auth/menus', token).expect(200)).body.data as MenuNode[]
const permVerAll = async () => (await redis.get(redisKey('authPermVer', 'all'))) ?? '0'
/** The live menu ids of package `id`. */
const packageMenus = async (id: number) =>
  sorted(
    (
      await ds.query<{ menu_id: number }[]>(
        'SELECT menu_id FROM iam_tenant_package_menus WHERE package_id = ? AND deleted_at IS NULL',
        [id],
      )
    ).map((r) => Number(r.menu_id)),
  )

beforeAll(async () => {
  on = await bootApp({ multiTenant: true })
  off = await bootApp({ multiTenant: false })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get<Redis>(REDIS)
  open = (
    await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE platform_only = 0 AND deleted_at IS NULL',
    )
  ).map((r) => Number(r.id))
  workflow = (
    await ds.query<{ id: number }[]>(
      `SELECT m.id FROM iam_menu m
         JOIN iam_menu g ON g.route_name = 'workflow' AND g.parent_id = 0 AND g.deleted_at IS NULL
        WHERE m.tree_path LIKE CONCAT('/', g.id, '/%') AND m.deleted_at IS NULL`,
    )
  ).map((r) => Number(r.id))
  if (workflow.length < 2) throw new Error('the workflow menus are missing')
  noWorkflow = await createPackage(on, { menuIds: open.filter((id) => !workflow.includes(id)) })
  B = await createTenant(on, { users: true, packageId: noWorkflow.id })
  await grant(B.roleId, B.id, [wfPerms.model.browse, userPerms.browse])
  C = await createTenant(on, { packageId: null })
  const { insertId } = await ds.query<{ insertId: number }>(
    "INSERT INTO iam_role (code, name, data_scope, tenant_id) VALUES (?, ?, 'all', 1)",
    [`${PREFIX}wf`, `${PREFIX}wf`],
  )
  aRole = Number(insertId)
  await grant(aRole, 1, [wfPerms.model.browse])
  aUser = await addUser(on, 1, `${PREFIX}a-user`, { roleId: aRole })
})

afterAll(async () => {
  if (ds) {
    await B?.dispose()
    await C?.dispose()
    await noWorkflow?.dispose()
    // the packages made through the API (soft-deleted ones too)
    await ds.query(
      `DELETE pm FROM iam_tenant_package_menus pm JOIN iam_tenant_package p ON p.id = pm.package_id
        WHERE p.name LIKE ?`,
      [`${PREFIX}%`],
    )
    await ds.query('DELETE FROM iam_tenant_package WHERE name LIKE ?', [`${PREFIX}%`])
    if (madeMenus.length) {
      await ds.query('DELETE FROM iam_tenant_package_menus WHERE menu_id IN (?)', [madeMenus])
      await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [madeMenus])
    }
    for (const role of [aRole, ...madeRoles].filter(Boolean)) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [role])
      await ds.query('DELETE FROM iam_user_roles WHERE role_id = ?', [role])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [role])
    }
    await ds.query('DELETE FROM iam_user WHERE username LIKE ? AND tenant_id = 1', [`${PREFIX}%`])
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
  await off?.close()
})

describe('a package without the workflow', () => {
  it("leaves B's users no workflow: no group in /menus or /me.features, its perm routes 403, its feature routes 404; the default tenant as before", async () => {
    const alice = await tokenOf(B.users.alice)
    expect(routes(await menusOf(alice))).not.toContain('workflow')
    expect(routes(await menusOf(alice))).toContain('iam-user')
    const me = await meOf(alice)
    expect(me.perms).toContain(userPerms.browse)
    expect(me.perms).not.toContain(wfPerms.model.browse)
    expect(me.features).not.toContain('workflow')
    expect(me.features).toContain('system')
    await call('get', '/api/iam/users?page=1&pageSize=1', alice).expect(200)
    expect((await call('get', '/api/wf/models?page=1&pageSize=1', alice)).status).toBe(403)
    const todo = await call('get', '/api/wf/tasks/todo', alice)
    expect(todo.status).toBe(404)
    expect(todo.body.code).toBe(Err.NOT_FOUND.code)
    // its tenant_admin holds the package, nothing of the workflow
    const owner = await tokenOf(B.ownerId)
    const ownMe = await meOf(owner)
    expect(ownMe.perms).toContain(userPerms.browse)
    expect(ownMe.perms.filter((p) => p.startsWith('wf.'))).toEqual([])
    expect(routes(await menusOf(owner))).not.toContain('workflow')
    expect((await call('get', '/api/wf/tasks/todo', owner)).status).toBe(404)
    // the default tenant: no package, nothing limited
    const a = await tokenOf(aUser)
    await call('get', '/api/wf/models?page=1&pageSize=1', a).expect(200)
    await call('get', '/api/wf/tasks/todo', a).expect(200)
    expect(routes(await menusOf(a))).toContain('workflow')
    expect((await meOf(a)).features).toContain('workflow')
  })
})

describe("B's role grants", () => {
  it('the grant tree is the package, never a platform menu; a menu outside it is refused (404), nothing stored', async () => {
    const owner = await tokenOf(B.ownerId)
    const tree = (await call('get', '/api/iam/roles/menu-tree', owner).expect(200)).body
      .data as RoleMenuNode[]
    expect(sorted(ids(tree))).toEqual(await packageMenus(noWorkflow.id))
    const wfMenu = await menuOf(wfPerms.model.browse)
    const grants = () =>
      ds.query(
        'SELECT menu_id FROM iam_role_menus WHERE role_id = ? AND tenant_id = ? AND deleted_at IS NULL ORDER BY menu_id',
        [B.roleId, B.id],
      )
    const before = await grants()
    const res = await call('put', `/api/iam/roles/${B.roleId}/menus`, owner).send({
      menuLink: true,
      menuIds: [await menuOf(userPerms.browse), wfMenu],
    })
    expect(res.status).toBe(404)
    expect(await grants()).toEqual(before)
    // the default tenant's tree: every menu, the workflow's and the platform's too
    const rootTree = ids(
      (await call('get', '/api/iam/roles/menu-tree', await rootToken()).expect(200)).body.data,
    )
    expect(rootTree).toEqual(expect.arrayContaining([wfMenu, await menuOf(dictPerms.browse)]))
    await call('put', `/api/iam/roles/${aRole}/menus`, await rootToken())
      .send({ menuLink: false, menuIds: [wfMenu, await menuOf(dictPerms.browse)] })
      .expect(200)
  })

  it('its tenant_admin hands tenant_admin on: the role holds the package, which it holds itself', async () => {
    const owner = await tokenOf(B.ownerId)
    const adminRole = Number(
      (
        await ds.query<{ id: number }[]>(
          "SELECT id FROM iam_role WHERE code = 'tenant_admin' AND is_builtin = 1 AND tenant_id = ?",
          [B.id],
        )
      )[0]!.id,
    )
    const bob = await addUser(on, B.id, `${PREFIX}bob`, { deptId: B.deptId })
    await call('put', `/api/iam/users/${bob}/roles`, owner)
      .send({ roleIds: [adminRole] })
      .expect(200)
    const second = await signInDirect(on, bob)
    expect(second!.session).toMatchObject({ tenantAdmin: true, root: false })
    expect([...second!.session.perms].sort()).toEqual([...(await meOf(owner)).perms].sort())
  })

  it('grants outside a narrowed package stay without effect and count again once it is widened, also after the role was edited meanwhile', async () => {
    const D = await createTenant(on, { users: true })
    try {
      await grant(D.roleId, D.id, [userPerms.browse, deptPerms.browse])
      const userMenu = await menuOf(userPerms.browse)
      const deptMenu = await menuOf(deptPerms.browse)
      const alice = await tokenOf(D.users.alice)
      const root = await rootToken()
      await call('get', '/api/iam/users?page=1&pageSize=1', alice).expect(200)
      // narrowed: the user list is out; alice's next request knows it
      await call('put', `${BASE}/${D.packageId}`, root)
        .send({ menuIds: open.filter((id) => id !== userMenu) })
        .expect(200)
      expect((await call('get', '/api/iam/users?page=1&pageSize=1', alice)).status).toBe(403)
      await call('get', '/api/iam/depts', alice).expect(200)
      // the role edited meanwhile: what it shows and takes back is within the package
      const owner = await tokenOf(D.ownerId)
      const shown = (await call('get', `/api/iam/roles/${D.roleId}/menus`, owner).expect(200)).body
        .data as { menuIds: number[] }
      expect(shown.menuIds).toEqual([deptMenu])
      await call('put', `/api/iam/roles/${D.roleId}/menus`, owner)
        .send({ menuLink: false, menuIds: [deptMenu] })
        .expect(200)
      // widened again: the old grant counts again
      await call('put', `${BASE}/${D.packageId}`, root).send({ menuIds: open }).expect(200)
      await call('get', '/api/iam/users?page=1&pageSize=1', alice).expect(200)
    } finally {
      await D.dispose()
    }
  })

  it('a deleted menu leaves no row in any package', async () => {
    const userPage = Number(
      (
        await ds.query<{ id: number }[]>(
          "SELECT id FROM iam_menu WHERE route_name = 'iam-user' AND deleted_at IS NULL",
        )
      )[0]!.id,
    )
    const probe = await insertRow(ds.manager, 'iam_menu', {
      parent_id: userPage,
      kind: 'action',
      name: `${PREFIX}probe`,
      perms: 'tpk.probe.run',
    })
    madeMenus.push(probe)
    const root = await rootToken()
    const made = (
      await call('post', BASE, root)
        .send({ name: `${PREFIX}probe`, menuIds: [userPage, probe] })
        .expect(201)
    ).body.data as TenantPackageVo
    expect(await packageMenus(made.id)).toEqual(sorted([userPage, probe]))
    await call('delete', `/api/iam/menus/${probe}`, root).expect(200)
    expect(await packageMenus(made.id)).toEqual([userPage])
    await call('delete', `${BASE}/${made.id}`, root).expect(200)
  })

  it('a menu edit by a non-root platform administrator judges them within the package: a perm only a grant outside it carries is still a new one (403)', async () => {
    const twin = 'tpk.twin.run'
    const userPage = await pageOf('iam-user')
    const outside = await probeMenu(userPage, 'twin-out', twin)
    const inside = await probeMenu(userPage, 'twin-in', 'tpk.twin.old')
    try {
      await ds.query('INSERT INTO iam_tenant_package_menus (package_id, menu_id) VALUES (?, ?)', [
        noWorkflow.id,
        inside,
      ])
      await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES ?', [
        [outside, inside].map((m) => [B.roleId, m, B.id]),
      ])
      const editor = await platformUser([menuPerms.browse, menuPerms.modify, twin])
      const res = await call('put', `/api/iam/menus/${inside}`, editor).send({ perms: twin })
      expect(res.status).toBe(403)
      expect(res.body.code).toBe(Err.IAM_GRANT_EXCEEDS_OWN.code)
      const [row] = await ds.query<{ perms: string }[]>('SELECT perms FROM iam_menu WHERE id = ?', [
        inside,
      ])
      expect(row!.perms).toBe('tpk.twin.old')
    } finally {
      await drop([outside, inside])
    }
  })

  it('a package holding a button but not the menus above it: its tenant_admin holds the button’s perm, never one of a menu above', async () => {
    // a page carrying a perm (the API writes none on a page, an older row may hold one)
    const page = await probeMenu(await pageOf('iam-user'), 'page', 'tpk.page.run', 'page')
    const button = await probeMenu(page, 'button', 'tpk.page.button')
    const pkg = await createPackage(on, { menuIds: [button] })
    const T = await createTenant(on, { packageId: pkg.id })
    try {
      const perms = (await signInDirect(on, T.ownerId))!.session.perms
      expect(perms).toContain('tpk.page.button')
      expect(perms).not.toContain('tpk.page.run')
      expect(perms).not.toContain(userPerms.browse)
    } finally {
      await T.dispose()
      await pkg.dispose()
      await drop([button, page])
    }
  })
})

describe('no package or a disabled one', () => {
  it('a session of another tenant with no feature set recorded has none (404), not every one', async () => {
    const F = await createTenant(on)
    try {
      const s = (await signInDirect(on, F.ownerId))!
      await call('get', '/api/wf/tasks/todo', s.accessToken).expect(200)
      const key = redisKey('authSession', s.session.sid)
      const stored = JSON.parse((await redis.get(key))!) as Record<string, unknown>
      delete stored.features
      await redis.set(key, JSON.stringify(stored), { KEEPTTL: true })
      expect((await call('get', '/api/wf/tasks/todo', s.accessToken)).status).toBe(404)
    } finally {
      await F.dispose()
    }
  })

  it('a tenant without a package uses nothing: no perm, no menu, no feature, its tenant_admin neither', async () => {
    const owner = await signInDirect(on, C.ownerId)
    expect(owner!.session).toMatchObject({ tenantAdmin: true, perms: [], features: [] })
    expect(await menusOf(owner!.accessToken)).toEqual([])
    expect((await meOf(owner!.accessToken)).features).toEqual([])
    expect((await call('get', '/api/wf/tasks/todo', owner!.accessToken)).status).toBe(404)
    expect((await call('get', '/api/iam/users?page=1&pageSize=1', owner!.accessToken)).status).toBe(
      403,
    )
  })

  it('a disabled package opens nothing: disabling and enabling it reach signed-in users at their next request; it leaves /options', async () => {
    const E = await createTenant(on)
    try {
      const root = await rootToken()
      const owner = await tokenOf(E.ownerId)
      await call('get', '/api/iam/users?page=1&pageSize=1', owner).expect(200)
      const options = async () =>
        (
          (await call('get', `${BASE}/options`, root).expect(200)).body.data as { id: number }[]
        ).map((o) => o.id)
      expect(await options()).toContain(E.packageId)
      const before = await permVerAll()
      await call('put', `${BASE}/${E.packageId}`, root).send({ enabled: false }).expect(200)
      expect(await permVerAll()).not.toBe(before)
      expect((await call('get', '/api/iam/users?page=1&pageSize=1', owner)).status).toBe(403)
      expect((await call('get', '/api/wf/tasks/todo', owner)).status).toBe(404)
      const me = await meOf(owner)
      expect(me.perms).toEqual([])
      expect(me.features).toEqual([])
      expect(await menusOf(owner)).toEqual([])
      expect(await options()).not.toContain(E.packageId)
      const disabled = await permVerAll()
      await call('put', `${BASE}/${E.packageId}`, root).send({ enabled: true }).expect(200)
      expect(await permVerAll()).not.toBe(disabled)
      await call('get', '/api/iam/users?page=1&pageSize=1', owner).expect(200)
      expect((await meOf(owner)).features).toContain('workflow')
    } finally {
      await E.dispose()
    }
  })
})

describe('the package API', () => {
  it('holds live menus open to tenants only (platform-only 422, unknown 404, nothing stored), names once (409), deletes a package no tenant uses (in use 409)', async () => {
    const root = await rootToken()
    const userMenu = await menuOf(userPerms.browse)
    const platformMenu = await menuOf(dictPerms.browse)
    const refused = await call('post', BASE, root).send({
      name: `${PREFIX}api`,
      menuIds: [userMenu, platformMenu],
    })
    expect(refused.status).toBe(422)
    expect(refused.body.code).toBe(Err.IAM_TENANT_PACKAGE_PLATFORM_MENU.code)
    expect(
      await ds.query('SELECT id FROM iam_tenant_package WHERE name = ?', [`${PREFIX}api`]),
    ).toEqual([])
    expect((await call('post', BASE, root).send({ name: '', menuIds: [userMenu] })).status).toBe(
      400,
    )
    const made = (
      await call('post', BASE, root)
        .send({ name: `${PREFIX}api`, note: 'n', menuIds: [userMenu] })
        .expect(201)
    ).body.data as TenantPackageVo
    expect(made).toMatchObject({ name: `${PREFIX}api`, enabled: true, note: 'n', tenantCount: 0 })
    expect(
      (await call('post', BASE, root).send({ name: `${PREFIX}api`, menuIds: [] })).body.code,
    ).toBe(Err.DUPLICATE.code)
    const detail = async (id: number) =>
      (await call('get', `${BASE}/${id}`, root).expect(200)).body.data as TenantPackageDetailVo
    expect((await detail(made.id)).menuIds).toEqual([userMenu])
    const changed = await call('put', `${BASE}/${made.id}`, root).send({
      menuIds: [platformMenu],
    })
    expect(changed.body.code).toBe(Err.IAM_TENANT_PACKAGE_PLATFORM_MENU.code)
    expect(
      (await call('put', `${BASE}/${made.id}`, root).send({ menuIds: [2 ** 31] })).status,
    ).toBe(404)
    expect((await detail(made.id)).menuIds).toEqual([userMenu])
    expect((await call('get', `${BASE}/${2 ** 31}`, root)).status).toBe(404)
    // the list, with the tenants using each package
    const page = (await call('get', `${BASE}?page=1&pageSize=50&name=${PREFIX}`, root).expect(200))
      .body.data as { items: TenantPackageVo[] }
    expect(page.items.map((p) => p.name)).toEqual([`${PREFIX}api`])
    // a sample package's name is a key (seed.tenantPackage.*): found by the text users see, in any language
    const sample = await insertRow(ds.manager, 'iam_tenant_package', {
      name: 'seed.tenantPackage.noWorkflow',
    })
    try {
      for (const term of ['无审批', 'no approvals']) {
        const found = (
          await call(
            'get',
            `${BASE}?page=1&pageSize=50&name=${encodeURIComponent(term)}`,
            root,
          ).expect(200)
        ).body.data as { items: TenantPackageVo[] }
        expect(found.items.map((p) => p.id)).toEqual([sample])
      }
    } finally {
      await ds.query('DELETE FROM iam_tenant_package WHERE id = ?', [sample])
    }
    expect((await detail(noWorkflow.id)).tenantCount).toBe(1)
    // in use: kept
    const inUse = await call('delete', `${BASE}/${noWorkflow.id}`, root)
    expect(inUse.status).toBe(409)
    expect(inUse.body.code).toBe(Err.IN_USE.code)
    expect(await packageMenus(noWorkflow.id)).not.toEqual([])
    await call('delete', `${BASE}/${made.id}`, root).expect(200)
    expect((await call('get', `${BASE}/${made.id}`, root)).status).toBe(404)
    expect(await packageMenus(made.id)).toEqual([])
  })

  it('offers its options to whoever opens or edits tenants too: a default-tenant user holding only the tenant create perm', async () => {
    const opener = await platformUser([tenantPerms.create])
    await call('get', `${BASE}/options`, opener).expect(200)
    expect((await call('get', BASE, opener)).status).toBe(403)
  })

  it('offers every menu open to tenants as its grant tree, no platform one', async () => {
    const tree = (await call('get', `${BASE}/menu-tree`, await rootToken()).expect(200)).body
      .data as RoleMenuNode[]
    expect(sorted(ids(tree))).toEqual(sorted(open))
  })

  it('is the platform’s: a user of B (its tenant_admin too) 403, a default-tenant user without the perms 403; switch off: no route', async () => {
    for (const token of [
      await tokenOf(B.ownerId),
      await tokenOf(B.users.alice),
      await tokenOf(aUser),
    ])
      for (const path of [BASE, `${BASE}/options`, `${BASE}/menu-tree`, `${BASE}/${noWorkflow.id}`])
        expect((await call('get', path, token)).status).toBe(403)
    const owner = await tokenOf(B.ownerId)
    expect(
      (await call('put', `${BASE}/${noWorkflow.id}`, owner).send({ menuIds: open })).status,
    ).toBe(403)
    expect((await call('delete', `${BASE}/${noWorkflow.id}`, owner)).status).toBe(403)
    expect((await call('post', BASE, owner).send({ name: `${PREFIX}b`, menuIds: [] })).status).toBe(
      403,
    )
    const root = (await signIn(off)).accessToken
    expect((await call('get', BASE, root, off)).status).toBe(404)
    expect(
      (await call('post', BASE, root, off).send({ name: `${PREFIX}off`, menuIds: [] })).status,
    ).toBe(404)
  })
})
