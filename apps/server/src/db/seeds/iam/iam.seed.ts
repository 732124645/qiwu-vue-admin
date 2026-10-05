// iam seed (see docs/design-notes.md#auth-sessions, #i18n): the root role, the admin user, a demo dept tree, demo positions
// (admin holds one), the home menu, the system menu group (its pages seed themselves, e.g. position.seed.ts)
// and the users' initial password param.
// Display names are i18n keys: seed.* in packages/shared/src/i18n/*/seed.json, menu.* in menu.json.
import { randomBytes } from 'node:crypto'
import { USER_INITIAL_PASSWORD_PARAM } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import type { EntityManager } from 'typeorm'
import { demoMode } from '../../../core/config/demo-mode.js'
import { BCRYPT_COST } from '../../../core/auth/password-hash.js'
import { addLinks, type LinkTable } from '../../../core/db/links.js'
import { findId, insertRow, upsert } from '../upsert.js'

// seeded links never revive one an administrator removed
const USER_ROLES: LinkTable = { table: 'iam_user_roles', owner: 'user_id', target: 'role_id' }
const USER_POSITIONS: LinkTable = {
  table: 'iam_user_positions',
  owner: 'user_id',
  target: 'position_id',
}
const ROLE_MENUS: LinkTable = { table: 'iam_role_menus', owner: 'role_id', target: 'menu_id' }

interface DeptSeed {
  name: string
  children?: DeptSeed[]
}

/** Demo tree, names made up for this project. */
const DEPTS: DeptSeed[] = [
  {
    name: 'seed.dept.hq',
    children: [
      {
        name: 'seed.dept.rd',
        children: [{ name: 'seed.dept.platform' }, { name: 'seed.dept.product' }],
      },
      { name: 'seed.dept.ops', children: [{ name: 'seed.dept.support' }] },
      { name: 'seed.dept.finance' },
    ],
  },
]

/** Upserts by (parent_id, name); tree_path = parent path + own id + '/'. Returns name → id. */
async function seedDepts(
  q: EntityManager,
  nodes: DeptSeed[],
  parentId = 0,
  parentPath = '/',
  ids = new Map<string, number>(),
): Promise<Map<string, number>> {
  for (const [i, dept] of nodes.entries()) {
    const id = await upsert(
      q,
      'iam_dept',
      { parent_id: parentId, name: dept.name },
      { sort_no: (i + 1) * 10 },
      { tree_path: parentPath }, // placeholder: the id is only known after the insert
    )
    const path = `${parentPath}${id}/`
    await q.query('UPDATE iam_dept SET tree_path = ? WHERE id = ? AND deleted_at IS NULL', [
      path,
      id,
    ])
    ids.set(dept.name, id)
    await seedDepts(q, dept.children ?? [], id, path, ids)
  }
  return ids
}

/** Demo positions (code, name key), made up for this project; the admin holds the first one. Inserted once: admins own them afterwards. */
const POSITIONS: [code: string, name: string][] = [
  ['eng_lead', 'seed.position.engLead'],
  ['developer', 'seed.position.developer'],
  ['designer', 'seed.position.designer'],
  ['support', 'seed.position.support'],
]

interface UserSeed {
  username: string
  displayName: string
  deptId: number | null
  password: string
  /** null = the first sign-in must change the password (see docs/design-notes.md#auth-sessions) */
  passwordChangedAt: Date | null
  roleIds: number[]
}

/**
 * Creates the user once; an existing user is never touched (password and profile are the user's).
 * Role links are ensured on every run (one an administrator removed stays removed).
 */
async function seedUser(q: EntityManager, u: UserSeed): Promise<{ id: number; created: boolean }> {
  let id = await findId(q, 'iam_user', { username: u.username })
  const created = id === undefined
  id ??= await insertRow(q, 'iam_user', {
    username: u.username,
    display_name: u.displayName,
    dept_id: u.deptId,
    password_hash: await bcrypt.hash(u.password, BCRYPT_COST),
    password_changed_at: u.passwordChangedAt,
  })
  await addLinks(q, USER_ROLES, id, u.roleIds, { revive: false })
  return { id, created }
}

/**
 * Root role (`code='root'`, builtin, data scope `all`; perms `*` come from core/auth, not role_menus),
 * the dept tree, the home page menu and the `admin` user. `SEED_ADMIN_PASSWORD` set → that password,
 * counted as changed now; unset → a random one, returned as a notice to print once, with
 * `password_changed_at = NULL` so the first sign-in has to change it.
 */
