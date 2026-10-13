// Root, tenant administrators and protected users with tenants (see docs/design-notes.md#tenancy), with
// two apps on one database: `on` (APP_MULTI_TENANT=true) and `off`. Root is the default tenant's builtin
// root role held by a user of the default tenant (both rows checked). Tenant B has its builtin
// `tenant_admin` role (held by its owner `admin` and by `boss`): every menu open to tenants, never a
// platform one, not root; inside B it is B's root for the data-scope grant rules, and the role row is kept
// like root's. Protected users (root users, the owner, `tenant_admin` holders) are written, disabled,
// deleted and kicked only as the rules say, whoever holds the perms (`ops`). Root lists and kicks the
// sessions of its own tenant only.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  dictPerms,
  Err,
  type ErrorDef,
  type MenuNode,
  menuPerms,
  rolePerms,
  sessionPerms,
  type SessionVo,
  signupParams,
  userPerms,
} from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { rootRole } from '../../src/modules/platform/iam/iam-user-lookup.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import {
  addUser,
  bootApp,
  createTenant,
  type PeopledTenant,
  signInDirect,
} from '../setup/tenants.js'

const PREFIX = 'tro-'
const NEW_PASSWORD = 'TenantRoot#2026-new'

let on: NestExpressApplication
let off: NestExpressApplication
let ds: DataSource
let redis: Redis
let B: PeopledTenant
let C: PeopledTenant
/** B's builtin tenant_admin role, its user administrator role, a second dept */
let adminRole: number
let opsRole: number
let dept2: number
/** B: the owner (B.users.admin) and `boss` hold tenant_admin; `ops` administers users; `carol` is plain */
let boss: number
let ops: number
let carol: number
/** the default tenant: a user, a menu editor (not root) and its role, a disabled probe menu */
let aUser: number
let editor: number
let editorRole: number
let probeMenu: number
const menus: number[] = []

const http = (app: NestExpressApplication = on) => request(app.getHttpServer())
const tokenOf = async (userId: number, app: NestExpressApplication = on) =>
  (await signInDirect(app, userId))!.accessToken
const call = (
  method: 'get' | 'post' | 'put' | 'delete',
  url: string,
  token: string,
  app: NestExpressApplication = on,
) => http(app)[method](url).set(bearer(token)).set('Accept-Language', 'en-US')
/** The status and code of an answer, to compare with an error (or `{ status: 200, code: 0 }`). */
const outcome = (res: request.Response) => ({ status: res.status, code: res.body.code as unknown })
const as = (e: ErrorDef) => ({ status: e.status, code: e.code })
const OK = { status: 200, code: 0 }
/** Grants role `roleId` of tenant `tenantId` the action menus carrying `perms`. */
const grant = (roleId: number, tenantId: number, perms: string[]) =>
  ds.query(
    `INSERT INTO iam_role_menus (role_id, menu_id, tenant_id)
     SELECT ?, id, ? FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL`,
    [roleId, tenantId, perms],
  )
const insertRole = async (
  tenantId: number,
  code: string,
  o: { scope?: string; builtin?: boolean; name?: string } = {},
) =>
  Number(
    (
      await ds.query<{ insertId: number }>(
        'INSERT INTO iam_role (code, name, data_scope, is_builtin, tenant_id) VALUES (?, ?, ?, ?, ?)',
        [code, o.name ?? `${PREFIX}${code}`, o.scope ?? 'all', o.builtin ? 1 : 0, tenantId],
      )
    ).insertId,
  )
const hold = (userId: number, roleId: number, tenantId: number) =>
  ds.query('INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, ?)', [
    userId,
    roleId,
    tenantId,
  ])
/** Every route name of a menu forest. */
const routes = (nodes: MenuNode[]): string[] =>
  nodes.flatMap((n) => [...(n.routeName ? [n.routeName] : []), ...routes(n.children)])
