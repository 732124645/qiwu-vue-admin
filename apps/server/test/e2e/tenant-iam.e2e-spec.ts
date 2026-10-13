// Identity and access beside another tenant (see docs/design-notes.md#tenancy), multi-tenancy on.
// Tenant B (createTenant, with its people) has its own users, roles, depts and positions, some under
// the default tenant's names; its `admin` holds B's builtin `tenant_admin` role (every perm open to
// tenants). Every iam route keeps to the caller's tenant: lists, selectors, exports and the import
// template hold no row of the other tenant; an id of the other tenant is 404 for every read, write,
// batch and action (nothing stored, either way round, root included); a write naming another tenant's
// dept, role, position or user is 404 like an out-of-scope one; names and codes live once per tenant;
// the grant tree of a tenant other than the default one holds no platform-only menu (granting one: 404),
// while a non-root administrator of the default tenant still grants them within its own perms; a menu
// edit by a non-root platform administrator never widens a role of another tenant. Link rows naming
// another tenant's role, position or dept (left by a bug elsewhere) give nothing: no role, position,
// menu or root flag shows, no delete is refused for them.
// Routes covered elsewhere: sign-up and the WeChat sign-in and binding (tenant-public, tenant-otp), the
// mobile code of the personal center (tenant-otp), the session list and kicks (tenant-root, again here).
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  Err,
  type ErrorDef,
  type MenuNode,
  menuPerms,
  type RoleMenuNode,
  rolePerms,
} from '@qiwu/shared'
import ExcelJS from 'exceljs'
import sharp from 'sharp'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { TokenService } from '../../src/core/auth/token.service.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import {
  addUser,
  bootApp,
  createTenant,
  type PeopledTenant,
  signInDirect,
  TENANT_PASSWORD,
} from '../setup/tenants.js'

const PREFIX = 'tiam-'
const STRONG = 'Cross#Tenant2026x'
const APPID = 'tiam-app'

let on: NestExpressApplication
let ds: DataSource
let redis: Redis
let B: PeopledTenant
/** the default tenant's rows of this spec */
const A = { dept: 0, dept2: 0, role: 0, position: 0, user: 0, twin: 0, rootRole: 0 }
/** B's: its tenant_admin role, a second role, a position and a user only it has, the twin */
const b = { adminRole: 0, role2: 0, position: 0, only: 0, twin: 0 }
/** default-tenant roles and users of the grant cases: a granter, a menu editor, grant targets */
const g = { granterRole: 0, granter: 0, editorRole: 0, editor: 0, target: 0, t1: 0, bProbe: 0 }
/**
 * probe menus under the user page: p1 enabled, p2 disabled, both carrying PROBE and in B's package; p3 a
 * disabled one under the platform's menu page
 */
const PROBE = 'tiam.probe.run'
const probe = { p1: 0, p2: 0, p3: 0 }
const tok: Record<string, string> = {}

const http = () => request(on.getHttpServer())
const tokenOf = async (userId: number) => (await signInDirect(on, userId))!.accessToken
const call = (method: 'get' | 'post' | 'put' | 'delete', url: string, token: string) =>
  http()[method](url).set(bearer(token)).set('Accept-Language', 'en-US')
const outcome = (res: request.Response) => ({ status: res.status, code: res.body?.code as unknown })
const as = (e: ErrorDef) => ({ status: e.status, code: e.code })
const OK = { status: 200, code: 0 }
const CREATED = { status: 201, code: 0 }
/** Binary body as a Buffer whatever the content type. */
const binary = (req: request.Test) =>
  req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = []
    res.on('data', (c: Buffer) => chunks.push(c))
    res.on('end', () => cb(null, Buffer.concat(chunks)))
  })
/** Every cell of every sheet of an xlsx answer, as text. */
async function cellsOf(res: request.Response): Promise<string[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(res.body as unknown as Parameters<typeof wb.xlsx.load>[0])
  const out: string[] = []
  for (const ws of wb.worksheets)
    ws.eachRow((row) => row.eachCell((cell) => out.push(String(cell.value ?? ''))))
  return out
}
const ids = (rows: { id: number }[]) => rows.map((r) => Number(r.id))
const treeIds = (nodes: { id: number; children?: unknown[] }[]): number[] =>
  nodes.flatMap((n) => [Number(n.id), ...treeIds((n.children ?? []) as typeof nodes)])
const routes = (nodes: MenuNode[]): string[] =>
  nodes.flatMap((n) => [...(n.routeName ? [n.routeName] : []), ...routes(n.children)])

const insertRole = async (tenantId: number, code: string, scope = 'own_rows') =>
  Number(
    (
      await ds.query<{ insertId: number }>(
        'INSERT INTO iam_role (code, name, data_scope, tenant_id) VALUES (?, ?, ?, ?)',
        [code, code, scope, tenantId],
      )
    ).insertId,
  )