export async function seedIam(q: EntityManager): Promise<string[]> {
  const rootId = await upsert(
    q,
    'iam_role',
    { code: 'root' },
    { name: 'seed.role.root', data_scope: 'all', is_builtin: 1, sort_no: 0 },
  )
  const depts = await seedDepts(q, DEPTS)
  const homeId = await upsert(
    q,
    'iam_menu',
    { route_name: 'home' },
    {
      parent_id: 0,
      kind: 'page',
      name: 'menu.home',
      route_path: '/home',
      component: 'home/index',
      component_name: 'HomeView',
      keep_alive: 1,
      icon: 'lucide:house',
      sort_no: 0,
    },
  )
  const memberExisted = (await findId(q, 'iam_role', { code: 'member' })) !== undefined
  const memberId = await upsert(
    q,
    'iam_role',
    { code: 'member' },
    { is_builtin: 0 },
    { name: 'seed.role.member', data_scope: 'own_rows', sort_no: 110 },
  )
  if (!memberExisted) await addLinks(q, ROLE_MENUS, memberId, [homeId], { revive: false })
  await upsert(
    q,
    'iam_menu',
    { route_name: 'system' },
    {
      parent_id: 0,
      kind: 'group',
      name: 'menu.system.title',
      route_path: '/system',
      icon: 'lucide:settings',
      sort_no: 10,
    },
  )
  // 业务管理: the project's generated pages and groups go below it by default; with no
  // visible child the side menu hides it, and it is granted only as the ancestor of a granted page
  await upsert(
    q,
    'iam_menu',
    { route_name: 'biz' },
    {
      parent_id: 0,
      kind: 'group',
      name: 'menu.biz.title',
      route_path: '/biz',
      icon: 'lucide:briefcase',
      sort_no: 7,
    },
  )
  const positionIds: number[] = []
  for (const [i, [code, name]] of POSITIONS.entries())
    positionIds.push(await upsert(q, 'iam_position', { code }, {}, { name, sort_no: (i + 1) * 10 }))
  const preset = process.env.SEED_ADMIN_PASSWORD
  const demo = demoMode()
  const password = preset || randomBytes(12).toString('base64url')
  const admin = await seedUser(q, {
    username: 'admin',
    displayName: 'Administrator',
    deptId: depts.get('seed.dept.hq') ?? null,
    password,
    passwordChangedAt: preset || demo ? new Date() : null,
    roleIds: [rootId],
  })
  await addLinks(q, USER_POSITIONS, admin.id, positionIds.slice(0, 1), { revive: false })
  const change = demo ? '' : ', must be changed at first sign-in'
  const notices =
    admin.created && !preset ? [`seed: admin password (shown once${change}): ${password}`] : []
  const initial = await seedInitialPassword(q)
  if (initial)
    notices.push(`seed: initial password of new users (${USER_INITIAL_PASSWORD_PARAM}): ${initial}`)
  return notices
}

/**
 * The password of users created without one (user create/import; changed at their first sign-in). A
 * random value per installation, never a well-known default: set once, returned for a one-time notice,
 * the admin's afterwards. Secret (masked in the settings UI). Returns the value when it was created.
 */
async function seedInitialPassword(q: EntityManager): Promise<string | null> {
  const key = { param_key: USER_INITIAL_PASSWORD_PARAM }
  const created = (await findId(q, 'cfg_param', key)) === undefined
  // letters, digits and a symbol whatever the random part holds: passes any character-class policy
  const value = `${randomBytes(9).toString('base64url')}#a1A`
  await upsert(
    q,
    'cfg_param',
    key,
    {
      name: '新用户初始密码',
      name_i18n: { 'zh-CN': '新用户初始密码', 'en-US': 'Initial password of new users' },
      group_code: 'iam',
      is_builtin: 1,
      is_secret: 1,
      is_public: 0,
    },
    { param_value: value },
  )
  return created ? value : null
}

/**
 * For e2e/Playwright setups ("a user without permission", menu-page.spec): role `demo` (data scope
 * `own_dept`, granted only the home page, so no `settings.dict.browse`) and an enabled user in it whose
 * password counts as changed. Idempotent; needs the iam seed first. Returns the user id.
 */
export async function seedLimitedUser(
  q: EntityManager,
  username: string,
  password: string,
): Promise<number> {
  const homeId = await findId(q, 'iam_menu', { route_name: 'home' })
  if (homeId === undefined) throw new Error('seedLimitedUser: run the iam seed first')
  const roleId = await upsert(
    q,
    'iam_role',
    { code: 'demo' },
    { name: 'seed.role.demo', data_scope: 'own_dept', sort_no: 100 },
  )
  await addLinks(q, ROLE_MENUS, roleId, [homeId], { revive: false })
  const user = await seedUser(q, {
    username,
    displayName: username,
    deptId: (await findId(q, 'iam_dept', { name: 'seed.dept.support' })) ?? null,
    password,
    passwordChangedAt: new Date(),
    roleIds: [roleId],
  })
  return user.id
}