const platformRoutes = async () =>
  new Set(
    (
      await ds.query<{ route_name: string }[]>(
        `SELECT route_name FROM iam_menu
          WHERE platform_only = 1 AND route_name IS NOT NULL AND deleted_at IS NULL`,
      )
    ).map((r) => r.route_name),
  )
const platformPerms = async () =>
  new Set(
    (
      await ds.query<{ perms: string }[]>(
        `SELECT DISTINCT perms FROM iam_menu
          WHERE platform_only = 1 AND perms IS NOT NULL AND perms <> '' AND deleted_at IS NULL`,
      )
    ).map((r) => r.perms),
  )
const menuOf = async (perms: string) =>
  Number(
    (
      await ds.query<{ id: number }[]>(
        'SELECT id FROM iam_menu WHERE perms = ? AND deleted_at IS NULL LIMIT 1',
        [perms],
      )
    )[0]!.id,
  )
/** The live sessions root's online list shows (`app`), as sid → user id. */
async function listed(token: string, app: NestExpressApplication = on) {
  const res = await call('get', '/api/iam/sessions?page=1&pageSize=200', token, app).expect(200)
  return new Map((res.body.data.items as SessionVo[]).map((s) => [s.sid, s.userId]))
}

beforeAll(async () => {
  on = await bootApp({ multiTenant: true })
  off = await bootApp({ multiTenant: false })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  await cleanRedis(redis)
  B = await createTenant(on, { users: true })
  C = await createTenant(on, { users: true })
  // B's admin role as provisioning made it, held by its `admin` too, made the owner
  adminRole = Number(
    (
      await ds.query<{ id: number }[]>(
        "SELECT id FROM iam_role WHERE code = 'tenant_admin' AND is_builtin = 1 AND tenant_id = ?",
        [B.id],
      )
    )[0]!.id,
  )
  await hold(B.users.admin, adminRole, B.id)
  await ds.query('UPDATE iam_tenant SET owner_user_id = ? WHERE id = ?', [B.users.admin, B.id])
  boss = await addUser(on, B.id, 'boss', { deptId: B.deptId, roleId: adminRole })
  opsRole = await insertRole(B.id, `${PREFIX}ops`)
  await grant(opsRole, B.id, [
    userPerms.browse,
    userPerms.view,
    userPerms.modify,
    userPerms.remove,
    userPerms['reset-password'],
    userPerms['assign-roles'],
    sessionPerms.browse,
    sessionPerms.kick,
    rolePerms.browse,
    rolePerms.create,
    rolePerms.grant,
    rolePerms['assign-users'],
  ])
  ops = await addUser(on, B.id, 'ops', { deptId: B.deptId, roleId: opsRole })
  carol = await addUser(on, B.id, 'carol', { deptId: B.deptId })
  const { insertId } = await ds.query<{ insertId: number }>(
    'INSERT INTO iam_dept (parent_id, tree_path, name, tenant_id) VALUES (?, ?, ?, ?)',
    [B.deptId, `/${B.deptId}/`, `${PREFIX}dept2`, B.id],
  )
  dept2 = Number(insertId)
  await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ?', [
    `/${B.deptId}/${dept2}/`,
    dept2,
  ])
  // C's admin creates roles
  await grant(C.roleId, C.id, [rolePerms.browse, rolePerms.create])
  // the default tenant
  aUser = await addUser(on, 1, `${PREFIX}a-user`)
  editorRole = await insertRole(1, `${PREFIX}editor`)
  await grant(editorRole, 1, [menuPerms.browse, menuPerms.modify])
  editor = await addUser(on, 1, `${PREFIX}editor`, { roleId: editorRole })
  const userPage = Number(
    (
      await ds.query<{ id: number }[]>(
        "SELECT id FROM iam_menu WHERE route_name = 'iam-user' AND deleted_at IS NULL",
      )
    )[0]!.id,
  )
  probeMenu = await insertRow(ds.manager, 'iam_menu', {
    parent_id: userPage,
    kind: 'action',
    name: `${PREFIX}probe`,
    perms: 'tro.probe.run',
    enabled: 0,
  })
  menus.push(probeMenu)
  // a new menu is in no package: B's takes it, as its menus open to tenants
  await ds.query('INSERT INTO iam_tenant_package_menus (package_id, menu_id) VALUES (?, ?)', [
    B.packageId,
    probeMenu,
  ])
})