const insertDept = async (tenantId: number, name: string) => {
  const id = Number(
    (
      await ds.query<{ insertId: number }>(
        "INSERT INTO iam_dept (parent_id, tree_path, name, tenant_id) VALUES (0, '/', ?, ?)",
        [name, tenantId],
      )
    ).insertId,
  )
  await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ? AND tenant_id = ?', [
    `/${id}/`,
    id,
    tenantId,
  ])
  return id
}
const insertPosition = async (tenantId: number, code: string) =>
  Number(
    (
      await ds.query<{ insertId: number }>(
        'INSERT INTO iam_position (code, name, tenant_id) VALUES (?, ?, ?)',
        [code, code, tenantId],
      )
    ).insertId,
  )
const link = (table: string, cols: [string, string], a: number, z: number, tenantId: number) =>
  ds.query(`INSERT INTO ${table} (${cols[0]}, ${cols[1]}, tenant_id) VALUES (?, ?, ?)`, [
    a,
    z,
    tenantId,
  ])
/** Grants role `roleId` of tenant `tenantId` the menus carrying `perms` (action menus). */
const grantPerms = (roleId: number, tenantId: number, perms: string[]) =>
  ds.query(
    `INSERT INTO iam_role_menus (role_id, menu_id, tenant_id)
     SELECT ?, id, ? FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL`,
    [roleId, tenantId, perms],
  )
const menuOf = async (column: 'route_name' | 'perms', value: string) =>
  Number(
    (
      await ds.query<{ id: number }[]>(
        `SELECT id FROM iam_menu WHERE ${column} = ? AND deleted_at IS NULL ORDER BY id LIMIT 1`,
        [value],
      )
    )[0]!.id,
  )
const platformMenus = async () =>
  new Set(
    ids(
      await ds.query<{ id: number }[]>(
        'SELECT id FROM iam_menu WHERE platform_only = 1 AND deleted_at IS NULL',
      ),
    ),
  )

/** The iam rows of both tenants: what a refused request must leave exactly as it was. */
const SNAPSHOT_TABLES = [
  'iam_user',
  'iam_role',
  'iam_dept',
  'iam_position',
  'iam_user_roles',
  'iam_user_positions',
  'iam_role_menus',
  'iam_role_depts',
  'iam_user_pref',
  'iam_user_social',
]
async function snapshot() {
  const out: Record<string, unknown> = {}
  for (const t of SNAPSHOT_TABLES)
    out[t] = await ds.query(`SELECT * FROM ${t} WHERE tenant_id IN (1, ?) ORDER BY 1, 2`, [B.id])
  return JSON.parse(JSON.stringify(out)) as unknown
}

beforeAll(async () => {
  on = await bootApp({ multiTenant: true })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  await cleanRedis(redis)
  B = await createTenant(on, { users: true })
  b.adminRole = Number(
    (
      await ds.query<{ id: number }[]>(
        "SELECT id FROM iam_role WHERE code = 'tenant_admin' AND is_builtin = 1 AND tenant_id = ?",
        [B.id],
      )
    )[0]!.id,
  )
  await link('iam_user_roles', ['user_id', 'role_id'], B.users.admin, b.adminRole, B.id)
  b.role2 = await insertRole(B.id, `${PREFIX}b-role2`)
  b.position = await insertPosition(B.id, `${PREFIX}b-pos`)
  b.only = await addUser(on, B.id, `${PREFIX}b-only`, { deptId: B.deptId })
  b.twin = await addUser(on, B.id, `${PREFIX}twin`, { deptId: B.deptId })
  // the default tenant
  A.rootRole = Number(
    (
      await ds.query<{ id: number }[]>(
        "SELECT id FROM iam_role WHERE code = 'root' AND is_builtin = 1 AND tenant_id = 1",
      )
    )[0]!.id,
  )
  A.dept = await insertDept(1, `${PREFIX}a-dept`)
  A.dept2 = await insertDept(1, `${PREFIX}a-dept2`)
  A.role = await insertRole(1, `${PREFIX}a-role`)
  A.position = await insertPosition(1, `${PREFIX}a-pos`)
  A.user = await addUser(on, 1, `${PREFIX}a-user`, { deptId: A.dept, roleId: A.role })
  await link('iam_user_positions', ['user_id', 'position_id'], A.user, A.position, 1)
  A.twin = await addUser(on, 1, `${PREFIX}twin`)
  g.granterRole = await insertRole(1, `${PREFIX}granter`, 'all')
  await grantPerms(g.granterRole, 1, [rolePerms.browse, rolePerms.grant, menuPerms.browse])
  g.granter = await addUser(on, 1, `${PREFIX}granter`, { roleId: g.granterRole })
  g.target = await insertRole(1, `${PREFIX}target`)
  const userPage = await menuOf('route_name', 'iam-user')
  for (const [key, enabled] of [
    ['p1', 1],
    ['p2', 0],
  ] as const)
    probe[key] = await insertRow(ds.manager, 'iam_menu', {
      parent_id: userPage,
      kind: 'action',
      name: `${PREFIX}${key}`,
      perms: PROBE,
      enabled,
    })
  // B's package was made before them
  await ds.query('INSERT INTO iam_tenant_package_menus (package_id, menu_id) VALUES ?', [
    [probe.p1, probe.p2].map((m) => [B.packageId, m]),
  ])
  g.editorRole = await insertRole(1, `${PREFIX}editor`, 'all')
  await grantPerms(g.editorRole, 1, [menuPerms.browse, menuPerms.modify])
  await link('iam_role_menus', ['role_id', 'menu_id'], g.editorRole, probe.p1, 1)
  g.editor = await addUser(on, 1, `${PREFIX}editor`, { roleId: g.editorRole })
  g.t1 = await insertRole(1, `${PREFIX}t1`)
  g.bProbe = await insertRole(B.id, `${PREFIX}b-probe`)
  tok.root = (await signIn(on)).accessToken
  tok.boss = await tokenOf(B.users.admin)
  tok.alice = await tokenOf(B.users.alice)
  tok.granter = await tokenOf(g.granter)
  tok.editor = await tokenOf(g.editor)
  tok.aTwin = await tokenOf(A.twin)
  tok.bTwin = await tokenOf(b.twin)
})