afterAll(async () => {
  if (ds) {
    await B?.dispose()
    await C?.dispose()
    await ds.query('UPDATE iam_tenant SET owner_user_id = NULL WHERE id = 1')
    if (menus.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE menu_id IN (?)', [menus])
      await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [menus])
    }
    if (editorRole) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [editorRole])
      await ds.query('DELETE FROM iam_user_roles WHERE role_id = ?', [editorRole])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [editorRole])
    }
    await ds.query(
      'DELETE ur FROM iam_user_roles ur JOIN iam_user u ON u.id = ur.user_id WHERE u.username LIKE ? AND u.tenant_id = 1',
      [`${PREFIX}%`],
    )
    await ds.query('DELETE FROM iam_user WHERE username LIKE ? AND tenant_id = 1', [`${PREFIX}%`])
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
  await off?.close()
})

describe('root is the default tenant’s', () => {
  it('only the default tenant’s builtin root role held by a user of the default tenant is root', () => {
    const role = { code: 'root', is_builtin: 1, tenant_id: 1 }
    expect(rootRole(1, role)).toBe(true)
    // a link across tenants slipping through: neither side alone makes a root
    expect(rootRole(2, role)).toBe(false)
    expect(rootRole(1, { ...role, tenant_id: 2 })).toBe(false)
    expect(rootRole(2, { ...role, tenant_id: 2 })).toBe(false)
    expect(rootRole(1, { ...role, is_builtin: 0 })).toBe(false)
    expect(rootRole(1, { ...role, code: 'tenant_admin' })).toBe(false)
  })

  it('a builtin root role of another tenant (made by hand) makes no root', async () => {
    const forged = await insertRole(B.id, 'root', { builtin: true })
    try {
      await hold(B.users.alice, forged, B.id)
      const issued = await signInDirect(on, B.users.alice)
      expect(issued!.session).toMatchObject({ root: false })
      expect(issued!.session.perms).not.toContain('*')
    } finally {
      await ds.query('DELETE FROM iam_user_roles WHERE role_id = ?', [forged])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [forged])
    }
  })

  it('a tenant administrator gives no builtin root role of its own tenant (made by hand) to anyone (403)', async () => {
    const forged = await insertRole(B.id, 'root', { builtin: true })
    try {
      const owner = await tokenOf(B.users.admin)
      expect(
        outcome(
          await call('post', `/api/iam/roles/${forged}/members`, owner).send({
            userIds: [B.users.alice],
          }),
        ),
      ).toEqual(as(Err.IAM_GRANT_EXCEEDS_OWN))
      expect(
        await ds.query('SELECT user_id FROM iam_user_roles WHERE role_id = ?', [forged]),
      ).toEqual([])
    } finally {
      await ds.query('DELETE FROM iam_user_roles WHERE role_id = ?', [forged])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [forged])
    }
  })

  it('the default tenant’s root is as before, switch on or off: root, every menu, its own sessions', async () => {
    for (const app of [on, off]) {
      const root = (await signIn(app)).accessToken
      const me = (await call('get', '/api/auth/me', root, app).expect(200)).body.data
      expect(me.perms).toEqual(['*'])
      const shown = routes((await call('get', '/api/auth/menus', root, app).expect(200)).body.data)
      expect(shown).toEqual(expect.arrayContaining(['iam-menu', 'iam-user', 'settings-dict']))
      const target = await signInDirect(app, aUser)
      const sessions = await listed(root, app)
      expect(sessions.get(target!.session.sid)).toBe(aUser)
      expect(
        outcome(await call('delete', `/api/iam/sessions/${target!.session.sid}`, root, app)),
      ).toEqual(OK)
      expect(
        outcome(
          await call('put', `/api/iam/users/${aUser}/password`, root, app).send({
            password: NEW_PASSWORD,
          }),
        ),
      ).toEqual(OK)
      expect(
        outcome(
          await call('put', `/api/iam/roles/${editorRole}/data-scope`, root, app).send({
            dataScope: 'all',
            deptLink: true,
            deptIds: [],
          }),
        ),
      ).toEqual(OK)
      // kicking a user that does not exist: unknown like any user out of reach
      expect(
        outcome(await call('post', '/api/iam/sessions/kick', root, app).send({ userId: 999_999 })),
      ).toEqual(as(Err.NOT_FOUND))
    }
    // a default-tenant user other than root still sees the platform pages its roles grant
    const shown = routes(
      (await call('get', '/api/auth/menus', await tokenOf(editor)).expect(200)).body.data,
    )
    expect(shown).toContain('iam-menu')
  })

  it('another tenant reaches no role of the default tenant through its members (404)', async () => {
    const owner = await tokenOf(B.users.admin)
    const [rootRow] = await ds.query<{ id: number }[]>(
      "SELECT id FROM iam_role WHERE code = 'root' AND is_builtin = 1 AND tenant_id = 1",
    )
    // the sign-up role (a role of the default tenant) answers alike: no 403 telling it apart
    const [signup] = await ds.query<{ param_value: string }[]>(
      'SELECT param_value FROM cfg_param WHERE param_key = ?',
      [signupParams.defaultRoleId],
    )
    const signupRole = Number(signup!.param_value)
    expect(signupRole).toBeGreaterThan(0)
    for (const roleId of [Number(rootRow!.id), editorRole, signupRole]) {
      expect(outcome(await call('get', `/api/iam/roles/${roleId}/members`, owner))).toEqual(
        as(Err.NOT_FOUND),
      )
      for (const path of ['members', 'members/revoke'])
        expect(
          outcome(
            await call('post', `/api/iam/roles/${roleId}/${path}`, owner).send({
              userIds: [B.users.alice],
            }),
          ),
        ).toEqual(as(Err.NOT_FOUND))
    }
  })

  it('root lists and kicks no session of another tenant (404)', async () => {
    const root = (await signIn(on)).accessToken
    const b = await signInDirect(on, carol)
    const sessions = await listed(root)
    expect([...sessions.values()].filter((id) => id === carol)).toEqual([])
    expect(sessions.size).toBeGreaterThan(0)
    expect(outcome(await call('delete', `/api/iam/sessions/${b!.session.sid}`, root))).toEqual(
      as(Err.NOT_FOUND),
    )
    expect(
      outcome(await call('post', '/api/iam/sessions/kick', root).send({ sids: [b!.session.sid] })),
    ).toEqual(as(Err.NOT_FOUND))
    expect(
      outcome(await call('post', '/api/iam/sessions/kick', root).send({ userId: carol })),
    ).toEqual(as(Err.NOT_FOUND))
    // still live: B's own admin sees and ends it
    const owner = await tokenOf(B.users.admin)
    expect((await listed(owner)).get(b!.session.sid)).toBe(carol)
    expect(outcome(await call('delete', `/api/iam/sessions/${b!.session.sid}`, owner))).toEqual(OK)
  })
})

describe('the tenant administrator', () => {
  it('is no root: no platform perm nor platform menu, platform routes 403', async () => {
    const owner = await tokenOf(B.users.admin)
    const me = (await call('get', '/api/auth/me', owner).expect(200)).body.data
    expect(me.roles).toContain('tenant_admin')
    expect(me.perms).not.toContain('*')
    expect(me.perms).toEqual(expect.arrayContaining([userPerms.browse, rolePerms.grant]))
    const platform = await platformPerms()
    expect(platform.size).toBeGreaterThan(0)
    expect((me.perms as string[]).filter((p) => platform.has(p))).toEqual([])
    const shown = routes((await call('get', '/api/auth/menus', owner).expect(200)).body.data)
    expect(shown).toEqual(expect.arrayContaining(['iam-user', 'iam-role', 'iam-session']))
    const platformPages = await platformRoutes()
    expect(shown.filter((r) => platformPages.has(r))).toEqual([])
    expect((await call('get', '/api/settings/dicts', owner)).status).toBe(403)
    expect((await call('get', '/api/iam/menus', owner)).status).toBe(403)
  })

  it('roles B makes with the codes root or tenant_admin are not builtin: no root, no tenant admin', async () => {
    const owner = await tokenOf(B.users.admin)
    const made = await call('post', '/api/iam/roles', owner)
      .send({ name: `${PREFIX}fake-root`, code: 'root', isBuiltin: true })
      .expect(201)
    const fakeRoot = Number(made.body.data.id)
    expect(made.body.data.isBuiltin).toBe(false)
    expect(
      outcome(
        await call('post', `/api/iam/roles/${fakeRoot}/members`, owner).send({
          userIds: [B.users.alice],
        }),
      ),
    ).toEqual(OK)
    const alice = await signInDirect(on, B.users.alice)
    expect(alice!.session).toMatchObject({ root: false, tenantAdmin: false })
    expect(alice!.session.perms).toEqual([])
    // the builtin one holds the code in every opened tenant: C's is set aside so its admin can make one
    await ds.query(
      "UPDATE iam_role SET deleted_at = NOW(3) WHERE code = 'tenant_admin' AND is_builtin = 1 AND tenant_id = ?",
      [C.id],
    )
    const cAdmin = await tokenOf(C.users.admin)
    const fake = await call('post', '/api/iam/roles', cAdmin)
      .send({ name: `${PREFIX}fake-admin`, code: 'tenant_admin', isBuiltin: true })
      .expect(201)
    expect(fake.body.data.isBuiltin).toBe(false)
    await hold(C.users.alice, Number(fake.body.data.id), C.id)
    const cAlice = await signInDirect(on, C.users.alice)
    expect(cAlice!.session).toMatchObject({ root: false, tenantAdmin: false })
    // only what C's `member` role was granted: the role named tenant_admin adds nothing
    expect([...cAlice!.session.perms].sort()).toEqual([rolePerms.browse, rolePerms.create].sort())
    const owned = await signInDirect(on, B.users.admin)
    expect(owned!.session).toMatchObject({ root: false, tenantAdmin: true })
  })

  it('gives tenant_admin to a second person and makes `all` roles; a user administrator does neither', async () => {
    const owner = await tokenOf(B.users.admin)
    const opsToken = await tokenOf(ops)
    // a stray grant row on the admin role is never its perms: what it holds comes from the menus
    await grant(adminRole, B.id, [dictPerms.browse])
    expect(
      outcome(
        await call('put', `/api/iam/users/${carol}/roles`, opsToken).send({
          roleIds: [adminRole],
        }),
      ),
    ).toEqual(as(Err.IAM_GRANT_EXCEEDS_OWN))
    expect(
      outcome(
        await call('put', `/api/iam/users/${carol}/roles`, owner).send({ roleIds: [adminRole] }),
      ),
    ).toEqual(OK)
    const second = await signInDirect(on, carol)
    expect(second!.session).toMatchObject({ tenantAdmin: true, root: false })
    expect(second!.session.perms).not.toContain(dictPerms.browse)
    // a role of scope `all`, granted menus
    let n = 0
    const made = async (token: string) =>
      Number(
        (
          await call('post', '/api/iam/roles', token)
            .send({ name: `${PREFIX}role-${++n}`, code: `${PREFIX}role-${n}` })
            .expect(201)
        ).body.data.id,
      )
    const wide = await made(owner)
    const scopeAll = { dataScope: 'all', deptLink: true, deptIds: [] }
    expect(
      outcome(await call('put', `/api/iam/roles/${wide}/data-scope`, owner).send(scopeAll)),
    ).toEqual(OK)
    expect(
      outcome(
        await call('put', `/api/iam/roles/${wide}/menus`, owner).send({
          menuLink: true,
          menuIds: [await menuOf(userPerms.browse)],
        }),
      ),
    ).toEqual(OK)
    const narrow = await made(opsToken)
    expect(
      outcome(await call('put', `/api/iam/roles/${narrow}/data-scope`, opsToken).send(scopeAll)),
    ).toEqual(as(Err.IAM_GRANT_EXCEEDS_OWN))
    expect(
      outcome(
        await call('put', `/api/iam/users/${B.users.alice}/roles`, opsToken).send({
          roleIds: [wide],
        }),
      ),
    ).toEqual(as(Err.IAM_GRANT_EXCEEDS_OWN))
    expect(
      outcome(
        await call('put', `/api/iam/users/${B.users.alice}/roles`, owner).send({ roleIds: [wide] }),
      ),
    ).toEqual(OK)
  })

  it('grants no perm beyond the menus open to tenants (403) and no role of another tenant (404)', async () => {
    const owner = await tokenOf(B.users.admin)
    // a menu open to tenants whose perm it lacks (disabled, so no tenant admin holds it): 403; a
    // platform menu is not even in B's grant tree: 404
    const grantMenu = async (menuId: number) =>
      outcome(
        await call('put', `/api/iam/roles/${B.roleId}/menus`, owner).send({
          menuLink: true,
          menuIds: [menuId],
        }),
      )
    expect(await grantMenu(probeMenu)).toEqual(as(Err.IAM_GRANT_EXCEEDS_OWN))
    expect(await grantMenu(await menuOf(dictPerms.browse))).toEqual(as(Err.NOT_FOUND))
    expect(
      outcome(
        await call('put', `/api/iam/users/${B.users.alice}/roles`, owner).send({
          roleIds: [editorRole],
        }),
      ),
    ).toEqual(as(Err.NOT_FOUND))
    expect(
      outcome(
        await call('post', `/api/iam/roles/${editorRole}/members`, owner).send({
          userIds: [B.users.alice],
        }),
      ),
    ).toEqual(as(Err.NOT_FOUND))
  })

  it('a platform page granted to a role of B shows in no /menus of B: neither its admin’s nor a member’s', async () => {
    const owner = await tokenOf(B.users.admin)
    const page = async (route: string) =>
      Number(
        (
          await ds.query<{ id: number }[]>(
            'SELECT id FROM iam_menu WHERE route_name = ? AND deleted_at IS NULL',
            [route],
          )
        )[0]!.id,
      )
    const role = Number(
      (
        await call('post', '/api/iam/roles', owner)
          .send({ name: `${PREFIX}pages`, code: `${PREFIX}pages` })
          .expect(201)
      ).body.data.id,
    )
    try {
      // the grant tree of B offers no platform page (404), so the grant is written straight: what an
      // earlier grant left behind
      await ds.query(
        'INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, ?), (?, ?, ?)',
        [role, await page('iam-menu'), B.id, role, await page('iam-user'), B.id],
      )
      expect(
        outcome(
          await call('post', `/api/iam/roles/${role}/members`, owner).send({
            userIds: [boss, B.users.alice],
          }),
        ),
      ).toEqual(OK)
      const platformPages = await platformRoutes()
      expect(platformPages.has('iam-menu')).toBe(true)
      for (const who of [boss, B.users.alice]) {
        const shown = routes(
          (await call('get', '/api/auth/menus', await tokenOf(who)).expect(200)).body.data,
        )
        expect(shown).toContain('iam-user')
        expect(shown.filter((r) => platformPages.has(r))).toEqual([])
      }
    } finally {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [role])
      await ds.query('DELETE FROM iam_user_roles WHERE role_id = ?', [role])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [role])
    }
  })

  it('its builtin role is kept: never disabled, deleted, re-scoped or granted menus', async () => {
    const owner = await tokenOf(B.users.admin)
    const builtin = as(Err.IAM_ROLE_BUILTIN)
    expect(
      outcome(
        await call('put', `/api/iam/roles/${adminRole}/enabled`, owner).send({ enabled: false }),
      ),
    ).toEqual(builtin)
    expect(outcome(await call('delete', `/api/iam/roles/${adminRole}`, owner))).toEqual(builtin)
    expect(
      outcome(
        await call('put', `/api/iam/roles/${adminRole}/data-scope`, owner).send({
          dataScope: 'own_dept',
          deptLink: true,
          deptIds: [],
        }),
      ),
    ).toEqual(builtin)
    expect(
      outcome(
        await call('put', `/api/iam/roles/${adminRole}/menus`, owner).send({
          menuLink: true,
          menuIds: [],
        }),
      ),
    ).toEqual(builtin)
    const [row] = await ds.query<
      { enabled: number; data_scope: string; deleted_at: Date | null }[]
    >('SELECT enabled, data_scope, deleted_at FROM iam_role WHERE id = ?', [adminRole])
    expect(row).toEqual({ enabled: 1, data_scope: 'all', deleted_at: null })
  })

  it('a menu edit handing every tenant’s admin a perm its editor lacks is refused (403), root’s is not', async () => {
    const edit = (token: string) =>
      call('put', `/api/iam/menus/${probeMenu}/enabled`, token).send({ enabled: true })
    expect(outcome(await edit(await tokenOf(editor)))).toEqual(as(Err.IAM_GRANT_EXCEEDS_OWN))
    expect(outcome(await edit((await signIn(on)).accessToken))).toEqual(OK)
    const owner = await signInDirect(on, B.users.admin)
    expect(owner!.session.perms).toContain('tro.probe.run')
  })
})