afterAll(async () => {
  if (ds) {
    await B?.dispose()
    // the default tenant's rows of this spec, by name (a refused write that went through is caught too)
    const own = async (table: string, column: string) =>
      ids(
        await ds.query<{ id: number }[]>(
          `SELECT id FROM ${table} WHERE ${column} LIKE ? AND tenant_id = 1`,
          [`${PREFIX}%`],
        ),
      )
    const users = await own('iam_user', 'username')
    const roles = await own('iam_role', 'code')
    const positions = await own('iam_position', 'code')
    const depts = await own('iam_dept', 'name')
    const menus = Object.values(probe).filter(Boolean)
    if (users.length) {
      for (const t of ['iam_user_roles', 'iam_user_positions', 'iam_user_pref', 'iam_user_social'])
        await ds.query(`DELETE FROM ${t} WHERE user_id IN (?)`, [users])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [users])
    }
    if (roles.length) {
      for (const t of ['iam_user_roles', 'iam_role_menus', 'iam_role_depts'])
        await ds.query(`DELETE FROM ${t} WHERE role_id IN (?)`, [roles])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roles])
    }
    if (menus.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE menu_id IN (?)', [menus])
      await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [menus])
    }
    if (positions.length) {
      await ds.query('DELETE FROM iam_user_positions WHERE position_id IN (?)', [positions])
      await ds.query('DELETE FROM iam_position WHERE id IN (?)', [positions])
    }
    if (depts.length) {
      await ds.query('DELETE FROM iam_role_depts WHERE dept_id IN (?)', [depts])
      await ds.query('DELETE FROM iam_dept WHERE id IN (?)', [depts])
    }
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
})

interface Side {
  who: string
  token: () => string
  /** the other tenant's rows */
  foreign: () => { user: number; role: number; dept: number; position: number; session: string }
  /** own rows a mixed batch names beside the foreign one */
  own: () => { user: number; role: number; position: number }
}

const sessions: Record<string, string> = {}
const SIDES: Side[] = [
  {
    who: "B's administrator, the default tenant's ids",
    token: () => tok.boss!,
    foreign: () => ({
      user: A.user,
      role: A.role,
      dept: A.dept,
      position: A.position,
      session: sessions.a!,
    }),
    own: () => ({ user: b.only, role: b.role2, position: b.position }),
  },
  {
    who: "the default tenant's root, B's ids",
    token: () => tok.root!,
    foreign: () => ({
      user: B.users.alice,
      role: B.roleId,
      dept: B.deptId,
      position: B.positionId,
      session: sessions.b!,
    }),
    own: () => ({ user: A.user, role: A.role, position: A.position }),
  },
]

describe.each(SIDES)('$who', (side) => {
  beforeAll(async () => {
    sessions.a = (await signInDirect(on, A.user))!.session.sid
    sessions.b = (await signInDirect(on, B.users.alice))!.session.sid
  })

  it('every read, write, batch and action on an id of the other tenant is 404; nothing stored', async () => {
    const f = side.foreign()
    const own = side.own()
    const cases: [method: 'get' | 'post' | 'put' | 'delete', url: string, body?: object][] = [
      ['get', `/api/iam/users/${f.user}`],
      ['put', `/api/iam/users/${f.user}`, { displayName: 'hijacked' }],
      ['put', `/api/iam/users/${f.user}/enabled`, { enabled: false }],
      ['put', `/api/iam/users/${f.user}/password`, { password: STRONG }],
      ['put', `/api/iam/users/${f.user}/roles`, { roleIds: [] }],
      ['delete', `/api/iam/users/${f.user}`],
      ['post', '/api/iam/users/batch-delete', { ids: [own.user, f.user] }],
      ['get', `/api/iam/roles/${f.role}`],
      ['put', `/api/iam/roles/${f.role}`, { name: 'hijacked' }],
      ['put', `/api/iam/roles/${f.role}/enabled`, { enabled: false }],
      ['get', `/api/iam/roles/${f.role}/menus`],
      ['put', `/api/iam/roles/${f.role}/menus`, { menuLink: true, menuIds: [] }],
      ['get', `/api/iam/roles/${f.role}/data-scope`],
      [
        'put',
        `/api/iam/roles/${f.role}/data-scope`,
        { dataScope: 'own_dept', deptLink: true, deptIds: [] },
      ],
      ['get', `/api/iam/roles/${f.role}/members?page=1&pageSize=10`],
      ['post', `/api/iam/roles/${f.role}/members`, { userIds: [own.user] }],
      ['post', `/api/iam/roles/${f.role}/members/revoke`, { userIds: [own.user] }],
      ['delete', `/api/iam/roles/${f.role}`],
      ['post', '/api/iam/roles/batch-delete', { ids: [own.role, f.role] }],
      ['get', `/api/iam/depts/${f.dept}`],
      ['put', `/api/iam/depts/${f.dept}`, { name: 'hijacked' }],
      ['put', `/api/iam/depts/${f.dept}/enabled`, { enabled: false }],
      ['delete', `/api/iam/depts/${f.dept}`],
      ['get', `/api/iam/positions/${f.position}`],
      ['put', `/api/iam/positions/${f.position}`, { name: 'hijacked' }],
      ['put', `/api/iam/positions/${f.position}/enabled`, { enabled: false }],
      ['delete', `/api/iam/positions/${f.position}`],
      ['post', '/api/iam/positions/batch-delete', { ids: [own.position, f.position] }],
      ['delete', `/api/iam/sessions/${f.session}`],
      ['post', '/api/iam/sessions/kick', { sids: [f.session] }],
      ['post', '/api/iam/sessions/kick', { userId: f.user }],
    ]
    const before = await snapshot()
    for (const [method, url, body] of cases) {
      const req = call(method, url, side.token())
      const res = await (body ? req.send(body) : req)
      expect({ method, url, ...outcome(res) }).toEqual({ method, url, ...as(Err.NOT_FOUND) })
    }
    expect(await snapshot()).toEqual(before)
    // the other tenant's session lives on
    expect(await on.get(TokenService).load(f.session)).not.toBeNull()
  })

  it('a write naming a dept, role, position or user of the other tenant is 404; nothing stored', async () => {
    const f = side.foreign()
    const own = side.own()
    const before = await snapshot()
    const user = { displayName: 'x', password: STRONG }
    const refused: [method: 'post' | 'put', url: string, body: object][] = [
      ['post', '/api/iam/users', { ...user, username: `${PREFIX}x1`, deptId: f.dept }],
      ['post', '/api/iam/users', { ...user, username: `${PREFIX}x2`, roleIds: [f.role] }],
      ['post', '/api/iam/users', { ...user, username: `${PREFIX}x3`, positionIds: [f.position] }],
      ['put', `/api/iam/users/${own.user}`, { deptId: f.dept }],
      ['put', `/api/iam/users/${own.user}`, { positionIds: [f.position] }],
      ['put', `/api/iam/users/${own.user}/roles`, { roleIds: [f.role] }],
      ['post', '/api/iam/depts', { parentId: f.dept, name: `${PREFIX}x` }],
      ['post', '/api/iam/depts', { parentId: 0, name: `${PREFIX}x`, headUserId: f.user }],
      [
        'put',
        `/api/iam/roles/${own.role}/data-scope`,
        { dataScope: 'picked_depts', deptLink: true, deptIds: [f.dept] },
      ],
      ['post', `/api/iam/roles/${own.role}/members`, { userIds: [f.user] }],
    ]
    for (const [method, url, body] of refused) {
      const res = await call(method, url, side.token()).send(body)
      expect({ url, body, ...outcome(res) }).toEqual({ url, body, ...as(Err.NOT_FOUND) })
    }
    expect(await snapshot()).toEqual(before)
  })
})