describe('protected users', () => {
  it('a user administrator writes, kicks and changes the roles of neither the owner nor a tenant_admin holder (422)', async () => {
    const opsToken = await tokenOf(ops)
    const protectedErr = as(Err.IAM_USER_PROTECTED)
    for (const target of [B.users.admin, boss]) {
      expect(
        outcome(
          await call('put', `/api/iam/users/${target}/password`, opsToken).send({
            password: NEW_PASSWORD,
          }),
        ),
      ).toEqual(protectedErr)
      expect(
        outcome(
          await call('put', `/api/iam/users/${target}`, opsToken).send({ mobile: '13900009077' }),
        ),
      ).toEqual(protectedErr)
      expect(
        outcome(await call('put', `/api/iam/users/${target}`, opsToken).send({ deptId: dept2 })),
      ).toEqual(protectedErr)
      expect(
        outcome(
          await call('put', `/api/iam/users/${target}/enabled`, opsToken).send({ enabled: false }),
        ),
      ).toEqual(protectedErr)
      expect(outcome(await call('delete', `/api/iam/users/${target}`, opsToken))).toEqual(
        protectedErr,
      )
      expect(
        outcome(await call('post', '/api/iam/sessions/kick', opsToken).send({ userId: target })),
      ).toEqual(protectedErr)
      const s = await signInDirect(on, target)
      expect(
        outcome(
          await call('post', '/api/iam/sessions/kick', opsToken).send({ sids: [s!.session.sid] }),
        ),
      ).toEqual(protectedErr)
      expect(
        outcome(
          await call('post', `/api/iam/roles/${adminRole}/members/revoke`, opsToken).send({
            userIds: [target],
          }),
        ),
      ).toEqual(protectedErr)
    }
    // nothing changed
    const rows = await ds.query<{ id: number; enabled: number; dept_id: number }[]>(
      'SELECT id, enabled, dept_id FROM iam_user WHERE id IN (?) AND deleted_at IS NULL ORDER BY id',
      [[B.users.admin, boss]],
    )
    expect(rows.map((r) => [Number(r.enabled), Number(r.dept_id)])).toEqual([
      [1, B.deptId],
      [1, B.deptId],
    ])
    // an unprotected user: as before
    expect(
      outcome(
        await call('put', `/api/iam/users/${B.users.alice}/password`, opsToken).send({
          password: NEW_PASSWORD,
        }),
      ),
    ).toEqual(OK)
  })

  it('the list marks whom the caller may not edit: owner and holders for a user administrator, the owner for a holder', async () => {
    const marks = async (token: string) => {
      const res = await call('get', '/api/iam/users?page=1&pageSize=200', token).expect(200)
      const rows = res.body.data.items as { id: number; protected: boolean }[]
      return [B.users.admin, boss, B.users.alice].map(
        (id) => rows.find((r) => r.id === id)?.protected,
      )
    }
    expect(await marks(await tokenOf(ops))).toEqual([true, true, false])
    expect(await marks(await tokenOf(boss))).toEqual([true, false, false])
  })

  it('a tenant_admin holder manages another holder, never the owner', async () => {
    const owner = await tokenOf(B.users.admin)
    const bossToken = await tokenOf(boss)
    expect(
      outcome(
        await call('put', `/api/iam/users/${B.users.admin}/password`, bossToken).send({
          password: NEW_PASSWORD,
        }),
      ),
    ).toEqual(as(Err.IAM_USER_PROTECTED))
    expect(
      outcome(
        await call('put', `/api/iam/users/${B.users.admin}/enabled`, bossToken).send({
          enabled: false,
        }),
      ),
    ).toEqual(as(Err.IAM_USER_PROTECTED))
    expect(
      outcome(
        await call('put', `/api/iam/users/${boss}/password`, owner).send({
          password: NEW_PASSWORD,
        }),
      ),
    ).toEqual(OK)
    expect(
      outcome(await call('put', `/api/iam/users/${boss}`, owner).send({ deptId: dept2 })),
    ).toEqual(OK)
    expect(
      outcome(await call('post', '/api/iam/sessions/kick', owner).send({ userId: boss })),
    ).toEqual(OK)
    expect(
      outcome(await call('put', `/api/iam/users/${boss}/enabled`, owner).send({ enabled: false })),
    ).toEqual(OK)
    expect(
      outcome(await call('put', `/api/iam/users/${boss}/enabled`, owner).send({ enabled: true })),
    ).toEqual(OK)
  })

  it('the owner is never disabled nor deleted, not even by root', async () => {
    // the default tenant has no owner; this spec names one to put root in front of the rule
    const owner1 = await addUser(on, 1, `${PREFIX}owner1`)
    await ds.query('UPDATE iam_tenant SET owner_user_id = ? WHERE id = 1', [owner1])
    try {
      const root = (await signIn(on)).accessToken
      expect(
        outcome(
          await call('put', `/api/iam/users/${owner1}/enabled`, root).send({ enabled: false }),
        ),
      ).toEqual(as(Err.IAM_USER_PROTECTED))
      expect(outcome(await call('delete', `/api/iam/users/${owner1}`, root))).toEqual(
        as(Err.IAM_USER_PROTECTED),
      )
      expect(
        outcome(
          await call('put', `/api/iam/users/${owner1}/password`, root).send({
            password: NEW_PASSWORD,
          }),
        ),
      ).toEqual(OK)
      const [row] = await ds.query<{ enabled: number; deleted_at: Date | null }[]>(
        'SELECT enabled, deleted_at FROM iam_user WHERE id = ?',
        [owner1],
      )
      expect(row).toEqual({ enabled: 1, deleted_at: null })
    } finally {
      await ds.query('UPDATE iam_tenant SET owner_user_id = NULL WHERE id = 1')
    }
  })
})