describe('lists, selectors, exports and the import template', () => {
  /** the users of this spec of each tenant (all with a signed-in session), named `tiam-…` but alice */
  const people = {
    b: () => [b.only, b.twin, B.users.alice, B.users.admin],
    a: () => [A.user, A.twin, g.granter, g.editor],
  }
  const VIEWS: [who: string, token: () => string, mine: () => number[], theirs: () => number[]][] =
    [
      ['B', () => tok.boss!, people.b, people.a],
      ['the default tenant', () => tok.root!, people.a, people.b],
    ]

  it.each(VIEWS)(
    '%s sees its own rows only: users, roles, depts, positions, members, sessions',
    async (_, token, mine, theirs) => {
      const get = async (url: string) => (await call('get', url, token()).expect(200)).body.data
      const named = (list: number[]) =>
        list.filter((id) => id !== B.users.alice && id !== B.users.admin)
      const users = ids((await get(`/api/iam/users?page=1&pageSize=100&keyword=${PREFIX}`)).items)
      expect(users).toEqual(expect.arrayContaining(named(mine())))
      expect(users.filter((id) => theirs().includes(id))).toEqual([])
      const options = ids(await get(`/api/iam/users/options?keyword=${PREFIX}`))
      expect(options).toEqual(expect.arrayContaining(named(mine())))
      expect(options.filter((id) => theirs().includes(id))).toEqual([])
      const isB = mine().includes(b.only)
      const foreignDept = isB ? A.dept : B.deptId
      expect((await get(`/api/iam/users?page=1&pageSize=10&deptId=${foreignDept}`)).total).toBe(0)
      const foreign = isB
        ? { roles: [A.role, A.rootRole], depts: [A.dept, A.dept2], positions: [A.position] }
        : { roles: [B.roleId, b.role2, b.adminRole], depts: [B.deptId], positions: [b.position] }
      const roles = ids((await get('/api/iam/roles?page=1&pageSize=100')).items)
      expect(roles.length).toBeGreaterThan(0)
      expect(roles.filter((id) => foreign.roles.includes(id))).toEqual([])
      expect(
        ids(await get('/api/iam/roles/options')).filter((id) => foreign.roles.includes(id)),
      ).toEqual([])
      for (const url of ['/api/iam/depts', '/api/iam/depts/tree']) {
        const depts = treeIds(await get(url))
        expect(depts.length).toBeGreaterThan(0)
        expect(depts.filter((id) => foreign.depts.includes(id))).toEqual([])
      }
      const positions = ids((await get('/api/iam/positions?page=1&pageSize=100')).items)
      expect(positions.length).toBeGreaterThan(0)
      expect(positions.filter((id) => foreign.positions.includes(id))).toEqual([])
      expect(
        ids(await get('/api/iam/positions/options')).filter((id) => foreign.positions.includes(id)),
      ).toEqual([])
      const ownRole = isB ? B.roleId : A.role
      for (const assigned of [true, false]) {
        const members = ids(
          (
            await get(
              `/api/iam/roles/${ownRole}/members?page=1&pageSize=100&assigned=${assigned}&keyword=${PREFIX}`,
            )
          ).items,
        )
        expect(members.filter((id) => theirs().includes(id))).toEqual([])
      }
      const listed = (await get('/api/iam/sessions?page=1&pageSize=100')).items as {
        userId: number
      }[]
      const owners = listed.map((s) => Number(s.userId))
      expect(owners.some((id) => mine().includes(id))).toBe(true)
      expect(owners.filter((id) => theirs().includes(id))).toEqual([])
    },
  )

  it.each(VIEWS)(
    '%s exports its own rows only; the template offers its own depts only',
    async (_, token) => {
      const isB = token() === tok.boss
      const theirMark = isB ? `${PREFIX}a-` : `${PREFIX}b-`
      const myMark = isB ? `${PREFIX}b-` : `${PREFIX}a-`
      for (const url of [
        '/api/iam/users/export',
        '/api/iam/roles/export',
        '/api/iam/positions/export',
      ]) {
        const cells = await cellsOf(await binary(call('get', url, token())).expect(200))
        expect({ url, theirs: cells.filter((c) => c.includes(theirMark)) }).toEqual({
          url,
          theirs: [],
        })
        expect({ url, mine: cells.some((c) => c.includes(myMark)) }).toEqual({ url, mine: true })
      }
      const template = await cellsOf(
        await binary(call('get', '/api/iam/users/import-template', token())).expect(200),
      )
      const deptIds = template
        .map((c) => /^(\d+) - /.exec(c)?.[1])
        .filter((id) => id !== undefined)
        .map(Number)
      expect(deptIds.length).toBeGreaterThan(0)
      const foreignDepts = isB ? [A.dept, A.dept2] : [B.deptId]
      expect(deptIds.filter((id) => foreignDepts.includes(id))).toEqual([])
    },
  )
})

describe('names and codes', () => {
  it('live once per tenant: B makes a user, role and position under the default tenant’s names; twice in B is 409', async () => {
    const made: [url: string, first: object, again: object][] = [
      [
        '/api/iam/users',
        { username: `${PREFIX}a-user`, displayName: 'one', password: STRONG },
        { username: `${PREFIX}a-user`, displayName: 'two', password: STRONG },
      ],
      [
        '/api/iam/roles',
        { name: `${PREFIX}a-role`, code: `${PREFIX}a-role` },
        { name: `${PREFIX}a-role-2`, code: `${PREFIX}a-role` },
      ],
      [
        '/api/iam/positions',
        { code: `${PREFIX}a-pos`, name: 'one' },
        { code: `${PREFIX}a-pos`, name: 'two' },
      ],
    ]
    const aBefore = await ds.query('SELECT * FROM iam_user WHERE id = ?', [A.user])
    for (const [url, first, again] of made) {
      expect({ url, ...outcome(await call('post', url, tok.boss!).send(first)) }).toEqual({
        url,
        ...CREATED,
      })
      expect({ url, ...outcome(await call('post', url, tok.boss!).send(again)) }).toEqual({
        url,
        ...as(Err.DUPLICATE),
      })
    }
    expect(await ds.query('SELECT * FROM iam_user WHERE id = ?', [A.user])).toEqual(aBefore)
    const [{ n }] = await ds.query<{ n: number }[]>(
      'SELECT COUNT(*) AS n FROM iam_position WHERE code = ? AND deleted_at IS NULL',
      [`${PREFIX}a-pos`],
    )
    expect(Number(n)).toBe(2)
  })

  it('import: upsert matches the user of its own tenant only; a dept of the other tenant fails its row', async () => {
    const HEAD = [
      'username',
      'displayName',
      'deptId',
      'mobile',
      'email',
      'gender',
      'enabled',
      'note',
    ]
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('users')
    for (const row of [
      HEAD,
      [`${PREFIX}twin`, 'B twin imported', null, null, null, null, null, null],
      [`${PREFIX}a-imp`, 'new in B', null, null, null, null, null, null],
      [`${PREFIX}b-far`, 'far', A.dept, null, null, null, null, null],
    ])
      ws.addRow(row)
    const file = Buffer.from(await wb.xlsx.writeBuffer())
    const aTwin = await ds.query('SELECT * FROM iam_user WHERE id = ?', [A.twin])
    const res = await http()
      .post('/api/iam/users/import')
      .set(bearer(tok.boss!))
      .attach('file', file, 'users.xlsx')
      .field('mode', 'upsert')
      .expect(200)
    expect(res.body.data).toMatchObject({ inserted: 1, updated: 1, failed: 1 })
    expect(await ds.query('SELECT * FROM iam_user WHERE id = ?', [A.twin])).toEqual(aTwin)
    const rows = await ds.query<{ username: string; display_name: string; tenant_id: number }[]>(
      'SELECT username, display_name, tenant_id FROM iam_user WHERE username IN (?) ORDER BY tenant_id, id',
      [[`${PREFIX}twin`, `${PREFIX}a-imp`, `${PREFIX}b-far`]],
    )
    expect(rows.map((r) => ({ ...r, tenant_id: Number(r.tenant_id) }))).toEqual([
      { username: `${PREFIX}twin`, display_name: `${PREFIX}twin`, tenant_id: 1 },
      { username: `${PREFIX}twin`, display_name: 'B twin imported', tenant_id: B.id },
      { username: `${PREFIX}a-imp`, display_name: 'new in B', tenant_id: B.id },
    ])
  })
})

describe('the grant tree', () => {
  const platformIn = async (token: string) => {
    const tree = (await call('get', '/api/iam/roles/menu-tree', token).expect(200)).body
      .data as RoleMenuNode[]
    const platform = await platformMenus()
    return treeIds(tree).filter((id) => platform.has(id))
  }

  it('of B holds no platform-only menu; granting one is 404 and stores nothing', async () => {
    expect((await platformMenus()).size).toBeGreaterThan(0)
    expect(await platformIn(tok.boss!)).toEqual([])
    const menuPage = await menuOf('route_name', 'iam-menu')
    const userPage = await menuOf('route_name', 'iam-user')
    expect((await platformMenus()).has(menuPage)).toBe(true)
    const before = await snapshot()
    expect(
      outcome(
        await call('put', `/api/iam/roles/${b.role2}/menus`, tok.boss!).send({
          menuLink: true,
          menuIds: [userPage, menuPage],
        }),
      ),
    ).toEqual(as(Err.NOT_FOUND))
    expect(await snapshot()).toEqual(before)
  })

  it('of B keeps a platform grant it does not show when a role’s menus are saved', async () => {
    const menuPage = await menuOf('route_name', 'iam-menu')
    const userPage = await menuOf('route_name', 'iam-user')
    await link('iam_role_menus', ['role_id', 'menu_id'], b.role2, menuPage, B.id)
    try {
      expect(
        outcome(
          await call('put', `/api/iam/roles/${b.role2}/menus`, tok.boss!).send({
            menuLink: true,
            menuIds: [userPage],
          }),
        ),
      ).toEqual(OK)
      const shown = (await call('get', `/api/iam/roles/${b.role2}/menus`, tok.boss!).expect(200))
        .body.data
      expect(shown.menuIds).toEqual([userPage])
      const stored = await ds.query<{ menu_id: number }[]>(
        'SELECT menu_id FROM iam_role_menus WHERE role_id = ? AND deleted_at IS NULL ORDER BY menu_id',
        [b.role2],
      )
      expect(ids(stored.map((r) => ({ id: r.menu_id })))).toEqual(
        [userPage, menuPage].sort((x, y) => x - y),
      )
    } finally {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [b.role2])
    }
  })

  it('of the default tenant holds them; its non-root administrator grants one within its own perms', async () => {
    expect((await platformIn(tok.root!)).length).toBeGreaterThan(0)
    const menuPage = await menuOf('route_name', 'iam-menu')
    expect(await platformIn(tok.granter!)).toContain(menuPage)
    const browse = await menuOf('perms', menuPerms.browse)
    expect(
      outcome(
        await call('put', `/api/iam/roles/${g.target}/menus`, tok.granter!).send({
          menuLink: true,
          menuIds: [menuPage, browse],
        }),
      ),
    ).toEqual(OK)
    const stored = await ds.query<{ menu_id: number }[]>(
      'SELECT menu_id FROM iam_role_menus WHERE role_id = ? AND tenant_id = 1 AND deleted_at IS NULL',
      [g.target],
    )
    expect(stored.map((r) => Number(r.menu_id)).sort((x, y) => x - y)).toEqual(
      [menuPage, browse].sort((x, y) => x - y),
    )
  })
})

describe('a menu edit by a non-root platform administrator', () => {
  it('giving a perm to a role of another tenant is refused (403), giving it to its own tenant’s roles is not', async () => {
    await link('iam_role_menus', ['role_id', 'menu_id'], g.t1, probe.p2, 1)
    await link('iam_role_menus', ['role_id', 'menu_id'], g.bProbe, probe.p2, B.id)
    const enable = (enabled: boolean) =>
      call('put', `/api/iam/menus/${probe.p2}/enabled`, tok.editor!).send({ enabled })
    const enabledNow = async () =>
      Number(
        (
          await ds.query<{ enabled: number }[]>('SELECT enabled FROM iam_menu WHERE id = ?', [
            probe.p2,
          ])
        )[0]!.enabled,
      )
    expect(outcome(await enable(true))).toEqual(as(Err.IAM_GRANT_EXCEEDS_OWN))
    expect(await enabledNow()).toBe(0)
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [g.bProbe])
    expect(outcome(await enable(true))).toEqual(OK)
    expect(await enabledNow()).toBe(1)
    expect(outcome(await enable(false))).toEqual(OK)
  })

  it('a platform menu granted to a role of another tenant gives it nothing: enabling it is refused for no one', async () => {
    probe.p3 = await insertRow(ds.manager, 'iam_menu', {
      parent_id: await menuOf('route_name', 'iam-menu'),
      kind: 'action',
      name: `${PREFIX}p3`,
      perms: 'tiam.probe.platform',
      enabled: 0,
      platform_only: 1,
    })
    await link('iam_role_menus', ['role_id', 'menu_id'], g.bProbe, probe.p3, B.id)
    try {
      const res = await call('put', `/api/iam/menus/${probe.p3}/enabled`, tok.editor!).send({
        enabled: true,
      })
      expect(outcome(res)).toEqual(OK)
    } finally {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [g.bProbe])
    }
  })
})

describe('link rows naming another tenant’s rows give nothing', () => {
  it('no role, position, menu or root flag of the other tenant shows for B’s user', async () => {
    const positionPage = await menuOf('route_name', 'iam-position')
    const deptPage = await menuOf('route_name', 'iam-dept')
    const [lead] = await ds.query<{ id: number }[]>(
      "SELECT id FROM iam_position WHERE code = 'eng_lead' AND tenant_id = 1 AND deleted_at IS NULL",
    )
    const alice = B.users.alice
    // each row passes all but one tenant condition of the reads: a row in B naming the default
    // tenant's role / position, a row of the default tenant for B's user, a grant of the default
    // tenant for B's role
    const strays: [table: string, cols: [string, string], a: number, z: number, t: number][] = [
      ['iam_user_roles', ['user_id', 'role_id'], alice, A.role, B.id],
      ['iam_user_roles', ['user_id', 'role_id'], alice, A.rootRole, B.id],
      ['iam_user_roles', ['user_id', 'role_id'], alice, g.t1, 1],
      ['iam_user_positions', ['user_id', 'position_id'], alice, A.position, B.id],
      ['iam_user_positions', ['user_id', 'position_id'], alice, Number(lead!.id), 1],
      ['iam_role_menus', ['role_id', 'menu_id'], A.role, positionPage, B.id],
      ['iam_role_menus', ['role_id', 'menu_id'], g.t1, positionPage, 1],
      ['iam_role_menus', ['role_id', 'menu_id'], B.roleId, deptPage, 1],
    ]
    try {
      for (const [table, cols, a, z, t] of strays) await link(table, cols, a, z, t)
      const detail = (await call('get', `/api/iam/users/${B.users.alice}`, tok.boss!).expect(200))
        .body.data
      expect(detail.roleIds).toEqual([B.roleId])
      expect(detail.positionIds).toEqual([B.positionId])
      expect(detail.root).toBe(false)
      const listedRoot = async () =>
        (
          await call('get', '/api/iam/users?page=1&pageSize=100', tok.boss!).expect(200)
        ).body.data.items.find((u: { id: number }) => u.id === B.users.alice).root
      expect(await listedRoot()).toBe(false)
      // the root link as a row of the default tenant instead (one row per user and role)
      await ds.query('UPDATE iam_user_roles SET tenant_id = 1 WHERE user_id = ? AND role_id = ?', [
        alice,
        A.rootRole,
      ])
      expect(await listedRoot()).toBe(false)
      const profile = (await call('get', '/api/iam/profile', tok.alice!).expect(200)).body.data
      expect(profile.roleNames).toEqual(['seed.role.member'])
      expect(profile.positionNames).toEqual(['seed.position.developer'])
      const me = (await call('get', '/api/auth/me', tok.alice!).expect(200)).body.data
      expect(me.user.roleNames).toEqual(['seed.role.member'])
      const shown = routes((await call('get', '/api/auth/menus', tok.alice!).expect(200)).body.data)
      expect(shown.filter((r) => r === 'iam-position' || r === 'iam-dept')).toEqual([])
    } finally {
      for (const [table, cols, a, z] of strays)
        await ds.query(`DELETE FROM ${table} WHERE ${cols[0]} = ? AND ${cols[1]} = ?`, [a, z])
    }
  })

  it('no delete is refused for them: a role B’s users do not hold, a dept no user of its tenant is in', async () => {
    const role = await insertRole(B.id, `${PREFIX}b-gone`)
    const dept = await insertDept(1, `${PREFIX}a-gone`)
    // a row in B naming a user of the default tenant, a row of the default tenant for B's role
    await link('iam_user_roles', ['user_id', 'role_id'], A.user, role, B.id)
    await link('iam_user_roles', ['user_id', 'role_id'], A.twin, role, 1)
    const stray = await addUser(on, B.id, `${PREFIX}b-stray`, { deptId: dept })
    try {
      expect(outcome(await call('delete', `/api/iam/roles/${role}`, tok.boss!))).toEqual(OK)
      expect(outcome(await call('delete', `/api/iam/depts/${dept}`, tok.root!))).toEqual(OK)
    } finally {
      await ds.query('DELETE FROM iam_user_roles WHERE role_id = ?', [role])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [role])
      await ds.query('DELETE FROM iam_user WHERE id = ?', [stray])
      await ds.query('DELETE FROM iam_dept WHERE id = ?', [dept])
    }
  })
})

describe('the personal center of two users of one username', () => {
  const PREF = '/api/iam/profile/prefs/table.iam.user'
  const COLS = { v: 1, columns: [{ prop: 'username', visible: true }] }
  const row = async (id: number) =>
    (
      await ds.query<Record<string, unknown>[]>(
        'SELECT display_name, locale, password_hash, avatar_url FROM iam_user WHERE id = ?',
        [id],
      )
    )[0]

  it('profile, language, avatar, password, preferences and bindings of B’s twin leave the default tenant’s alone', async () => {
    await call('put', PREF, tok.aTwin!).send({ value: COLS }).expect(200)
    await insertRow(ds.manager, 'iam_user_social', {
      provider: 'wx-mp',
      appid: APPID,
      openid: `${PREFIX}o-a`,
      user_id: A.twin,
      tenant_id: 1,
    })
    await insertRow(ds.manager, 'iam_user_social', {
      provider: 'wx-mp',
      appid: APPID,
      openid: `${PREFIX}o-b`,
      user_id: b.twin,
      tenant_id: B.id,
    })
    const aBefore = await row(A.twin)
    const mine = (await call('get', '/api/iam/profile', tok.bTwin!).expect(200)).body.data
    expect(mine.id).toBe(b.twin)
    await call('put', '/api/iam/profile', tok.bTwin!).send({ displayName: 'B twin' }).expect(200)
    await call('put', '/api/iam/profile/locale', tok.bTwin!).send({ locale: 'en-US' }).expect(200)
    const image = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer()
    await http()
      .post('/api/iam/profile/avatar')
      .set(bearer(tok.bTwin!))
      .attach('file', image, 'me.png')
      .expect(201)
    expect((await call('get', PREF, tok.bTwin!).expect(200)).body.data.value).toBeNull()
    await call('put', PREF, tok.bTwin!).send({ value: COLS }).expect(200)
    await call('delete', PREF, tok.bTwin!).expect(200)
    expect((await call('get', PREF, tok.aTwin!).expect(200)).body.data.value).toEqual(COLS)
    const socials = (await call('get', '/api/iam/profile/socials', tok.bTwin!).expect(200)).body
      .data
    expect(socials).toHaveLength(1)
    expect(
      (await call('get', '/api/iam/profile/socials/wx-mp/subscribe', tok.bTwin!).expect(200)).body
        .data,
    ).toEqual({ templateIds: [] })
    await call('delete', '/api/iam/profile/socials/wx-mp', tok.bTwin!).expect(200)
    await call('put', '/api/iam/profile/password', tok.bTwin!)
      .send({ oldPassword: TENANT_PASSWORD, newPassword: STRONG })
      .expect(200)
    expect(await row(A.twin)).toEqual(aBefore)
    expect(await row(b.twin)).toMatchObject({ display_name: 'B twin', locale: 'en-US' })
    const live = await ds.query<{ user_id: number }[]>(
      'SELECT user_id FROM iam_user_social WHERE appid = ? AND deleted_at IS NULL',
      [APPID],
    )
    expect(live.map((r) => Number(r.user_id))).toEqual([A.twin])
    expect(
      (await call('get', '/api/iam/profile/socials', tok.aTwin!).expect(200)).body.data,
    ).toHaveLength(1)
  })
})

describe('the menu routes', () => {
  it('are the platform’s: B’s administrator is refused every one (403)', async () => {
    const menu = await menuOf('route_name', 'iam-user')
    const cases: [method: 'get' | 'post' | 'put' | 'delete', url: string][] = [
      ['get', '/api/iam/menus'],
      ['get', `/api/iam/menus/${menu}`],
      ['post', '/api/iam/menus'],
      ['put', '/api/iam/menus/sort'],
      ['put', `/api/iam/menus/${menu}`],
      ['put', `/api/iam/menus/${menu}/enabled`],
      ['delete', `/api/iam/menus/${menu}`],
    ]
    for (const [method, url] of cases) {
      const req = call(method, url, tok.boss!)
      const res = await (method === 'get' ? req : req.send({}))
      expect({ url, status: res.status }).toEqual({ url, status: 403 })
    }
  })
})
