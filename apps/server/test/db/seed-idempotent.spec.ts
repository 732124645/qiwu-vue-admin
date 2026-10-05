// Seeds: idempotent upserts by natural key. Running them twice leaves every seeded table
// identical (rows and content), admin-owned values survive a re-seed, and the base content is in place.
// The schema comes from the Vitest globalSetup reset; afterAll leaves a freshly seeded state behind.
import { spawnSync } from 'node:child_process'
import bcrypt from 'bcryptjs'
import {
  applyFormCalc,
  APP_UPDATE_PARAMS,
  appVersionPerms,
  CAPTCHA_IMAGE_TYPE_PARAM,
  CAPTCHA_MODE_PARAM,
  DEFAULT_CAPTCHA_IMAGE_TYPE,
  actionLogPerms,
  bookPerms,
  BUILTIN_MENU_GROUPS,
  bulletinPerms,
  clientPerms,
  codegenPerms,
  compile,
  configPerms,
  fieldsFromFormSchema,
  sanitizeFormSchema,
  deptPerms,
  demoRealtimePerms,
  AUDIT_RETENTION_PARAM,
  DEFAULT_AUDIT_RETENTION_DAYS,
  DEFAULT_HTTP_TRACE_EXCLUDE,
  DEFAULT_HTTP_TRACE_MODE,
  DEFAULT_TIMEZONE,
  DEFAULT_TIMEZONE_PARAM,
  dictEntryPerms,
  dictPerms,
  HTTP_TRACE_EXCLUDE_PARAM,
  HTTP_TRACE_MODE_PARAM,
  httpFaultPerms,
  httpTracePerms,
  inboxPerms,
  inboxTemplatePerms,
  excelImportParams,
  geoPerms,
  invoicePerms,
  IP_BLACKLIST_PARAM,
  leavePerms,
  LOCALES,
  loginSecurityParams,
  mailAccountPerms,
  mailRecordPerms,
  mailTemplatePerms,
  menuPerms,
  monitorPerms,
  OAUTH_CONSENT_TTL_DAYS_DEFAULT,
  oauthParams,
  paramPerms,
  passwordPolicyParams,
  positionPerms,
  rolePerms,
  signupParams,
  runPerms,
  sessionPerms,
  signinLogPerms,
  smsChannelPerms,
  smsRecordPerms,
  smsTemplatePerms,
  STORAGE_ALLOWED_EXTS_DEFAULT,
  storageObjectPerms,
  storageParams,
  taskPerms,
  topicPerms,
  USER_INITIAL_PASSWORD_PARAM,
  userPerms,
  WF_ACTIONS,
  WF_INSTANCE_STATES,
  WF_TASK_STATES,
  WF_TEMPLATE_KEY_PREFIX,
  wfPerms,
  WX_MP_ENABLED_PARAM,
  WX_SUBSCRIBE_ENABLED_PARAM,
  WX_SUBSCRIBE_TEMPLATES_PARAM,
  wxSubscribeTemplates,
  type FormSchema,
  type MenuNode,
  type WfFields,
} from '@qiwu/shared'
import { DataSource } from 'typeorm'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { CG_SEEDS } from '../../src/db/seeds/codegen/codegen.seed.js'
import { seedLimitedUser } from '../../src/db/seeds/iam/iam.seed.js'
import { runSeeds } from '../../src/db/seeds/index.js'
import {
  PROJECT_MENU_GROUPS,
  type ProjectMenuGroup,
  seedProjectMenuGroups,
} from '../../src/db/seeds/project/menu-groups.seed.js'
import {
  PROJECT_ACTION_VERBS,
  type ProjectActionVerb,
  seedProjectActionVerbs,
} from '../../src/db/seeds/project/action-verbs.seed.js'
import { seedBook } from '../../src/modules/demo/book/book.seed.js'
import { TABLE_PREFIXES } from '../../src/modules/platform/codegen/rules.js'
import { NotifyDispatchOn20260928140100 } from '../../src/db/migrations/20260928140100-notify-dispatch-on.js'
import { SignupRoleId20260928150000 } from '../../src/db/migrations/20260928150000-signup-role-id.js'
import { IamUserLookup } from '../../src/modules/platform/iam/iam-user-lookup.js'
import { findRow, insertRow } from '../../src/db/seeds/upsert.js'
import { LEAVE_FIELDS } from '../../src/modules/biz/leave/leave-wf.handler.js'
import { LEAVE_DEMO_USERS } from '../../src/modules/biz/leave/leave.seed.js'
import { typeormOrg } from '../../src/modules/workflow/typeorm-org.js'
import { WF_TEMPLATES } from '../../src/db/seeds/workflow/process-templates.seed.js'
import { org as wfOrg, run, T0 } from '../fixtures/wf/flow.js'

const TABLES = [
  'iam_user',
  'iam_role',
  'iam_dept',
  'iam_menu',
  'iam_user_roles',
  'iam_role_menus',
  'iam_role_depts',
  'iam_user_positions',
  'iam_position',
  'cfg_dict',
  'cfg_dict_entry',
  'cfg_param',
  'fs_object',
  'fs_storage',
  'cg_table',
  'cg_column',
  'wf_model',
  'wf_version',
  'wf_form',
  'oauth_client',
]

let ds: DataSource

// every row, soft-deleted ones too (DELETE keeps the auto-increment counters: ids are never reused)
const truncate = async () => {
  for (const t of TABLES) await ds.query(`DELETE FROM ${t}`)
}
const snapshot = async () => {
  const rows: Record<string, unknown[]> = {}
  for (const t of TABLES) rows[t] = await ds.query(`SELECT * FROM ${t} ORDER BY 1, 2`)
  return rows
}
const one = async (sql: string, params: unknown[] = []) => (await ds.query(sql, params))[0]
const LIVE_MENU = 'SELECT id FROM iam_menu WHERE id = ? AND deleted_at IS NULL'
const LIVE_GRANT = 'SELECT role_id FROM iam_role_menus WHERE menu_id = ? AND deleted_at IS NULL'
/** The one-time notice of the generated initial password of new users (every fresh seed prints it). */
const INITIAL_NOTICE = new RegExp(
  `^seed: initial password of new users \\(${USER_INITIAL_PASSWORD_PARAM}\\): `,
)
/** The one-time notice of the OA demo users' generated password. */
const OA_NOTICE = /^seed: password of OA demo users /
const adminRoles = async () =>
  (
    await ds.query(
      "SELECT r.code FROM iam_user u JOIN iam_user_roles ur ON ur.user_id = u.id JOIN iam_role r ON r.id = ur.role_id WHERE u.username = 'admin'",
    )
  ).map((r: { code: string }) => r.code)

/** Route names of the menus role `code` is granted (live links). */
const grantsOf = async (code: string): Promise<string[]> =>
  (
    await ds.query(
      'SELECT m.route_name FROM iam_role_menus rm JOIN iam_role r ON r.id = rm.role_id JOIN iam_menu m ON m.id = rm.menu_id WHERE r.code = ? AND rm.deleted_at IS NULL ORDER BY m.route_name',
      [code],
    )
  ).map((r: { route_name: string }) => r.route_name)

beforeAll(async () => {
  ds = new DataSource(dataSourceOptions())
  await ds.initialize()
})

beforeEach(async () => {
  await truncate()
})

it.each(['APP_SECRET', 'SEED_ADMIN_PASSWORD'] as const)(
  'dist/db/seed.js refuses a production marker in %s before connecting and leaves seeded tables empty',
  async (field) => {
    const marker = 'Admin@12345-NoT-FoR-PrOdUcTiOn'
    const secret = 'production-secret-fixture-0123456789abcdef'
    const before = await snapshot()
    expect(before.iam_user).toEqual([])
    // The unreachable port proves refusal happens before connecting; the real database proves no writes.
    for (const port of ['1', process.env.DB_PORT!]) {
      const r = spawnSync(process.execPath, ['dist/db/seed.js', '--only', 'iam'], {
        env: {
          ...process.env,
          NODE_ENV: 'production',
          DB_PORT: port,
          APP_SECRET: secret,
          SEED_ADMIN_PASSWORD: '',
          [field]: marker,
        },
        encoding: 'utf8',
        timeout: 10_000,
      })
      expect(r.error).toBeUndefined()
      expect(r.status).toBe(1)
      const output = r.stdout + r.stderr
      expect(output).toContain(`${field}: production credentials must not contain the test marker`)
      expect(output).not.toContain(marker)
      expect(output).not.toContain(secret)
      expect(await snapshot()).toEqual(before)
    }
  },
)

it('enables only the old notify dispatch seed once and preserves later admin switches', async () => {
  await runSeeds(ds)
  const where = "handler = 'notify.dispatch' AND name = 'seed.task.notifyDispatch'"
  const original = await one(`SELECT enabled FROM job_task WHERE ${where}`)
  const runner = ds.createQueryRunner()
  await runner.connect()
  try {
    const migration = new NotifyDispatchOn20260928140100()
    await ds.query(`UPDATE job_task SET enabled = 0 WHERE ${where}`)
    vi.stubEnv('NODE_ENV', 'development')
    await migration.up(runner)
    expect((await one(`SELECT enabled FROM job_task WHERE ${where}`)).enabled).toBe(1)
    await runSeeds(ds)
    expect((await one(`SELECT enabled FROM job_task WHERE ${where}`)).enabled).toBe(1)
    await ds.query(`UPDATE job_task SET enabled = 0 WHERE ${where}`)
    await runSeeds(ds)
    expect((await one(`SELECT enabled FROM job_task WHERE ${where}`)).enabled).toBe(0)
    vi.stubEnv('NODE_ENV', 'test')
    await migration.up(runner)
    expect((await one(`SELECT enabled FROM job_task WHERE ${where}`)).enabled).toBe(0)
  } finally {
    vi.unstubAllEnvs()
    await ds.query(`UPDATE job_task SET enabled = ? WHERE ${where}`, [original.enabled])
    await runner.release()
  }
})

it('moves the old sign-up role code to an id once, including an unknown code', async () => {
  await runSeeds(ds)
  const memberId = (await one("SELECT id FROM iam_role WHERE code = 'member'")).id
  const migration = new SignupRoleId20260928150000()
  const runner = ds.createQueryRunner()
  await runner.connect()
  try {
    for (const [code, wanted] of [
      ['member', String(memberId)],
      ['missing-role', ''],
    ]) {
      await ds.query('DELETE FROM cfg_param WHERE param_key = ?', [signupParams.defaultRoleId])
      await ds.query(
        "INSERT INTO cfg_param (param_key, param_value, name, group_code, is_builtin, is_public, is_secret) VALUES ('auth.signup.default_role_code', ?, 'Old role', 'auth', 1, 0, 0)",
        [code],
      )
      await migration.up(runner)
      expect(
        (
          await one('SELECT param_value FROM cfg_param WHERE param_key = ?', [
            signupParams.defaultRoleId,
          ])
        ).param_value,
      ).toBe(wanted)
      expect(
        await one("SELECT id FROM cfg_param WHERE param_key = 'auth.signup.default_role_code'"),
      ).toBeUndefined()
    }
  } finally {
    await runner.release()
  }
})

it('keeps an administrator-edited sign-up role id across re-seeding', async () => {
  await runSeeds(ds)
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
    '999999',
    signupParams.defaultRoleId,
  ])
  await runSeeds(ds)
  expect(
    (
      await one('SELECT param_value FROM cfg_param WHERE param_key = ?', [
        signupParams.defaultRoleId,
      ])
    ).param_value,
  ).toBe('999999')
})

afterAll(async () => {
  vi.unstubAllEnvs()
  if (ds?.isInitialized) {
    await truncate()
    await runSeeds(ds)
  }
  await ds?.destroy()
})

it('twice: every seeded table keeps the same rows and content', async () => {
  // SEED_ADMIN_PASSWORD is set in .env.test: only the initial password is new
  expect(await runSeeds(ds)).toEqual([
    expect.stringMatching(INITIAL_NOTICE),
    expect.stringMatching(OA_NOTICE),
  ])
  const first = await snapshot()
  const empty = TABLES.filter((t) => first[t].length === 0)
  expect(empty).toEqual(['iam_role_depts', 'fs_object'])
  expect(await runSeeds(ds)).toEqual([])
  expect(await snapshot()).toEqual(first)
})

it('root role, admin in it with SEED_ADMIN_PASSWORD, dept tree paths', async () => {
  await runSeeds(ds)
  expect(
    await one("SELECT name, data_scope, is_builtin, enabled FROM iam_role WHERE code = 'root'"),
  ).toEqual({ name: 'seed.role.root', data_scope: 'all', is_builtin: 1, enabled: 1 })

  const admin = await one(
    "SELECT u.password_hash, u.password_changed_at, u.enabled, d.name AS dept FROM iam_user u JOIN iam_dept d ON d.id = u.dept_id WHERE u.username = 'admin'",
  )
  expect(admin).toMatchObject({ enabled: 1, dept: 'seed.dept.hq' })
  expect(admin.password_changed_at).toBeInstanceOf(Date)
  expect(await bcrypt.compare(process.env.SEED_ADMIN_PASSWORD!, admin.password_hash)).toBe(true)
  expect(await adminRoles()).toEqual(['root'])

  const depts: { id: number; parent_id: number; tree_path: string; name: string }[] =
    await ds.query('SELECT id, parent_id, tree_path, name FROM iam_dept ORDER BY id')
  expect(depts.map((d) => d.name.startsWith('seed.dept.'))).not.toContain(false)
  const byId = new Map(depts.map((d) => [d.id, d]))
  for (const d of depts)
    expect(d.tree_path).toBe(`${byId.get(d.parent_id)?.tree_path ?? '/'}${d.id}/`)
  expect(depts.filter((d) => d.parent_id === 0).map((d) => d.name)).toEqual(['seed.dept.hq'])
})

it('menu tree paths follow the parents, also when a re-seed moves a page back with its actions', async () => {
  const paths = async () => {
    const rows: { id: number; parent_id: number; tree_path: string }[] = await ds.query(
      'SELECT id, parent_id, tree_path FROM iam_menu ORDER BY id',
    )
    const byId = new Map(rows.map((r) => [r.id, r]))
    return rows.filter((r) => r.tree_path !== `${byId.get(r.parent_id)?.tree_path ?? '/'}${r.id}/`)
  }
  await runSeeds(ds)
  expect(await paths()).toEqual([])
  // an admin moved the dept page (and its actions) under the monitor group
  const page = await one("SELECT id, tree_path FROM iam_menu WHERE route_name = 'iam-dept'")
  const group = await one("SELECT id, tree_path FROM iam_menu WHERE route_name = 'monitor'")
  await ds.query('UPDATE iam_menu SET parent_id = ? WHERE id = ?', [group.id, page.id])
  await ds.query(
    'UPDATE iam_menu SET tree_path = CONCAT(?, SUBSTRING(tree_path, ?)) WHERE tree_path LIKE ?',
    [`${group.tree_path}${page.id}/`, page.tree_path.length + 1, `${page.tree_path}%`],
  )
  expect(await paths()).toEqual([])
  await runSeeds(ds)
  expect(await one('SELECT tree_path FROM iam_menu WHERE id = ?', [page.id])).toEqual({
    tree_path: page.tree_path,
  })
  expect(await paths()).toEqual([])
})

it('menus: home page; system group → dict page (actions) → hidden entries page (actions)', async () => {
  await runSeeds(ds)
  const menu = (where: string) =>
    one(
      `SELECT id, parent_id, kind, name, route_path, component, visible FROM iam_menu WHERE ${where}`,
    )
  expect(await menu("route_name = 'home'")).toMatchObject({
    parent_id: 0,
    kind: 'page',
    name: 'menu.home',
    component: 'home/index',
  })
  const group = await menu("route_name = 'system'")
  const page = await menu("route_name = 'settings-dict'")
  const entries = await menu("route_name = 'settings-dict-entry'")
  expect(group).toMatchObject({ parent_id: 0, kind: 'group', name: 'menu.system.title' })
  expect(page).toMatchObject({
    parent_id: group.id,
    kind: 'page',
    name: 'menu.settings.dict',
    route_path: '/settings/dicts',
    component: 'platform/settings/dict/index',
    visible: 1,
  })
  expect(entries).toMatchObject({
    parent_id: page.id,
    kind: 'page',
    route_path: '/settings/dicts/:code/entries',
    component: 'platform/settings/dict-entry/index',
    visible: 0,
  })
  for (const verb of ['browse', 'view', 'create', 'modify', 'remove', 'export']) {
    expect(await menu(`perms = 'settings.dict.${verb}'`)).toMatchObject({
      parent_id: page.id,
      kind: 'action',
    })
    expect(await menu(`perms = 'settings.dictEntry.${verb}'`)).toMatchObject({
      parent_id: entries.id,
      kind: 'action',
    })
  }
  // the early dictionary viewer is gone
  expect(await menu("route_name = 'settings-dict-viewer'")).toBeUndefined()
})

it('menus: an older database loses the dictionary viewer page and its grants', async () => {
  await runSeeds(ds)
  const group = await one("SELECT id FROM iam_menu WHERE route_name = 'system'")
  const viewer = await insertRow(ds.manager, 'iam_menu', {
    parent_id: group.id,
    kind: 'page',
    name: 'dictionary viewer',
    route_name: 'settings-dict-viewer',
    route_path: '/settings/dict-viewer',
    component: 'platform/settings/dict-viewer/index',
  })
  const [role] = await ds.query("SELECT id FROM iam_role WHERE code = 'root'")
  await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [role.id, viewer])
  await runSeeds(ds)
  // soft-deleted: the rows stay, marked deleted
  expect(await one(LIVE_MENU, [viewer])).toBeUndefined()
  expect(await one(LIVE_GRANT, [viewer])).toBeUndefined()
  expect(
    await one('SELECT deleted_at IS NOT NULL AS gone FROM iam_menu WHERE id = ?', [viewer]),
  ).toEqual({
    gone: 1,
  })
})

it('positions: system group → position page → one action per positionPerms; demo positions, admin holds one', async () => {
  await runSeeds(ds)
  const group = await one(
    "SELECT id, parent_id, kind, name FROM iam_menu WHERE route_name = 'system'",
  )
  expect(group).toMatchObject({ parent_id: 0, kind: 'group', name: 'menu.system.title' })
  const page = await one(
    "SELECT id, parent_id, kind, name, route_path, component, component_name FROM iam_menu WHERE route_name = 'iam-position'",
  )
  expect(page).toMatchObject({
    parent_id: group.id,
    kind: 'page',
    name: 'menu.iam.position',
    route_path: '/iam/positions',
    component: 'platform/iam/position/index',
    component_name: 'IamPosition',
  })
  const actions = await ds.query(
    'SELECT perms FROM iam_menu WHERE parent_id = ? AND kind = ? ORDER BY sort_no',
    [page.id, 'action'],
  )
  expect(actions.map((a: { perms: string }) => a.perms)).toEqual(Object.values(positionPerms))

  const positions: { code: string; name: string }[] = await ds.query(
    'SELECT code, name FROM iam_position ORDER BY sort_no',
  )
  expect(positions.map((p) => p.name.startsWith('seed.position.'))).not.toContain(false)
  expect(
    await one(
      "SELECT p.code FROM iam_user_positions up JOIN iam_user u ON u.id = up.user_id JOIN iam_position p ON p.id = up.position_id WHERE u.username = 'admin'",
    ),
  ).toEqual({ code: positions[0]!.code })
})

it('depts: system group → dept page → one action per deptPerms; the demo tree with seed.dept.* names', async () => {
  await runSeeds(ds)
  const group = await one("SELECT id FROM iam_menu WHERE route_name = 'system'")
  const page = await one(
    "SELECT id, parent_id, kind, name, route_path, component, component_name, keep_alive FROM iam_menu WHERE route_name = 'iam-dept'",
  )
  expect(page).toMatchObject({
    parent_id: group.id,
    kind: 'page',
    name: 'menu.iam.dept',
    route_path: '/iam/depts',
    component: 'platform/iam/dept/index',
    component_name: 'IamDept',
    keep_alive: 1,
  })
  const actions = await ds.query(
    'SELECT perms FROM iam_menu WHERE parent_id = ? AND kind = ? ORDER BY sort_no',
    [page.id, 'action'],
  )
  expect(actions.map((a: { perms: string }) => a.perms)).toEqual(Object.values(deptPerms))
  const depts: { name: string; tree_path: string; id: number }[] = await ds.query(
    'SELECT id, name, tree_path FROM iam_dept',
  )
  expect(depts.map((d) => d.name.startsWith('seed.dept.'))).not.toContain(false)
  expect(depts.map((d) => d.tree_path.endsWith(`/${d.id}/`))).not.toContain(false)
})

it('menus: system group → menu page (before dept) → one action per menuPerms', async () => {
  await runSeeds(ds)
  const group = await one("SELECT id FROM iam_menu WHERE route_name = 'system'")
  const page = await one(
    "SELECT id, parent_id, kind, name, route_path, component, component_name, keep_alive, icon FROM iam_menu WHERE route_name = 'iam-menu'",
  )
  expect(page).toMatchObject({
    parent_id: group.id,
    kind: 'page',
    name: 'menu.iam.menu',
    route_path: '/iam/menus',
    component: 'platform/iam/menu/index',
    component_name: 'IamMenu',
    keep_alive: 1,
    icon: 'lucide:square-menu',
  })
  const actions = await ds.query(
    'SELECT perms FROM iam_menu WHERE parent_id = ? AND kind = ? ORDER BY sort_no',
    [page.id, 'action'],
  )
  expect(actions.map((a: { perms: string }) => a.perms)).toEqual(Object.values(menuPerms))
})

it('roles: system group → role page (before menu) → one action per rolePerms, assign-users under the hidden members page', async () => {
  await runSeeds(ds)
  const group = await one("SELECT id FROM iam_menu WHERE route_name = 'system'")
  const page = await one(
    "SELECT id, parent_id, kind, name, route_path, component, component_name, keep_alive, icon FROM iam_menu WHERE route_name = 'iam-role'",
  )
  expect(page).toMatchObject({
    parent_id: group.id,
    kind: 'page',
    name: 'menu.iam.role',
    route_path: '/iam/roles',
    component: 'platform/iam/role/index',
    component_name: 'IamRole',
    keep_alive: 1,
    icon: 'lucide:shield-user',
  })
  const actions = await ds.query(
    'SELECT perms FROM iam_menu WHERE parent_id = ? AND kind = ? ORDER BY sort_no',
    [page.id, 'action'],
  )
  const { 'assign-users': assignUsers, ...pagePerms } = rolePerms
  expect(actions.map((a: { perms: string }) => a.perms)).toEqual(Object.values(pagePerms))
  const hidden = await one(
    "SELECT id, parent_id, kind, name, route_path, component, component_name, visible, keep_alive FROM iam_menu WHERE route_name = 'iam-role-users'",
  )
  expect(hidden).toMatchObject({
    parent_id: page.id,
    kind: 'page',
    name: 'menu.iam.roleUsers',
    route_path: '/iam/roles/:id/users',
    component: 'platform/iam/role/assign-users',
    component_name: 'IamRoleAssignUsers',
    visible: 0,
    keep_alive: 0,
  })
  const held = await ds.query('SELECT perms FROM iam_menu WHERE parent_id = ? AND kind = ?', [
    hidden.id,
    'action',
  ])
  expect(held.map((a: { perms: string }) => a.perms)).toEqual([assignUsers])
})

it('demo: devtools group (+ the external docs link) → demo group → book, topic, invoice and realtime pages → one action per perm', async () => {
  await runSeeds(ds)
  const menu = (routeName: string) =>
    one(
      'SELECT id, parent_id, kind, name, route_path, component, component_name FROM iam_menu WHERE route_name = ?',
      [routeName],
    )
  const devtools = await menu('devtools')
  expect(devtools).toMatchObject({ parent_id: 0, kind: 'group', name: 'menu.devtools.title' })
  // the sample external link: no route, no view (menus)
  expect(
    await one(
      "SELECT parent_id, kind, name, route_path, component, link_type, link_url, sort_no FROM iam_menu WHERE route_name = 'devtools-ui-docs'",
    ),
  ).toEqual({
    parent_id: devtools.id,
    kind: 'page',
    name: 'menu.devtools.uiDocs',
    route_path: '',
    component: null,
    link_type: 'external',
    link_url: 'https://element-plus.org/',
    sort_no: 30,
  })
  const demo = await menu('demo')
  expect(demo).toMatchObject({ parent_id: devtools.id, kind: 'group', name: 'menu.demo.title' })
  const page = await menu('demo-book')
  expect(page).toMatchObject({
    parent_id: demo.id,
    kind: 'page',
    name: 'menu.demo.book',
    route_path: '/demo/books',
    component: 'demo/book/index',
    component_name: 'DemoBook',
  })
  const actions = await ds.query(
    'SELECT perms FROM iam_menu WHERE parent_id = ? AND kind = ? ORDER BY sort_no',
    [page.id, 'action'],
  )
  expect(actions.map((a: { perms: string }) => a.perms)).toEqual(Object.values(bookPerms))
  // the generated tree sample, after the books
  const topic = await menu('demo-topic')
  expect(topic).toMatchObject({
    parent_id: demo.id,
    kind: 'page',
    name: 'menu.demo.topic',
    route_path: '/demo/topics',
    component: 'demo/topic/index',
    component_name: 'DemoTopic',
  })
  const pages = await ds.query(
    'SELECT route_name FROM iam_menu WHERE parent_id = ? AND kind = ? ORDER BY sort_no',
    [demo.id, 'page'],
  )
  expect(pages.map((p: { route_name: string }) => p.route_name)).toEqual([
    'demo-book',
    'demo-topic',
    'demo-invoice',
    'demo-realtime',
  ])
  const topicActions = await ds.query(
    'SELECT perms FROM iam_menu WHERE parent_id = ? AND kind = ? ORDER BY sort_no',
    [topic.id, 'action'],
  )
  expect(topicActions.map((a: { perms: string }) => a.perms)).toEqual(Object.values(topicPerms))
  // the generated master-sub sample, after the topics
  const invoice = await menu('demo-invoice')
  expect(invoice).toMatchObject({
    parent_id: demo.id,
    kind: 'page',
    name: 'menu.demo.invoice',
    route_path: '/demo/invoices',
    component: 'demo/invoice/index',
    component_name: 'DemoInvoice',
  })
  const invoiceActions = await ds.query(
    'SELECT perms FROM iam_menu WHERE parent_id = ? AND kind = ? ORDER BY sort_no',
    [invoice.id, 'action'],
  )
  expect(invoiceActions.map((a: { perms: string }) => a.perms)).toEqual(Object.values(invoicePerms))
  // the hand-written realtime push demo, last
  const realtime = await menu('demo-realtime')
  expect(realtime).toMatchObject({
    parent_id: demo.id,
    kind: 'page',
    name: 'menu.demo.realtime',
    route_path: '/demo/realtime',
    component: 'demo/realtime/index',
    component_name: 'DemoRealtime',
  })
  const realtimeActions = await ds.query(
    'SELECT perms, name FROM iam_menu WHERE parent_id = ? AND kind = ? ORDER BY sort_no',
    [realtime.id, 'action'],
  )
  expect(realtimeActions).toEqual([
    { perms: demoRealtimePerms.send, name: 'menu.action.send' },
    { perms: demoRealtimePerms.broadcast, name: 'menu.action.broadcast' },
  ])
})

it('users: system group → user page (first) → one action per userPerms, assign-roles under the hidden assign-roles page', async () => {
  await runSeeds(ds)
  const group = await one("SELECT id FROM iam_menu WHERE route_name = 'system'")
  const pages = await ds.query(
    "SELECT route_name FROM iam_menu WHERE parent_id = ? AND kind = 'page' ORDER BY sort_no",
    [group.id],
  )
  expect(pages.map((p: { route_name: string }) => p.route_name)).toEqual([
    'iam-user',
    'iam-role',
    'iam-menu',
    'iam-dept',
    'iam-position',
    'settings-dict',
    'settings-param',
    'settings-app-version',
    'geo-area',
    'oauth-client',
  ])
  const page = await one(
    "SELECT id, kind, name, route_path, component, component_name, visible, keep_alive FROM iam_menu WHERE route_name = 'iam-user'",
  )
  expect(page).toMatchObject({
    kind: 'page',
    name: 'menu.iam.user',
    route_path: '/iam/users',
    component: 'platform/iam/user/index',
    component_name: 'IamUser',
    visible: 1,
    keep_alive: 1,
  })
  const children = await ds.query(
    'SELECT id, kind, route_name, perms FROM iam_menu WHERE parent_id = ? ORDER BY sort_no',
    [page.id],
  )
  const { 'assign-roles': assignRoles, ...pagePerms } = userPerms
  expect(
    children
      .filter((c: { kind: string }) => c.kind === 'action')
      .map((c: { perms: string }) => c.perms),
  ).toEqual(Object.values(pagePerms))
  const hidden = await one(
    "SELECT id, parent_id, kind, name, route_path, component, component_name, visible, keep_alive FROM iam_menu WHERE route_name = 'iam-user-roles'",
  )
  expect(hidden).toMatchObject({
    parent_id: page.id,
    kind: 'page',
    name: 'menu.iam.userRoles',
    route_path: '/iam/users/:id/roles',
    component: 'platform/iam/user/assign-roles',
    component_name: 'IamUserAssignRoles',
    visible: 0,
    keep_alive: 0,
  })
  expect(await one('SELECT parent_id, kind FROM iam_menu WHERE perms = ?', [assignRoles])).toEqual({
    parent_id: hidden.id,
    kind: 'action',
  })
})

it('every module seeds its own menus once: one action per perm of each module, pages on existing views', async () => {
  await runSeeds(ds)
  const actions: { perms: string; n: number }[] = await ds.query(
    "SELECT perms, COUNT(*) AS n FROM iam_menu WHERE kind = 'action' GROUP BY perms ORDER BY perms",
  )
  expect(actions.filter((a) => Number(a.n) !== 1)).toEqual([])
  const perms = [
    userPerms,
    deptPerms,
    positionPerms,
    rolePerms,
    menuPerms,
    sessionPerms,
    monitorPerms,
    geoPerms,
    bookPerms,
    topicPerms,
    invoicePerms,
    demoRealtimePerms,
    dictPerms,
    dictEntryPerms,
    paramPerms,
    bulletinPerms,
    inboxTemplatePerms,
    inboxPerms,
    mailAccountPerms,
    mailTemplatePerms,
    mailRecordPerms,
    smsChannelPerms,
    smsTemplatePerms,
    smsRecordPerms,
    actionLogPerms,
    signinLogPerms,
    httpTracePerms,
    httpFaultPerms,
    codegenPerms,
    configPerms,
    storageObjectPerms,
    taskPerms,
    runPerms,
    wfPerms.model,
    wfPerms.form,
    wfPerms.instance,
    wfPerms.task,
    wfPerms.data,
  ]
    .flatMap((p) => Object.values(p))
    .sort()
  expect(perms.filter((p) => !actions.some((a) => a.perms === p))).toEqual([])
  // route names are unique (index); every routed page points at a view of the web app
  const pages: { route_name: string; component: string }[] = await ds.query(
    "SELECT route_name, component FROM iam_menu WHERE kind = 'page' AND link_type = 'route'",
  )
  const views = new URL('../../../web/src/views/', import.meta.url)
  expect(
    pages.filter((p) => !existsSync(new URL(`${p.component}.vue`, views))).map((p) => p.component),
  ).toEqual([])
  // hidden sub-pages (see docs/design-notes.md#layering) sit under their page, each holding the actions that open it; the
  // login-only workflow ones hold none (the instance detail opens from every center list: its group)
  const hidden: { route_name: string; parent: string; perms: string }[] = await ds.query(
    `SELECT h.route_name, p.route_name AS parent, a.perms FROM iam_menu h
       JOIN iam_menu p ON p.id = h.parent_id
       LEFT JOIN iam_menu a ON a.parent_id = h.id AND a.kind = 'action'
      WHERE h.kind = 'page' AND h.visible = 0 ORDER BY h.route_name, a.sort_no`,
  )
  expect(hidden).toEqual([
    { route_name: 'biz-leave-new', parent: 'biz-leave', perms: null },
    { route_name: 'biz-leave-view', parent: 'biz-leave', perms: null },
    { route_name: 'codegen-table-edit', parent: 'codegen-table', perms: codegenPerms.modify },
    { route_name: 'iam-role-users', parent: 'iam-role', perms: rolePerms['assign-users'] },
    { route_name: 'iam-user-roles', parent: 'iam-user', perms: userPerms['assign-roles'] },
    ...Object.values(dictEntryPerms).map((perms) => ({
      route_name: 'settings-dict-entry',
      parent: 'settings-dict',
      perms,
    })),
    { route_name: 'wf-instance-detail', parent: 'workflow', perms: null },
    { route_name: 'wf-instance-view', parent: 'wf-instance', perms: wfPerms.instance.view },
    { route_name: 'wf-model-design', parent: 'wf-model', perms: wfPerms.model.publish },
    // 模型管理's 向导 (shown with the design right, whose action sits on wf-model-design) reopens a
    // model in the wizard; the wizard page itself holds no action either (the model / form perms decide)
    { route_name: 'wf-wizard-edit', parent: 'wf-wizard', perms: null },
  ])
})

it('Menus: system → dicts, params; messaging → bulletins; audit → action / sign-in logs; devtools → the generator page and its hidden edit page', async () => {
  await runSeeds(ds)
  const menu = (routeName: string) =>
    one(
      'SELECT id, parent_id, kind, name, route_path, component, component_name, visible, keep_alive FROM iam_menu WHERE route_name = ?',
      [routeName],
    )
  const actionsOf = async (id: number) =>
    (
      await ds.query('SELECT perms FROM iam_menu WHERE parent_id = ? AND kind = ? ORDER BY perms', [
        id,
        'action',
      ])
    ).map((a: { perms: string }) => a.perms)
  const groups: Record<string, string> = {
    system: 'menu.system.title',
    messaging: 'menu.messaging.title',
    audit: 'menu.audit.title',
  }
  for (const [route, name] of Object.entries(groups))
    expect(await menu(route)).toMatchObject({
      parent_id: route === 'system' ? 0 : (await menu('system')).id,
      kind: 'group',
      name,
    })
  const pages: [group: string, route: string, path: string, view: string, perms: object][] = [
    ['system', 'settings-dict', '/settings/dicts', 'platform/settings/dict/index', dictPerms],
    ['system', 'settings-param', '/settings/params', 'platform/settings/param/index', paramPerms],
    [
      'system',
      'settings-app-version',
      '/settings/app-versions',
      'platform/settings/app-version/index',
      appVersionPerms,
    ],
    [
      'messaging',
      'messaging-bulletin',
      '/messaging/bulletins',
      'platform/messaging/bulletin/index',
      bulletinPerms,
    ],
    [
      'audit',
      'audit-action-log',
      '/audit/action-logs',
      'platform/audit/action-log/index',
      actionLogPerms,
    ],
    [
      'audit',
      'audit-signin-log',
      '/audit/signin-logs',
      'platform/audit/signin-log/index',
      signinLogPerms,
    ],
  ]
  for (const [group, route, path, view, perms] of pages) {
    const page = await menu(route)
    expect(page).toMatchObject({
      parent_id: (await menu(group)).id,
      kind: 'page',
      route_path: path,
      component: view,
      visible: 1,
      keep_alive: 1,
    })
    expect(await actionsOf(page.id)).toEqual(Object.values(perms).sort())
  }
  // the generator page first under 开发工具; `modify` opens the hidden edit page, so it sits there
  const devtools = await menu('devtools')
  const codegen = await menu('codegen-table')
  expect(codegen).toMatchObject({
    parent_id: devtools.id,
    kind: 'page',
    name: 'menu.codegen.table',
    route_path: '/codegen/tables',
    component: 'platform/codegen/index',
    component_name: 'CodegenTable',
    visible: 1,
    keep_alive: 1,
  })
  const { modify, ...pagePerms } = codegenPerms
  expect(await actionsOf(codegen.id)).toEqual(Object.values(pagePerms).sort())
  const edit = await menu('codegen-table-edit')
  expect(edit).toMatchObject({
    parent_id: codegen.id,
    kind: 'page',
    name: 'menu.codegen.tableEdit',
    route_path: '/codegen/tables/:id',
    component: 'platform/codegen/edit',
    component_name: 'CodegenTableEdit',
    visible: 0,
    keep_alive: 0,
  })
  expect(await actionsOf(edit.id)).toEqual([modify])
  const children = await ds.query(
    'SELECT route_name FROM iam_menu WHERE parent_id = ? AND kind <> ? ORDER BY sort_no',
    [devtools.id, 'action'],
  )
  expect(children.map((c: { route_name: string }) => c.route_name)).toEqual([
    'codegen-table',
    'formkit-design',
    'devtools-api-docs',
    'devtools-ui-docs',
    'demo',
  ])
  // The form builder, no actions (nothing to call on the server), no keep-alive (the designer's
  // hotkeys listen on the document while it is mounted)
  const formkit = await menu('formkit-design')
  expect(formkit).toMatchObject({
    parent_id: devtools.id,
    kind: 'page',
    name: 'menu.formkit.design',
    route_path: '/formkit/design',
    component: 'platform/formkit/index',
    component_name: 'FormkitDesign',
    visible: 1,
    keep_alive: 0,
  })
  expect(await actionsOf(formkit.id)).toEqual([])
  // The Swagger UI in an iframe, no view (GET /menus drops it without SWAGGER_ENABLED)
  expect(
    await one(
      "SELECT kind, name, route_path, component, component_name, link_type, link_url, keep_alive FROM iam_menu WHERE route_name = 'devtools-api-docs'",
    ),
  ).toEqual({
    kind: 'page',
    name: 'menu.devtools.apiDocs',
    route_path: '/devtools/api-docs',
    component: null,
    component_name: 'DevtoolsApiDocs',
    link_type: 'iframe',
    link_url: '/api/docs',
    keep_alive: 1,
  })
})

it('Menus: monitor → online users, server, Redis, cache, MySQL; system → regions; one action per perm', async () => {
  await runSeeds(ds)
  const menu = (routeName: string) =>
    one(
      'SELECT id, parent_id, kind, name, route_path, component, component_name, keep_alive FROM iam_menu WHERE route_name = ?',
      [routeName],
    )
  const actionsOf = async (id: number) =>
    (
      await ds.query('SELECT perms FROM iam_menu WHERE parent_id = ? AND kind = ? ORDER BY perms', [
        id,
        'action',
      ])
    ).map((a: { perms: string }) => a.perms)
  const monitor = await menu('monitor')
  expect(monitor).toMatchObject({ parent_id: 0, kind: 'group', name: 'menu.monitor.title' })
  const { cache, cacheClear, ...browseOnly } = monitorPerms
  const pages: [route: string, group: number, path: string, view: string, perms: string[]][] = [
    [
      'iam-session',
      monitor.id,
      '/monitor/sessions',
      'platform/iam/session/index',
      Object.values(sessionPerms),
    ],
    ...(['server', 'redis', 'mysql'] as const).map(
      (p): [string, number, string, string, string[]] => [
        `monitor-${p}`,
        monitor.id,
        `/monitor/${p}`,
        `platform/monitor/${p}/index`,
        [browseOnly[p]],
      ],
    ),
    [
      'monitor-cache',
      monitor.id,
      '/monitor/cache',
      'platform/monitor/cache/index',
      [cache, cacheClear],
    ],
    [
      'geo-area',
      (await menu('system')).id,
      '/geo/areas',
      'platform/geo/area/index',
      Object.values(geoPerms),
    ],
  ]
  for (const [route, parent, path, view, perms] of pages) {
    const page = await menu(route)
    // the route name in both sides: a failure names the page
    expect({ route, ...page, actions: await actionsOf(page.id) }).toMatchObject({
      route,
      parent_id: parent,
      kind: 'page',
      route_path: path,
      component: view,
      keep_alive: 1,
      actions: [...perms].sort(),
    })
  }
  const children = await ds.query(
    'SELECT route_name FROM iam_menu WHERE parent_id = ? AND kind = ? ORDER BY sort_no',
    [monitor.id, 'page'],
  )
  expect(children.map((c: { route_name: string }) => c.route_name)).toEqual([
    'iam-session',
    'scheduler-task',
    'scheduler-run',
    'monitor-server',
    'monitor-redis',
    'monitor-cache',
    'monitor-mysql',
  ])
})

it('menu groups and pages follow the requested order', async () => {
  await runSeeds(ds)
  const children = async (parent: number) =>
    (
      await ds.query(
        'SELECT route_name FROM iam_menu WHERE parent_id = ? AND kind <> ? ORDER BY sort_no, id',
        [parent, 'action'],
      )
    ).map((r: { route_name: string }) => r.route_name)
  const id = async (route: string) =>
    (await one('SELECT id FROM iam_menu WHERE route_name = ?', [route])).id
  expect(await children(0)).toEqual(['home', 'workflow', 'biz', 'system', 'monitor', 'devtools'])
  expect(await children(await id('workflow'))).toEqual([
    'wf-start',
    'wf-todo',
    'wf-done',
    'wf-mine',
    'wf-cc',
    'biz-leave',
    'wf-instance-detail',
    'wf-admin',
  ])
  expect(await children(await id('wf-admin'))).toEqual([
    'wf-wizard',
    'wf-model',
    'wf-form',
    'wf-instance',
    'wf-task',
    'wf-data',
  ])
  expect(await children(await id('system'))).toEqual([
    'iam-user',
    'iam-role',
    'iam-menu',
    'iam-dept',
    'iam-position',
    'settings-dict',
    'settings-param',
    'settings-app-version',
    'geo-area',
    'messaging',
    'audit',
    'storage',
    'oauth-client',
  ])
  expect(await children(await id('messaging'))).toEqual([
    'messaging-bulletin',
    'messaging-inbox-template',
    'messaging-inbox',
    'messaging-mail-account',
    'messaging-mail-template',
    'messaging-mail-record',
    'messaging-sms-channel',
    'messaging-sms-template',
    'messaging-sms-record',
  ])
  expect(await children(await id('audit'))).toEqual([
    'audit-action-log',
    'audit-signin-log',
    'audit-http-trace',
    'audit-http-fault',
  ])
  expect(await children(await id('storage'))).toEqual(['storage-object', 'storage-config'])
  expect(await children(await id('monitor'))).toEqual([
    'iam-session',
    'scheduler-task',
    'scheduler-run',
    'monitor-server',
    'monitor-redis',
    'monitor-cache',
    'monitor-mysql',
  ])
  expect(await children(await id('devtools'))).toEqual([
    'codegen-table',
    'formkit-design',
    'devtools-api-docs',
    'devtools-ui-docs',
    'demo',
  ])
  expect(
    await ds.query(
      "SELECT route_name FROM iam_menu WHERE kind = 'group' AND route_name IN ('iam', 'settings', 'scheduler')",
    ),
  ).toEqual([])
})

it('built-in menu groups: exactly BUILTIN_MENU_GROUPS, every generator prefix parent among them; 业务管理 at the top level', async () => {
  await runSeeds(ds)
  const live: string[] = (
    await ds.query("SELECT route_name FROM iam_menu WHERE kind = 'group' AND deleted_at IS NULL")
  ).map((r: { route_name: string }) => r.route_name)
  expect(live.sort()).toEqual([...BUILTIN_MENU_GROUPS].sort())
  for (const { parentMenuRouteName } of Object.values(TABLE_PREFIXES))
    expect(BUILTIN_MENU_GROUPS).toContain(parentMenuRouteName)
  expect(
    await one(
      "SELECT parent_id, kind, name, route_path, icon FROM iam_menu WHERE route_name = 'biz'",
    ),
  ).toEqual({
    parent_id: 0,
    kind: 'group',
    name: 'menu.biz.title',
    route_path: '/biz',
    icon: 'lucide:briefcase',
  })
})

const group = (routeName: string, parent: string | null, extra = {}): ProjectMenuGroup => ({
  routeName,
  parent,
  name: `${routeName} zh`,
  nameI18n: { 'zh-CN': `${routeName} zh`, 'en-US': `${routeName} en` },
  routePath: `/${routeName}`,
  icon: null,
  sortNo: 10,
  ...extra,
})

it('project menu groups (menu-groups.seed.ts): inserted once under their parents; never updated, revived or put live under a deleted parent; a parent missing is an error', async () => {
  await runSeeds(ds)
  const groups = [
    group('pdg', 'biz', { icon: 'lucide:package', sortNo: 50 }),
    group('pdg-sale', 'pdg'),
    group('pdg-top', null),
  ]
  const seed = (list: ProjectMenuGroup[]) => ds.transaction((q) => seedProjectMenuGroups(q, list))
  const row = (route: string) =>
    one(
      `SELECT m.id, m.kind, m.name, m.name_i18n, m.route_path, m.icon, m.sort_no, m.tree_path,
              m.deleted_at IS NULL AS live, p.route_name AS parent, p.tree_path AS parent_path
         FROM iam_menu m LEFT JOIN iam_menu p ON p.id = m.parent_id WHERE m.route_name = ?`,
      [route],
    )
  expect(await seed(groups)).toEqual([])
  expect(await row('pdg')).toMatchObject({
    kind: 'group',
    name: 'pdg zh',
    name_i18n: { 'zh-CN': 'pdg zh', 'en-US': 'pdg en' },
    route_path: '/pdg',
    icon: 'lucide:package',
    sort_no: 50,
    parent: 'biz',
  })
  const sale = await row('pdg-sale')
  expect(sale).toMatchObject({ parent: 'pdg', live: 1 })
  expect(sale.tree_path).toBe(`${sale.parent_path}${sale.id}/`)
  expect(await row('pdg-top')).toMatchObject({ parent: null, sort_no: 10 })

  // the administrator owns them: edits stay, a deleted one stays deleted
  await ds.query("UPDATE iam_menu SET name = 'admin', sort_no = 7 WHERE route_name = 'pdg'")
  await ds.query("UPDATE iam_menu SET deleted_at = NOW(3) WHERE route_name = 'pdg-top'")
  expect(await seed(groups)).toEqual([])
  expect(await row('pdg')).toMatchObject({ name: 'admin', sort_no: 7, live: 1 })
  expect(await row('pdg-top')).toMatchObject({ live: 0 })
  expect((await one("SELECT COUNT(*) AS n FROM iam_menu WHERE route_name LIKE 'pdg%'")).n).toBe(3)
  // a new group under a deleted one: stored deleted with a notice; a parent neither built in nor listed above
  await ds.query("UPDATE iam_menu SET deleted_at = NOW(3) WHERE route_name IN ('pdg-sale', 'pdg')")
  expect(await seed([...groups, group('pdg-new', 'pdg')])).toEqual([
    'seed: menu group pdg-new stored as deleted: its parent pdg was deleted',
  ])
  expect(await row('pdg-new')).toMatchObject({ parent: 'pdg', live: 0 })
  expect(await seed([...groups, group('pdg-new', 'pdg')])).toEqual([])
  await expect(seed([group('pdg-orphan', 'pdg-nowhere')])).rejects.toThrow(
    'the parent group pdg-nowhere of pdg-orphan is missing',
  )
  // a live page of that route name is no parent group (menuParentAllows)
  expect(
    await one("SELECT kind FROM iam_menu WHERE route_name = 'demo-book' AND deleted_at IS NULL"),
  ).toEqual({
    kind: 'page',
  })
  await expect(seed([group('pdg-under-page', 'demo-book')])).rejects.toThrow(
    'the parent group demo-book of pdg-under-page is missing',
  )
  expect(await row('pdg-under-page')).toBeUndefined()
  // the file's list runs with the seeds (SEEDS.project)
  PROJECT_MENU_GROUPS.push(group('pdg-listed', 'biz'))
  try {
    await runSeeds(ds, ['project'])
  } finally {
    PROJECT_MENU_GROUPS.pop()
  }
  expect(await row('pdg-listed')).toMatchObject({ parent: 'biz', live: 1 })
})

it('project menu groups under a deleted built-in group: stored deleted, so the seed and a module seed under them go on; a group re-created live wins', async () => {
  await runSeeds(ds)
  await ds.query("UPDATE iam_menu SET deleted_at = NOW(3) WHERE route_name = 'biz'")
  const list = [group('erp', 'biz'), group('erp-sale', 'erp')]
  expect(await ds.transaction((q) => seedProjectMenuGroups(q, list))).toEqual([
    'seed: menu group erp stored as deleted: its parent biz was deleted',
    'seed: menu group erp-sale stored as deleted: its parent erp was deleted',
  ])
  // what a generated module seed under erp-sale looks up: a deleted group (its menus skipped)
  const lookup = () =>
    ds.transaction((q) => findRow(q, 'iam_menu', { route_name: 'erp-sale', kind: 'group' }))
  expect(await lookup()).toMatchObject({ deleted: true })
  // the administrator re-creates it in the menu page: the live row is found, nothing is added
  const live = await insertRow(ds.manager, 'iam_menu', {
    parent_id: 0,
    kind: 'group',
    route_name: 'erp-sale',
    name: 'erp-sale',
    route_path: '/erp-sale',
  })
  expect(await lookup()).toEqual({ id: live, deleted: false })
  expect(await ds.transaction((q) => seedProjectMenuGroups(q, list))).toEqual([])
  expect(
    (await one("SELECT COUNT(*) AS n FROM iam_menu WHERE route_name IN ('erp', 'erp-sale')")).n,
  ).toBe(3)
})

it('project action verbs (action-verbs.seed.ts): inserted once as audit.verb items after the last one; never updated or revived; the dict and the platform items untouched', async () => {
  await runSeeds(ds)
  const entries = () =>
    ds.query(
      `SELECT value, label, label_i18n, sort_no, tag_type, enabled, deleted_at IS NULL AS live
         FROM cfg_dict_entry WHERE dict_code = 'audit.verb' ORDER BY sort_no, value`,
    )
  const dict = () => one("SELECT name, name_i18n FROM cfg_dict WHERE code = 'audit.verb'")
  const platform = await entries()
  const dictBefore = await dict()
  const last = Math.max(...platform.map((e: { sort_no: number }) => e.sort_no))
  const verbs: ProjectActionVerb[] = [
    ['pdv-upgrade', '升级为 VIP', 'Upgrade to VIP', 'success'],
    ['pdv-archive', '归档', 'Archive'],
  ]
  const seed = (list: readonly ProjectActionVerb[]) =>
    ds.transaction((q) => seedProjectActionVerbs(q, list))
  try {
    expect(await seed(verbs)).toEqual([])
    const added = (await entries()).slice(platform.length)
    expect(added).toEqual([
      {
        value: 'pdv-upgrade',
        label: '升级为 VIP',
        label_i18n: { 'zh-CN': '升级为 VIP', 'en-US': 'Upgrade to VIP' },
        sort_no: last + 10,
        tag_type: 'success',
        enabled: 1,
        live: 1,
      },
      expect.objectContaining({ value: 'pdv-archive', sort_no: last + 20, tag_type: null }),
    ])
    // the administrator owns them: an edited label and a deleted item stay so; a re-run inserts nothing
    await ds.query(
      "UPDATE cfg_dict_entry SET label = 'admin', label_i18n = NULL, enabled = 0 WHERE value = 'pdv-upgrade'",
    )
    await ds.query("UPDATE cfg_dict_entry SET deleted_at = NOW(3) WHERE value = 'pdv-archive'")
    expect(await seed(verbs)).toEqual([])
    const rerun = await entries()
    expect(rerun.slice(platform.length)).toEqual([
      expect.objectContaining({
        value: 'pdv-upgrade',
        label: 'admin',
        label_i18n: null,
        enabled: 0,
      }),
      expect.objectContaining({ value: 'pdv-archive', live: 0 }),
    ])
    // the platform items, their order and the dict's name are untouched, the whole seed run included
    PROJECT_ACTION_VERBS.push(['pdv-listed', '列出', 'Listed'])
    try {
      await runSeeds(ds)
    } finally {
      PROJECT_ACTION_VERBS.pop()
    }
    const all = await entries()
    expect(all.slice(0, platform.length)).toEqual(platform)
    expect(await dict()).toEqual(dictBefore)
    // the file's list runs with the seeds (SEEDS.project)
    expect(all.slice(platform.length).map((e: { value: string }) => e.value)).toEqual([
      'pdv-upgrade',
      'pdv-archive',
      'pdv-listed',
    ])
    expect((await one("SELECT COUNT(*) AS n FROM cfg_dict_entry WHERE value LIKE 'pdv-%'")).n).toBe(
      3,
    )
  } finally {
    await ds.query("DELETE FROM cfg_dict_entry WHERE value LIKE 'pdv-%'")
  }
})

it('generated seeds: a project page keeps its parent, icon and sort once inserted, a platform page gets them back; a deleted parent group skips the module, a missing one is an error', async () => {
  await runSeeds(ds)
  const page = (route: string) =>
    one(
      `SELECT m.id, p.route_name AS parent, m.icon, m.sort_no FROM iam_menu m
         JOIN iam_menu p ON p.id = m.parent_id WHERE m.route_name = ?`,
      [route],
    )
  // an administrator moved both pages (and their actions) under the monitor group
  const monitor = await one("SELECT id, tree_path FROM iam_menu WHERE route_name = 'monitor'")
  for (const route of ['demo-book', 'iam-position']) {
    const p = await one('SELECT id, tree_path FROM iam_menu WHERE route_name = ?', [route])
    await ds.query(
      "UPDATE iam_menu SET parent_id = ?, icon = 'lucide:star', sort_no = 999 WHERE id = ?",
      [monitor.id, p.id],
    )
    await ds.query(
      'UPDATE iam_menu SET tree_path = CONCAT(?, SUBSTRING(tree_path, ?)) WHERE tree_path LIKE ?',
      [`${monitor.tree_path}${p.id}/`, p.tree_path.length + 1, `${p.tree_path}%`],
    )
  }
  await runSeeds(ds)
  expect(await page('demo-book')).toMatchObject({
    parent: 'monitor',
    icon: 'lucide:star',
    sort_no: 999,
  })
  expect(await page('iam-position')).toMatchObject({
    parent: 'system',
    icon: 'lucide:briefcase-business',
    sort_no: 50,
  })

  // the demo group deleted with what is left below it: the samples' generated menus are skipped
  const demo = await one("SELECT tree_path FROM iam_menu WHERE route_name = 'demo'")
  await ds.query('UPDATE iam_menu SET deleted_at = NOW(3) WHERE tree_path LIKE ?', [
    `${demo.tree_path}%`,
  ])
  const count = async () => (await one('SELECT COUNT(*) AS n FROM iam_menu')).n
  const before = await count()
  const notices = await runSeeds(ds)
  for (const noun of ['book', 'topic', 'invoice'])
    expect(notices).toContain(
      `seed: the demo menu group was deleted: the ${noun} menus are skipped`,
    )
  expect(await count()).toBe(before)
  expect(
    await one(
      "SELECT COUNT(*) AS n FROM iam_menu WHERE route_name = 'demo-topic' AND deleted_at IS NULL",
    ),
  ).toEqual({ n: 0 })

  // no demo group at all: an error
  await truncate()
  await expect(ds.transaction((q) => seedBook(q))).rejects.toThrow(
    'seedBook: the demo menu group is missing',
  )
})

it('moves an existing granted page, removes empty old groups and updates generator parents', async () => {
  await runSeeds(ds)
  const oldId = await insertRow(ds.manager, 'iam_menu', {
    parent_id: 0,
    kind: 'group',
    name: 'menu.iam.title',
    route_name: 'iam',
    route_path: '/iam',
  })
  const page = await one("SELECT id FROM iam_menu WHERE route_name = 'iam-user'")
  await ds.query('UPDATE iam_menu SET parent_id = ?, tree_path = ? WHERE id = ?', [
    oldId,
    `/${oldId}/${page.id}/`,
    page.id,
  ])
  const userId = await ds.transaction((q) => seedLimitedUser(q, 'menu-migration', 'Limited@123'))
  const role = await one("SELECT id FROM iam_role WHERE code = 'demo'")
  await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?), (?, ?)', [
    role.id,
    oldId,
    role.id,
    page.id,
  ])
  await ds.query(
    "UPDATE cg_table SET parent_menu_route_name = 'iam' WHERE table_name = 'iam_position'",
  )
  await runSeeds(ds)
  await runSeeds(ds)
  const system = await one("SELECT id, tree_path FROM iam_menu WHERE route_name = 'system'")
  expect(await one('SELECT parent_id, tree_path FROM iam_menu WHERE id = ?', [page.id])).toEqual({
    parent_id: system.id,
    tree_path: `${system.tree_path}${page.id}/`,
  })
  expect(await one(LIVE_MENU, [oldId])).toBeUndefined()
  expect(await one(LIVE_GRANT, [oldId])).toBeUndefined()
  expect(
    await one("SELECT parent_menu_route_name FROM cg_table WHERE table_name = 'iam_position'"),
  ).toEqual({
    parent_menu_route_name: 'system',
  })
  const tree = await new IamUserLookup(ds).menus(userId, false)
  expect(tree.map((n) => n.routeName)).toEqual(['home', 'system'])
  expect(tree.find((n) => n.routeName === 'system')?.children.map((n) => n.routeName)).toEqual([
    'iam-user',
  ])
})

it('--only keeps an obsolete group with an admin page until that page is removed', async () => {
  await runSeeds(ds)
  const oldSettings = await insertRow(ds.manager, 'iam_menu', {
    parent_id: 0,
    kind: 'group',
    name: 'old settings',
    route_name: 'settings',
    route_path: '/settings',
  })
  const oldScheduler = await insertRow(ds.manager, 'iam_menu', {
    parent_id: 0,
    kind: 'group',
    name: 'old scheduler',
    route_name: 'scheduler',
    route_path: '/scheduler',
  })
  const custom = await insertRow(ds.manager, 'iam_menu', {
    parent_id: oldSettings,
    kind: 'page',
    name: 'custom',
    route_name: 'custom-page',
    route_path: '/custom',
  })
  const root = await one("SELECT id FROM iam_role WHERE code = 'root'")
  await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?), (?, ?)', [
    root.id,
    oldSettings,
    root.id,
    oldScheduler,
  ])
  await ds.query(
    "UPDATE cg_table SET parent_menu_route_name = 'settings' WHERE table_name = 'demo_book'",
  )
  await ds.query(
    "UPDATE cg_table SET parent_menu_route_name = 'scheduler' WHERE table_name = 'demo_topic'",
  )
  await runSeeds(ds, ['iam'])
  expect(await one('SELECT id FROM iam_menu WHERE id = ?', [oldSettings])).toEqual({
    id: oldSettings,
  })
  expect(await one(LIVE_MENU, [oldScheduler])).toBeUndefined()
  expect(await one(LIVE_GRANT, [oldScheduler])).toBeUndefined()
  expect(
    await ds.query(
      "SELECT table_name, parent_menu_route_name FROM cg_table WHERE table_name IN ('demo_book', 'demo_topic') ORDER BY table_name",
    ),
  ).toEqual([
    { table_name: 'demo_book', parent_menu_route_name: 'system' },
    { table_name: 'demo_topic', parent_menu_route_name: 'monitor' },
  ])
  // an admin deletes the page (soft): a deleted child no longer keeps the group
  await ds.query('UPDATE iam_menu SET deleted_at = NOW(3) WHERE id = ?', [custom])
  await runSeeds(ds, ['iam'])
  expect(await one(LIVE_MENU, [oldSettings])).toBeUndefined()
  expect(await one(LIVE_GRANT, [oldSettings])).toBeUndefined()
})

it('Menus: storage → file list, configs; monitor → tasks, run log; one action per perm', async () => {
  await runSeeds(ds)
  const menu = (routeName: string) =>
    one(
      'SELECT id, parent_id, kind, name, route_path, component, component_name, keep_alive FROM iam_menu WHERE route_name = ?',
      [routeName],
    )
  const actionsOf = async (id: number) =>
    (
      await ds.query('SELECT perms FROM iam_menu WHERE parent_id = ? AND kind = ? ORDER BY perms', [
        id,
        'action',
      ])
    ).map((a: { perms: string }) => a.perms)
  const pages: [route: string, group: string, path: string, view: string, perms: object][] = [
    ['storage-config', 'storage', '/storage/configs', 'platform/storage/config/index', configPerms],
    [
      'storage-object',
      'storage',
      '/storage/objects',
      'platform/storage/object/index',
      storageObjectPerms,
    ],
    ['scheduler-task', 'monitor', '/scheduler/tasks', 'platform/scheduler/task/index', taskPerms],
    ['scheduler-run', 'monitor', '/scheduler/runs', 'platform/scheduler/run/index', runPerms],
    // Under system, with the reset-secret action
    ['oauth-client', 'system', '/oauth/clients', 'platform/oauth/client/index', clientPerms],
  ]
  for (const [route, group, path, view, perms] of pages) {
    const page = await menu(route)
    // the route name in both sides: a failure names the page
    expect({ route, ...page, actions: await actionsOf(page.id) }).toMatchObject({
      route,
      parent_id: (await menu(group)).id,
      kind: 'page',
      route_path: path,
      component: view,
      keep_alive: 1,
      actions: Object.values(perms).sort(),
    })
  }
  const children = async (group: string) =>
    (
      await ds.query(
        'SELECT route_name FROM iam_menu WHERE parent_id = ? AND kind = ? ORDER BY sort_no',
        [(await menu(group)).id, 'page'],
      )
    ).map((c: { route_name: string }) => c.route_name)
  expect(await children('storage')).toEqual(['storage-object', 'storage-config'])
  expect(await children('monitor')).toEqual([
    'iam-session',
    'scheduler-task',
    'scheduler-run',
    'monitor-server',
    'monitor-redis',
    'monitor-cache',
    'monitor-mysql',
  ])
})

it('Menus: messaging → bulletins, inbox templates, inbox messages, mail accounts, mail templates, mail records, SMS channels, SMS templates, SMS records; one action per perm', async () => {
  await runSeeds(ds)
  const group = await one("SELECT id FROM iam_menu WHERE route_name = 'messaging'")
  const pages: [string, string, string, object][] = [
    ['bulletin', 'bulletins', 'bulletin', bulletinPerms],
    ['inbox-template', 'inbox-templates', 'inbox-template', inboxTemplatePerms],
    ['inbox', 'inboxes', 'inbox', inboxPerms],
    ['mail-account', 'mail-accounts', 'mail-account', mailAccountPerms],
    ['mail-template', 'mail-templates', 'mail-template', mailTemplatePerms],
    ['mail-record', 'mail-records', 'mail-record', mailRecordPerms],
    ['sms-channel', 'sms-channels', 'sms-channel', smsChannelPerms],
    ['sms-template', 'sms-templates', 'sms-template', smsTemplatePerms],
    ['sms-record', 'sms-records', 'sms-record', smsRecordPerms],
  ]
  const rows: {
    id: number
    route_name: string
    parent_id: number
    kind: string
    route_path: string
    component: string
    keep_alive: number
  }[] = await ds.query(
    "SELECT id, route_name, parent_id, kind, route_path, component, keep_alive FROM iam_menu WHERE parent_id = ? AND kind = 'page' ORDER BY sort_no",
    [group.id],
  )
  expect(rows.map((r) => r.route_name)).toEqual(pages.map(([route]) => `messaging-${route}`))
  for (const [i, [, path, view, perms]] of pages.entries()) {
    const page = rows[i]
    expect(page).toMatchObject({
      parent_id: group.id,
      kind: 'page',
      route_path: `/messaging/${path}`,
      component: `platform/messaging/${view}/index`,
      keep_alive: 1,
    })
    const actions: { perms: string }[] = await ds.query(
      "SELECT perms FROM iam_menu WHERE parent_id = ? AND kind = 'action' ORDER BY perms",
      [page.id],
    )
    expect(actions.map((a) => a.perms)).toEqual(Object.values(perms).sort())
  }
})

it('Menus: workflow group after home → center pages, leave (hidden new/view), hidden instance detail, wf-admin → model, form, instance (hidden detail holding view), task; one action per wfPerms', async () => {
  await runSeeds(ds)
  const menu = (routeName: string) =>
    one(
      'SELECT id, parent_id, kind, name, route_path, component, component_name, visible, keep_alive FROM iam_menu WHERE route_name = ?',
      [routeName],
    )
  const actionsOf = async (id: number) =>
    (
      await ds.query('SELECT perms FROM iam_menu WHERE parent_id = ? AND kind = ? ORDER BY perms', [
        id,
        'action',
      ])
    ).map((a: { perms: string }) => a.perms)
  const group = await menu('workflow')
  expect(group).toMatchObject({ parent_id: 0, kind: 'group', name: 'menu.workflow.title' })
  expect(await menu('wf-admin')).toMatchObject({
    parent_id: group.id,
    kind: 'group',
    name: 'menu.wf.title',
  })
  type Page = [
    route: string,
    parent: string,
    path: string,
    view: string,
    name: string,
    perms?: object,
  ]
  const pages: Page[] = [
    ['wf-start', 'workflow', '/workflow/start', 'workflow/center/start', 'WfStart'],
    ['wf-todo', 'workflow', '/workflow/todo', 'workflow/center/todo', 'WfTodo'],
    ['wf-done', 'workflow', '/workflow/done', 'workflow/center/done', 'WfDone'],
    ['wf-mine', 'workflow', '/workflow/mine', 'workflow/center/mine', 'WfMine'],
    ['wf-cc', 'workflow', '/workflow/cc', 'workflow/center/cc', 'WfCc'],
    ['biz-leave', 'workflow', '/biz/leave', 'biz/leave/index', 'BizLeave', leavePerms],
    // The new-approval wizard, over the model / form perms (no actions of its own)
    ['wf-wizard', 'wf-admin', '/wf/wizard', 'workflow/admin/wizard/index', 'WfWizard'],
    [
      'wf-model',
      'wf-admin',
      '/wf/models',
      'workflow/admin/model',
      'WfModel',
      { ...wfPerms.model, publish: undefined },
    ],
    // The forms dynamic models bind
    ['wf-form', 'wf-admin', '/wf/forms', 'workflow/admin/form', 'WfForm', wfPerms.form],
    [
      'wf-instance',
      'wf-admin',
      '/wf/instances',
      'workflow/admin/instance',
      'WfInstance',
      { browse: wfPerms.instance.browse },
    ],
    ['wf-task', 'wf-admin', '/wf/tasks', 'workflow/admin/task', 'WfTask', wfPerms.task],
    // A model's instances by its form fields
    ['wf-data', 'wf-admin', '/wf/data', 'workflow/admin/data', 'WfData', wfPerms.data],
  ]
  const hidden: Page[] = [
    [
      'wf-instance-detail',
      'workflow',
      '/workflow/instances/:id',
      'workflow/center/detail',
      'WfInstanceDetail',
    ],
    ['biz-leave-new', 'biz-leave', '/biz/leave/new', 'biz/leave/new', 'BizLeaveNew'],
    ['biz-leave-view', 'biz-leave', '/biz/leave/:id', 'biz/leave/view', 'BizLeaveView'],
    // 实例管理's 查看 opens it: the hidden page holds wf.instance.view (a process admin gets the route)
    [
      'wf-instance-view',
      'wf-instance',
      '/wf/instances/:id',
      'workflow/center/detail',
      'WfInstanceDetail',
      { view: wfPerms.instance.view },
    ],
    // 模型管理's 向导 reopens a dynamic model in the wizard
    ['wf-wizard-edit', 'wf-wizard', '/wf/wizard/:id', 'workflow/admin/wizard/index', 'WfWizard'],
    // 模型管理's 设计 opens the designer, where the model is published
    [
      'wf-model-design',
      'wf-model',
      '/wf/models/:id/design',
      'workflow/admin/model-design',
      'WfModelDesign',
      { publish: wfPerms.model.publish },
    ],
  ]
  for (const [route, parent, path, view, name, perms = {}] of [...pages, ...hidden]) {
    const page = await menu(route)
    const shown = pages.some(([r]) => r === route) ? 1 : 0
    // the route name in both sides: a failure names the page
    expect({ route, ...page, actions: await actionsOf(page.id) }).toMatchObject({
      route,
      parent_id: (await menu(parent)).id,
      kind: 'page',
      route_path: path,
      component: view,
      component_name: name,
      visible: shown,
      // The wizard embeds the form designer (document hotkeys while mounted): not kept alive
      keep_alive: route === 'wf-wizard' ? 0 : shown,
      actions: Object.values(perms).filter(Boolean).sort(),
    })
  }
})

it('staff and member: home, the approval center and leave pages; 流程审批 without 流程管理 at sign-in, root sees both', async () => {
  await runSeeds(ds)
  expect(
    await one("SELECT name, data_scope, sort_no, is_builtin FROM iam_role WHERE code = 'staff'"),
  ).toEqual({ name: 'seed.role.staff', data_scope: 'own_rows', sort_no: 120, is_builtin: 0 })
  const center = [
    'biz-leave',
    'biz-leave-new',
    'biz-leave-view',
    'wf-cc',
    'wf-done',
    'wf-instance-detail',
    'wf-mine',
    'wf-start',
    'wf-todo',
  ]
  // staff holds home like member; the leave perms are action rows (no route name) of biz-leave
  const granted = [...Object.values(leavePerms).map(() => null), ...['home', ...center].sort()]
  expect(await grantsOf('staff')).toEqual(granted)
  expect(await grantsOf('member')).toEqual(granted)
  for (const code of ['staff', 'member']) {
    const actions = await ds.query(
      `SELECT m.perms FROM iam_role_menus rm JOIN iam_role r ON r.id = rm.role_id
         JOIN iam_menu m ON m.id = rm.menu_id JOIN iam_menu p ON p.id = m.parent_id
        WHERE r.code = ? AND p.route_name = 'biz-leave' AND m.kind = 'action' AND rm.deleted_at IS NULL`,
      [code],
    )
    expect(actions.map((a: { perms: string }) => a.perms).sort()).toEqual(
      Object.values(leavePerms).sort(),
    )
  }
  // admin rows are root's alone (perms `*`, no grant rows): no role holds any of them
  const admin = await one("SELECT tree_path FROM iam_menu WHERE route_name = 'wf-admin'")
  expect(
    await ds.query(
      'SELECT rm.role_id FROM iam_role_menus rm JOIN iam_menu m ON m.id = rm.menu_id WHERE m.tree_path LIKE ?',
      [`${admin.tree_path}%`],
    ),
  ).toEqual([])

  const lookup = new IamUserLookup(ds)
  const tree = (nodes: MenuNode[]): unknown[] =>
    nodes.map((n) => (n.children.length ? { [n.routeName!]: tree(n.children) } : n.routeName))
  const workflow = [
    'wf-start',
    'wf-todo',
    'wf-done',
    'wf-mine',
    'wf-cc',
    { 'biz-leave': ['biz-leave-new', 'biz-leave-view'] },
    'wf-instance-detail',
  ]
  for (const code of ['staff', 'member']) {
    const userId = await insertRow(ds.manager, 'iam_user', {
      username: `wf-menus-${code}`,
      display_name: code,
      password_hash: 'x',
    })
    const role = await one('SELECT id FROM iam_role WHERE code = ?', [code])
    await insertRow(ds.manager, 'iam_user_roles', { user_id: userId, role_id: role.id })
    expect({ code, menus: tree(await lookup.menus(userId, false)) }).toEqual({
      code,
      menus: ['home', { workflow }],
    })
  }
  const all = (await lookup.menus(0, true)).find((n) => n.routeName === 'workflow')!
  expect(all.children.map((n) => n.routeName)).toEqual([
    ...workflow.map((w) => (typeof w === 'string' ? w : 'biz-leave')),
    'wf-admin',
  ])
})

it('member gets the workflow menus only when they are first inserted; a deleted role gets none', async () => {
  await runSeeds(ds)
  const center = await grantsOf('staff') // home + the workflow rows
  // an administrator removed staff's wf-cc on the role-menu page (a soft delete: it stays removed) …
  await ds.query(
    "UPDATE iam_role_menus rm JOIN iam_role r ON r.id = rm.role_id JOIN iam_menu m ON m.id = rm.menu_id SET rm.deleted_at = NOW(3) WHERE r.code = 'staff' AND m.route_name = 'wf-cc'",
  )
  // … and the rest went from both roles for good (a hard delete: no removed link left to keep)
  await ds.query(
    "DELETE rm FROM iam_role_menus rm JOIN iam_role r ON r.id = rm.role_id WHERE r.code IN ('member', 'staff') AND rm.deleted_at IS NULL AND rm.menu_id <> (SELECT id FROM iam_menu WHERE route_name = 'home')",
  )
  await ds.query(
    "UPDATE iam_role SET name = 'Edited staff', data_scope = 'own_dept', sort_no = 7 WHERE code = 'staff'",
  )
  await runSeeds(ds)
  expect(await grantsOf('member')).toEqual(['home'])
  // staff's missing ones are ensured on every run, the removed one is not revived; its name, scope and sort stay the admin's
  expect(center).toContain('wf-cc')
  expect(await grantsOf('staff')).toEqual(center.filter((r) => r !== 'wf-cc'))
  expect(await one("SELECT name, data_scope, sort_no FROM iam_role WHERE code = 'staff'")).toEqual({
    name: 'Edited staff',
    data_scope: 'own_dept',
    sort_no: 7,
  })

  // a database seeded before the workflow menus gets them once; a deleted staff role gets no link at all
  const wf = await one("SELECT tree_path FROM iam_menu WHERE route_name = 'workflow'")
  await ds.query(
    'DELETE rm FROM iam_role_menus rm JOIN iam_menu m ON m.id = rm.menu_id WHERE m.tree_path LIKE ?',
    [`${wf.tree_path}%`],
  )
  await ds.query('DELETE FROM iam_menu WHERE tree_path LIKE ?', [`${wf.tree_path}%`])
  await ds.query("UPDATE iam_role SET deleted_at = NOW(3) WHERE code = 'staff'")
  await runSeeds(ds)
  expect(await grantsOf('member')).toEqual(center)
  expect(
    await one(
      "SELECT COUNT(*) AS n FROM iam_role_menus rm JOIN iam_role r ON r.id = rm.role_id WHERE r.code = 'staff' AND rm.menu_id <> (SELECT id FROM iam_menu WHERE route_name = 'home')",
    ),
  ).toEqual({ n: 0 }) // its home link predates the deletion
})

const oaUsers = Object.values(LEAVE_DEMO_USERS)
const oaNames = oaUsers.map(([username]) => username)
/** username → id of the OA demo users */
const oaIds = async (): Promise<Record<string, number>> =>
  Object.fromEntries(
    (await ds.query('SELECT id, username FROM iam_user WHERE username IN (?)', [oaNames])).map(
      (r: { id: number; username: string }) => [r.username, Number(r.id)],
    ),
  )

it('OA leave sample: five staff users sharing one password printed once, that must be changed', async () => {
  vi.stubEnv('APP_DEMO_MODE', 'false')
  try {
    const oa = (await runSeeds(ds)).filter((n) => OA_NOTICE.test(n))
    const password = oa[0]?.split(': ').pop() ?? ''
    expect(password).toMatch(/^[\w-]{16}$/)
    expect(oa).toEqual([
      `seed: password of OA demo users ${oaNames.join(', ')} (shown once, must be changed at first sign-in): ${password}`,
    ])
    const users = await ds.query(
      `SELECT u.username, u.display_name, d.name AS dept, u.enabled, u.password_changed_at, u.password_hash
         FROM iam_user u LEFT JOIN iam_dept d ON d.id = u.dept_id WHERE u.username IN (?) ORDER BY u.id`,
      [oaNames],
    )
    expect(
      users.map((u: Record<string, unknown>) => [
        u.username,
        u.display_name,
        u.dept,
        u.enabled,
        u.password_changed_at,
      ]),
    ).toEqual(oaUsers.map(([username, name, dept]) => [username, name, dept, 1, null]))
    for (const u of users) expect(await bcrypt.compare(password, u.password_hash)).toBe(true)
    const roles = await ds.query(
      `SELECT u.username, r.code FROM iam_user_roles ur JOIN iam_user u ON u.id = ur.user_id
         JOIN iam_role r ON r.id = ur.role_id WHERE u.username IN (?) AND ur.deleted_at IS NULL ORDER BY u.id`,
      [oaNames],
    )
    expect(roles.map((r: { username: string; code: string }) => [r.username, r.code])).toEqual(
      oaNames.map((n) => [n, 'staff']),
    )

    // existing users are never touched and nothing is printed; a missing one is created alone
    await ds.query("UPDATE iam_user SET password_hash = 'x' WHERE username = 'oa.director'")
    expect((await runSeeds(ds)).filter((n) => OA_NOTICE.test(n))).toEqual([])
    const ids = await oaIds()
    await ds.query('DELETE FROM iam_user_roles WHERE user_id = ?', [ids['oa.hr']])
    await ds.query('DELETE FROM iam_user WHERE id = ?', [ids['oa.hr']])
    expect((await runSeeds(ds)).filter((n) => OA_NOTICE.test(n))).toEqual([
      expect.stringMatching(/^seed: password of OA demo users oa\.hr \(shown once/),
    ])
    expect(await one("SELECT password_hash FROM iam_user WHERE username = 'oa.director'")).toEqual({
      password_hash: 'x',
    })
  } finally {
    vi.unstubAllEnvs()
  }
})

it('OA demo users in demo mode (APP_DEMO_MODE=true): the password counts as changed', async () => {
  vi.stubEnv('APP_DEMO_MODE', 'true')
  try {
    const oa = (await runSeeds(ds)).filter((n) => OA_NOTICE.test(n))
    expect(oa).toEqual([expect.stringMatching(/ \(shown once\): [\w-]{16}$/)])
    const rows = await ds.query(
      'SELECT password_changed_at AS at FROM iam_user WHERE username IN (?)',
      [oaNames],
    )
    expect(rows.map((r: { at: unknown }) => r.at instanceof Date)).toEqual(oaNames.map(() => true))
  } finally {
    vi.unstubAllEnvs()
  }
})

it('OA demo password: a new one per install (a fresh process draws its own)', async () => {
  await runSeeds(ds)
  const draw = async () => {
    const ids = Object.values(await oaIds())
    await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [ids])
    await ds.query('DELETE FROM iam_user WHERE id IN (?)', [ids])
    vi.resetModules() // drop the per-process password cache
    const { seedLeave } = await import('../../src/modules/biz/leave/leave.seed.js')
    const [notice] = await seedLeave(ds.manager)
    return notice?.split(': ').pop()
  }
  const first = await draw()
  expect(first).toMatch(/^[\w-]{16}$/)
  expect(await draw()).not.toBe(first)
})

it('OA leave process: a custom-form model of its pages; supervisor, then > 5 days HR ∥ director, > 2 director, else done', async () => {
  await runSeeds(ds)
  const model = await one("SELECT * FROM wf_model WHERE model_key = 'leave' AND deleted_at IS NULL")
  expect(model).toMatchObject({
    name: 'seed.wf.leave',
    description: 'seed.wf.leaveDescription',
    category: 'hr',
    form_kind: 'custom',
    create_route: '/biz/leave/new',
    view_component: 'biz/leave/view',
    enabled: 1,
    allow_cancel: 1,
    allow_withdraw: 1,
  })
  const version = await one('SELECT * FROM wf_version WHERE id = ?', [model.current_version_id])
  expect(version).toMatchObject({
    model_id: model.id,
    model_key: 'leave',
    version: 1,
    form_snapshot: { fields: LEAVE_FIELDS },
    published_by: null,
  })
  expect(model.draft_json).toEqual(version.tree_json)
  // (its names are seed.wf.* literals of the seed file: i18n:check rule 5 finds them in both languages)
  const c = compile(version.tree_json, LEAVE_FIELDS)
  if (!c.ok) throw new Error(JSON.stringify(c.errors))

  // the engine over the seeded org: the employee's leave of `days`, the supervisor approves (if asked)
  const id = await oaIds()
  const ctx = { flow: c.flow, fields: LEAVE_FIELDS, org: typeormOrg(ds), managerIds: [], now: T0 }
  const route = async (days: number, initiator = 'oa.employee') => {
    const r = await run(ctx, { initiatorId: id[initiator], formValues: { days } })
    const first = r.pending()
    const sup = r.open().find((t) => t.nodeId === 'supervisor')
    if (sup) await r.approve(sup)
    return [first, r.pending(), r.instance.state]
  }
  const sup = [['supervisor', id['oa.supervisor']]]
  const director = (node: string) => [node, id['oa.director']]
  for (const days of [6, 5.1])
    expect(await route(days)).toEqual([
      sup,
      [['hr', id['oa.hr']], director('director-long')],
      'running',
    ])
  for (const days of [5, 2.1])
    expect(await route(days)).toEqual([sup, [director('director')], 'running'])
  for (const days of [2, 0.5]) expect(await route(days)).toEqual([sup, [], 'approved'])
  // nobody approves their own leave: the supervisor's step is skipped for the supervisor
  expect(await route(3, 'oa.supervisor')).toEqual([
    [director('director')],
    [director('director')],
    'running',
  ])

  // inserted once: the administrator's edits and versions stay
  await ds.query("UPDATE wf_model SET name = 'My leave', enabled = 0 WHERE id = ?", [model.id])
  await runSeeds(ds)
  expect(await one('SELECT name, enabled FROM wf_model WHERE id = ?', [model.id])).toEqual({
    name: 'My leave',
    enabled: 0,
  })
  expect(await one("SELECT COUNT(*) AS n FROM wf_version WHERE model_key = 'leave'")).toEqual({
    n: 1,
  })
})

it('process templates: four disabled, unpublished dynamic models with sanitized bilingual forms whose drafts route by the computed days / totals; inserted once', async () => {
  await runSeeds(ds)
  const tplRows = () =>
    ds.query(
      `SELECT m.id, m.model_key, m.name, m.description, m.category, m.form_kind, m.enabled,
              m.current_version_id, m.draft_json, m.deleted_at IS NULL AS live, f.id AS form_id,
              f.name AS form_name, f.schema_json, f.deleted_at IS NULL AS form_live
         FROM wf_model m LEFT JOIN wf_form f ON f.id = m.form_id
        WHERE m.model_key LIKE 'tpl-%' ORDER BY m.sort_no`,
    )
  const models = await tplRows()
  expect(models.map((m: { model_key: string }) => m.model_key)).toEqual(
    WF_TEMPLATES.map((t) => WF_TEMPLATE_KEY_PREFIX + t.key),
  )
  const seedJson = Object.fromEntries(
    LOCALES.map((l) => [
      l,
      JSON.parse(
        readFileSync(
          new URL(`../../../../packages/shared/src/i18n/${l}/seed.json`, import.meta.url),
          'utf8',
        ),
      ),
    ]),
  )
  const seedText = (l: string, key: string) =>
    key
      .split('.')
      .slice(1)
      .reduce((o, k) => o?.[k], seedJson[l])
  type Tpl = { id: number; form_id: number; draft_json: unknown; schema_json: FormSchema }
  const byKey: Record<string, Tpl & { fields: WfFields }> = {}
  for (const m of models) {
    expect(m).toMatchObject({ form_kind: 'dynamic', enabled: 0, current_version_id: null, live: 1 })
    expect(m.form_live).toBe(1)
    for (const key of [m.name, m.description, m.form_name])
      for (const l of LOCALES) expect(seedText(l, key), `${l} ${key}`).toMatch(/\S/)
    // stored as the sanitizer returns it; every {{$t.<id>}} text in both form-create locales
    const s = sanitizeFormSchema(m.schema_json)
    expect(s.ok && s.schema).toEqual(m.schema_json)
    const { language } = m.schema_json.option
    expect(Object.keys(language).sort()).toEqual(['en', 'zh-cn'])
    expect(Object.keys(language.en)).toEqual(Object.keys(language['zh-cn']))
    const ids = [...JSON.stringify(m.schema_json.rule).matchAll(/\{\{\$t\.(\w+)\}\}/g)]
    expect(ids.length).toBeGreaterThan(0)
    for (const [, id] of ids) for (const l of ['en', 'zh-cn']) expect(language[l][id]).toMatch(/\S/)
    const f = fieldsFromFormSchema(m.schema_json)
    if (!f.ok) throw new Error(JSON.stringify(f.errors))
    const c = compile(m.draft_json, f.fields)
    if (!c.ok) throw new Error(JSON.stringify(c.errors))
    byKey[m.model_key] = { ...m, fields: f.fields }
  }
  expect(byKey['tpl-leave'].fields).toMatchObject({ startDate: 'date', days: 'number' })
  expect(byKey['tpl-expense'].fields).toMatchObject({ items: 'string', total: 'number' })
  expect(byKey['tpl-overtime'].fields).toMatchObject({ startTime: 'date', hours: 'number' })

  // the engine over the fixture org (user 4 in dept 3; heads: dept 3 → 3, its parent 2 → 2): each
  // approval in turn, values computed as the start computes them
  const route = async (key: string, values: Record<string, unknown>, initiatorId = 4) => {
    const m = byKey[key]
    const c = compile(m.draft_json, m.fields)
    if (!c.ok) throw new Error(JSON.stringify(c.errors))
    const ctx = { flow: c.flow, fields: m.fields, org: wfOrg, managerIds: [7], now: T0 }
    const formValues = applyFormCalc(m.schema_json, values)
    const r = await run(ctx, { initiatorId, formValues })
    const steps = [r.pending()]
    for (let task = r.open()[0]; task; task = r.open()[0]) {
      await r.approve(task)
      steps.push(r.pending())
    }
    return [steps, r.instance.state]
  }
  const leave = (startDate: string, endDate: string) => ({ startDate, endDate, days: 1 })
  const twoLevels = [[['two-levels', 3]], [['two-levels', 2]], []]
  const direct = [[['supervisor', 3]], []]
  expect(await route('tpl-leave', leave('2026-03-02', '2026-03-05'))).toEqual([
    twoLevels,
    'approved',
  ])
  expect(await route('tpl-leave', leave('2026-03-02', '2026-03-04'))).toEqual([direct, 'approved'])
  const items = (...amounts: number[]) =>
    JSON.stringify(amounts.map((amount, i) => ({ kind: `k${i}`, amount })))
  expect(await route('tpl-expense', { items: items(3000, 2000.5), total: 1 })).toEqual([
    twoLevels,
    'approved',
  ])
  expect(await route('tpl-expense', { items: items(3000, 2000), total: 9e9 })).toEqual([
    direct,
    'approved',
  ])
  expect(await route('tpl-general', { subject: 'x' })).toEqual([direct, 'approved'])
  // a dept head's own request goes to the next head up; nobody in the org chart → the managers
  expect(await route('tpl-overtime', { hours: 2 }, 3)).toEqual([
    [[['supervisor', 2]], []],
    'approved',
  ])
  expect(await route('tpl-overtime', { hours: 2 }, 9)).toEqual([
    [[['supervisor', 7]], []],
    'approved',
  ])

  // inserted once: edits stay, a deleted template or form is not revived, a taken form name skips it
  const tpl = (key: string) => byKey[WF_TEMPLATE_KEY_PREFIX + key]
  await ds.query("UPDATE wf_model SET name = 'My leave', enabled = 1 WHERE id = ?", [
    tpl('leave').id,
  ])
  await ds.query('UPDATE wf_form SET schema_json = \'{"rule":[]}\' WHERE id = ?', [
    tpl('leave').form_id,
  ])
  await ds.query('UPDATE wf_model SET deleted_at = NOW(3) WHERE id = ?', [tpl('general').id])
  await ds.query('UPDATE wf_form SET deleted_at = NOW(3) WHERE id = ?', [tpl('expense').form_id])
  await ds.query('DELETE FROM wf_model WHERE id = ?', [tpl('overtime').id])
  const before = await tplRows()
  const forms = await one('SELECT COUNT(*) AS n FROM wf_form')
  await runSeeds(ds)
  expect(await tplRows()).toEqual(before)
  expect(before.map((m: { model_key: string }) => m.model_key)).toEqual([
    'tpl-general',
    'tpl-leave',
    'tpl-expense',
  ])
  expect(await one('SELECT COUNT(*) AS n FROM wf_form')).toEqual(forms)
})

it('templates: every seeded template code has a zh-CN and an en-US row named by a seed.* key', async () => {
  await runSeeds(ds)
  const names = Object.fromEntries(
    LOCALES.map((locale) => [
      locale,
      JSON.parse(
        readFileSync(
          new URL(`../../../../packages/shared/src/i18n/${locale}/seed.json`, import.meta.url),
          'utf8',
        ),
      ) as Record<string, Record<string, string>>,
    ]),
  ) as Record<string, Record<string, Record<string, string>>>
  for (const table of ['msg_inbox_template', 'msg_mail_template', 'msg_sms_template']) {
    const rows: {
      code: string
      name: string
      locales: string
      count: number
      invalid_names: number
      name_count: number
    }[] = await ds.query(
      `SELECT code, MIN(name) AS name, GROUP_CONCAT(locale ORDER BY locale) AS locales,
              COUNT(*) AS count, SUM(name NOT LIKE 'seed.%') AS invalid_names,
              COUNT(DISTINCT name) AS name_count FROM ${table} GROUP BY code`,
    )
    expect(rows.length).toBeGreaterThanOrEqual(table === 'msg_mail_template' ? 0 : 1)
    for (const row of rows) {
      expect(Number(row.invalid_names)).toBe(0)
      expect(Number(row.name_count)).toBe(1)
      expect(row.locales.split(',')).toEqual([...LOCALES].sort())
      expect(Number(row.count)).toBe(2)
      const [namespace, section, key] = row.name.split('.')
      expect(namespace).toBe('seed')
      for (const locale of LOCALES) expect(names[locale][section]?.[key]?.trim()).toBeTruthy()
    }
  }
})

it('initial password of new users: a secret builtin param, random per installation, kept on re-seed', async () => {
  const [notice] = await runSeeds(ds)
  const param = await one(
    'SELECT param_value, group_code, is_builtin, is_secret, is_public, name_i18n FROM cfg_param WHERE param_key = ?',
    [USER_INITIAL_PASSWORD_PARAM],
  )
  expect(param).toMatchObject({ group_code: 'iam', is_builtin: 1, is_secret: 1, is_public: 0 })
  expect(Object.keys(param.name_i18n).sort()).toEqual([...LOCALES].sort())
  expect(notice).toBe(
    `seed: initial password of new users (${USER_INITIAL_PASSWORD_PARAM}): ${param.param_value}`,
  )
  // passes the strictest character-class policy
  expect(param.param_value).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w]).{16,}$/)
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
    'Chosen#Pass1',
    USER_INITIAL_PASSWORD_PARAM,
  ])
  expect(await runSeeds(ds)).toEqual([])
  expect(
    await one('SELECT param_value FROM cfg_param WHERE param_key = ?', [
      USER_INITIAL_PASSWORD_PARAM,
    ]),
  ).toEqual({ param_value: 'Chosen#Pass1' })
  await ds.query('DELETE FROM cfg_param')
  const [again] = await runSeeds(ds, ['iam'])
  expect(again).toMatch(INITIAL_NOTICE)
  expect(again).not.toBe(notice)
})

it('dicts with labels in every language, params with defaults', async () => {
  await runSeeds(ds)
  const dicts: { code: string; name: string; name_i18n: Record<string, string> }[] = await ds.query(
    'SELECT code, name, name_i18n FROM cfg_dict ORDER BY code',
  )
  expect(dicts.map((d) => d.code)).toEqual([
    'audit.fault_state',
    'audit.signin_kind',
    'audit.user_type',
    'audit.verb',
    'biz.leave_kind',
    'biz.leave_state',
    'core.enabled',
    'core.locale',
    'core.yes_no',
    'demo.genre',
    'demo.invoice_state',
    'iam.data_scope',
    'iam.gender',
    'iam.menu_kind',
    'iam.menu_link_type',
    'messaging.bulletin_kind',
    'messaging.inbox_category',
    'messaging.inbox_status',
    'messaging.mail_record_status',
    'messaging.mail_security',
    'messaging.sms_driver',
    'messaging.sms_purpose',
    'messaging.sms_receipt_status',
    'messaging.sms_record_status',
    'scheduler.job_group',
    'scheduler.misfire',
    'scheduler.run_outcome',
    'settings.app_package_kind',
    'settings.app_platform',
    'settings.tag_type',
    'wf.action',
    'wf.category',
    'wf.instance_state',
    'wf.task_state',
  ])
  const entries: { dict_code: string; value: string; label: string; label_i18n: any }[] =
    await ds.query('SELECT dict_code, value, label, label_i18n FROM cfg_dict_entry')
  for (const row of [
    ...dicts.map((d) => ({ label: d.name, label_i18n: d.name_i18n })),
    ...entries,
  ]) {
    expect(Object.keys(row.label_i18n).sort()).toEqual([...LOCALES].sort())
    expect(row.label).toBe(row.label_i18n['zh-CN'])
  }
  expect(
    entries
      .filter((e) => e.dict_code === 'audit.user_type')
      .map(({ value, label_i18n }) => ({ value, label_i18n })),
  ).toEqual([
    { value: 'admin', label_i18n: { 'zh-CN': '管理员', 'en-US': 'Administrator' } },
    { value: 'member', label_i18n: { 'zh-CN': '会员', 'en-US': 'Member' } },
  ])
  for (const [value, zh, en] of [
    ['signup', '注册', 'Sign up'],
    ['reset-password-sms', '短信找回密码', 'Reset password by SMS'],
    ['kick', '强制退出', 'End session'],
  ]) {
    expect(
      entries.find((e) => e.dict_code === 'audit.verb' && e.value === value)?.label_i18n,
    ).toEqual({
      'zh-CN': zh,
      'en-US': en,
    })
  }
  expect(entries.filter((e) => e.dict_code === 'iam.data_scope').map((e) => e.value)).toEqual([
    'all',
    'picked_depts',
    'own_dept',
    'own_dept_tree',
    'own_rows',
  ])
  expect(entries.filter((e) => e.dict_code === 'core.locale').map((e) => e.value)).toEqual([
    ...LOCALES,
  ])
  expect(
    entries.filter((e) => e.dict_code === 'messaging.inbox_category').map((e) => e.value),
  ).toEqual(['system', 'business'])
  expect(
    entries.filter((e) => e.dict_code === 'messaging.inbox_status').map((e) => e.value),
  ).toEqual(['pending', 'sending', 'delivered', 'failed'])
  // the engine's codes, in their order (db/seeds/workflow)
  for (const [code, values] of [
    ['wf.instance_state', WF_INSTANCE_STATES],
    ['wf.task_state', WF_TASK_STATES],
    ['wf.action', WF_ACTIONS],
  ] as const)
    expect(entries.filter((e) => e.dict_code === code).map((e) => e.value)).toEqual([...values])
  const [{ d }] = await ds.query(
    "SELECT column_default AS d FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'wf_model' AND column_name = 'category'",
  )
  expect(entries.filter((e) => e.dict_code === 'wf.category').map((e) => e.value)).toContain(d)

  const params = Object.fromEntries(
    (await ds.query('SELECT param_key, param_value FROM cfg_param')).map(
      (p: { param_key: string; param_value: string }) => [p.param_key, p.param_value],
    ),
  )
  expect(params).toEqual({
    [CAPTCHA_MODE_PARAM]: 'off',
    [CAPTCHA_IMAGE_TYPE_PARAM]: DEFAULT_CAPTCHA_IMAGE_TYPE,
    [USER_INITIAL_PASSWORD_PARAM]: expect.any(String),
    [loginSecurityParams.lockThreshold]: '5',
    [loginSecurityParams.lockMinutes]: '10',
    [loginSecurityParams.crossIpThreshold]: '10',
    [passwordPolicyParams.minLength]: '8',
    [passwordPolicyParams.charClasses]: '2',
    [passwordPolicyParams.expireDays]: '0',
    [signupParams.enabled]: 'false',
    [signupParams.defaultRoleId]: String(
      (await one("SELECT id FROM iam_role WHERE code = 'member'")).id,
    ),
    [signupParams.defaultDeptId]: '',
    [WX_MP_ENABLED_PARAM]: 'false',
    [DEFAULT_TIMEZONE_PARAM]: DEFAULT_TIMEZONE,
    [IP_BLACKLIST_PARAM]: '',
    [excelImportParams.maxMb]: '10',
    [excelImportParams.maxRows]: '5000',
    [excelImportParams.maxColumns]: '100',
    [storageParams.maxSizeMb]: '20',
    [storageParams.allowedExts]: STORAGE_ALLOWED_EXTS_DEFAULT.join(','),
    'sms.otp.cooldown_sec': '60',
    'sms.otp.mobile_daily_max': '10',
    'sms.otp.ip_daily_max': '20',
    'sms.otp.user_daily_max': '5',
    'sms.otp.global_daily_max': '1000',
    [HTTP_TRACE_MODE_PARAM]: DEFAULT_HTTP_TRACE_MODE,
    [HTTP_TRACE_EXCLUDE_PARAM]: DEFAULT_HTTP_TRACE_EXCLUDE,
    [AUDIT_RETENTION_PARAM]: String(DEFAULT_AUDIT_RETENTION_DAYS),
    [oauthParams.consentTtlDays]: String(OAUTH_CONSENT_TTL_DAYS_DEFAULT),
    [WX_SUBSCRIBE_ENABLED_PARAM]: 'false',
    [WX_SUBSCRIBE_TEMPLATES_PARAM]: expect.any(String),
    // App updates: no update prompt unless switched on
    [APP_UPDATE_PARAMS.enabled]: 'false',
    [APP_UPDATE_PARAMS.reviewVersion]: '',
  })
  // WeChat subscribe messages: a valid mapping for the new to-do, its template id left for the operator
  expect(wxSubscribeTemplates.parse(JSON.parse(params[WX_SUBSCRIBE_TEMPLATES_PARAM]))).toEqual({
    'wf.task.assigned': {
      id: '',
      page: 'pages-wf/detail/index?id={instanceId}',
      data: { thing1: '{title}', time2: '{time}' },
    },
  })
})

it('oauth: the built-in console client named by a seed key, nothing to authorize; no mobile row', async () => {
  await runSeeds(ds)
  expect(
    await ds.query(
      `SELECT client_id, secret_hash, name, grant_types, redirect_uris, scopes, auto_approve_scopes,
              is_builtin, enabled FROM oauth_client`,
    ),
  ).toEqual([
    {
      client_id: 'console',
      secret_hash: null,
      name: 'seed.oauth.console',
      grant_types: [],
      redirect_uris: [],
      scopes: [],
      auto_approve_scopes: [],
      is_builtin: 1,
      enabled: 1,
    },
  ])
})

it('storage: one enabled primary local storage named by a seed key', async () => {
  await runSeeds(ds)
  expect(
    await ds.query('SELECT name, driver, is_primary, enabled, config FROM fs_storage'),
  ).toEqual([
    { name: 'seed.storage.local', driver: 'local', is_primary: 1, enabled: 1, config: {} },
  ])
  // the upload limit is public (the upload fields read it), also on a database seeded before;
  // the extension whitelist is not
  await ds.query('UPDATE cfg_param SET is_public = 0 WHERE param_key = ?', [
    storageParams.maxSizeMb,
  ])
  await runSeeds(ds)
  expect(
    await ds.query(
      "SELECT param_key, is_public FROM cfg_param WHERE group_code = 'storage' ORDER BY param_key",
    ),
  ).toEqual([
    { param_key: storageParams.allowedExts, is_public: 0 },
    { param_key: storageParams.maxSizeMb, is_public: 1 },
  ])
})

it('codegen: the config of every db/seeds/codegen/<table>.cg.ts (G0 modules), edits on the import defaults', async () => {
  const files = readdirSync('src/db/seeds/codegen').filter((f) => f.endsWith('.cg.ts'))
  // a master-sub module's file holds its sub tables' configs too
  const masters = CG_SEEDS.filter((s) => !s.master)
  expect(masters.map((s) => `${s.tableName}.cg.ts`).sort()).toEqual(files.sort())
  await runSeeds(ds, ['codegen'])
  expect(
    await one(
      "SELECT s.sub_fk_col, m.table_name AS master, m.template FROM cg_table s JOIN cg_table m ON m.id = s.master_table_id WHERE s.table_name = 'demo_invoice_line'",
    ),
  ).toEqual({ sub_fk_col: 'invoice_id', master: 'demo_invoice', template: 'master_sub' })
  expect(await ds.query('SELECT table_name FROM cg_table ORDER BY table_name')).toEqual(
    CG_SEEDS.map((s) => ({ table_name: s.tableName })).sort((a, b) =>
      a.table_name.localeCompare(b.table_name),
    ),
  )
  const position = await one(
    "SELECT id, domain, business, class_name, options FROM cg_table WHERE table_name = 'iam_position'",
  )
  expect(position).toMatchObject({ domain: 'iam', business: 'position', class_name: 'Position' })
  expect(position.options).toMatchObject({ withOptions: true, menuSortNo: 50 })
  const columns = await ds.query(
    'SELECT column_name, field_name, label_i18n, options, in_query FROM cg_column WHERE table_id = ? ORDER BY sort_no',
    [position.id],
  )
  expect(columns.find((c: { column_name: string }) => c.column_name === 'name')).toMatchObject({
    field_name: 'name',
    label_i18n: { 'zh-CN': '岗位名称', 'en-US': 'Position name' },
    options: { seedName: true, unique: true },
  })
  // import default kept: `note` is not in the config's edits
  expect(columns.find((c: { column_name: string }) => c.column_name === 'note')).toMatchObject({
    field_name: 'note',
  })
  const live = () =>
    ds.query('SELECT COUNT(*) AS n FROM cg_column WHERE table_id = ? AND deleted_at IS NULL', [
      position.id,
    ])
  // a stale column (the table lost it) is soft-deleted again, like sync does
  await ds.query(
    "INSERT INTO cg_column (table_id, column_name, column_type, nullable, ts_type, field_name, widget) VALUES (?, 'gone', 'int', 0, 'number', 'gone', 'number')",
    [position.id],
  )
  await runSeeds(ds, ['codegen'])
  expect(await live()).toEqual([{ n: columns.length }])
  expect(
    await ds.query(
      "SELECT deleted_at IS NOT NULL AS gone FROM cg_column WHERE table_id = ? AND column_name = 'gone'",
      [position.id],
    ),
  ).toEqual([{ gone: 1 }])
  // a column sync soft-deleted (the table lacked it for a while) is back with the seed's config
  await ds.query(
    "UPDATE cg_column SET deleted_at = NOW(3), label_i18n = NULL WHERE table_id = ? AND column_name = 'name'",
    [position.id],
  )
  await runSeeds(ds, ['codegen'])
  expect(await live()).toEqual([{ n: columns.length }])
  expect(
    await one(
      "SELECT deleted_at IS NULL AS live, label_i18n FROM cg_column WHERE table_id = ? AND column_name = 'name'",
      [position.id],
    ),
  ).toEqual({ live: 1, label_i18n: { 'zh-CN': '岗位名称', 'en-US': 'Position name' } })
})

it('re-seeding restores definitions but keeps what admins own (param values, users, enabled)', async () => {
  await runSeeds(ds)
  expect(
    await one("SELECT name, data_scope, sort_no, is_builtin FROM iam_role WHERE code = 'member'"),
  ).toEqual({
    name: 'seed.role.member',
    data_scope: 'own_rows',
    sort_no: 110,
    is_builtin: 0,
  })
  expect(
    await one(
      "SELECT COUNT(*) AS n FROM iam_role_menus rm JOIN iam_role r ON r.id = rm.role_id JOIN iam_menu m ON m.id = rm.menu_id WHERE r.code = 'member' AND m.route_name = 'home'",
    ),
  ).toEqual({ n: 1 })
  await ds.query(
    "UPDATE iam_role SET name = 'Edited member', data_scope = 'own_dept', sort_no = 42, is_builtin = 1 WHERE code = 'member'",
  )
  await ds.query(
    "DELETE rm FROM iam_role_menus rm JOIN iam_role r ON r.id = rm.role_id JOIN iam_menu m ON m.id = rm.menu_id WHERE r.code = 'member' AND m.route_name = 'home'",
  )
  // msg_* are not among the TABLES afterAll resets: put the template back and drop the channel at the end
  const otpTemplate = await one(
    'SELECT body, channel_id, enabled FROM msg_sms_template WHERE code = ? AND locale = ?',
    ['auth.sms_code', 'en-US'],
  )
  const smsChannelId = await insertRow(ds.manager, 'msg_sms_channel', {
    driver: 'debug',
    name: 'Seed OTP test',
  })
  await ds.query(
    'UPDATE msg_sms_template SET body = ?, channel_id = ?, enabled = 0 WHERE code = ? AND locale = ?',
    ['Edited {code}', smsChannelId, 'auth.sms_code', 'en-US'],
  )
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
    '3',
    'sms.otp.mobile_daily_max',
  ])
  await ds.query("UPDATE iam_role SET data_scope = 'own_rows' WHERE code = 'root'")
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
    '7',
    loginSecurityParams.lockThreshold,
  ])
  await ds.query(
    "UPDATE iam_user SET display_name = 'Boss', password_hash = 'x' WHERE username = 'admin'",
  )
  await ds.query("UPDATE iam_menu SET enabled = 0 WHERE route_name = 'home'")
  await runSeeds(ds)
  expect(
    await one("SELECT name, data_scope, sort_no, is_builtin FROM iam_role WHERE code = 'member'"),
  ).toEqual({
    name: 'Edited member',
    data_scope: 'own_dept',
    sort_no: 42,
    is_builtin: 0,
  })
  expect(
    await one(
      "SELECT COUNT(*) AS n FROM iam_role_menus rm JOIN iam_role r ON r.id = rm.role_id JOIN iam_menu m ON m.id = rm.menu_id WHERE r.code = 'member' AND m.route_name = 'home'",
    ),
  ).toEqual({ n: 0 })
  expect(await one("SELECT data_scope FROM iam_role WHERE code = 'root'")).toEqual({
    data_scope: 'all',
  })
  expect(
    await one('SELECT param_value FROM cfg_param WHERE param_key = ?', [
      loginSecurityParams.lockThreshold,
    ]),
  ).toEqual({ param_value: '7' })
  expect(
    await one("SELECT display_name, password_hash FROM iam_user WHERE username = 'admin'"),
  ).toEqual({ display_name: 'Boss', password_hash: 'x' })
  expect(await one("SELECT enabled FROM iam_menu WHERE route_name = 'home'")).toEqual({
    enabled: 0,
  })
  expect(
    await one(
      'SELECT body, channel_id, enabled FROM msg_sms_template WHERE code = ? AND locale = ?',
      ['auth.sms_code', 'en-US'],
    ),
  ).toEqual({ body: 'Edited {code}', channel_id: smsChannelId, enabled: 0 })
  expect(
    await one('SELECT param_value FROM cfg_param WHERE param_key = ?', [
      'sms.otp.mobile_daily_max',
    ]),
  ).toEqual({ param_value: '3' })
  await ds.query(
    'UPDATE msg_sms_template SET body = ?, channel_id = ?, enabled = ? WHERE code = ? AND locale = ?',
    [otpTemplate.body, otpTemplate.channel_id, otpTemplate.enabled, 'auth.sms_code', 'en-US'],
  )
  await ds.query('DELETE FROM msg_sms_channel WHERE id = ?', [smsChannelId])
})

it('dicts: what the dict pages edit survives a re-seed; only missing languages and entries are added', async () => {
  await runSeeds(ds)
  const gender = "SELECT name, name_i18n FROM cfg_dict WHERE code = 'iam.gender'"
  const entries = async () =>
    Object.fromEntries(
      (
        await ds.query(
          "SELECT value, label, label_i18n, sort_no, tag_type, is_default, enabled FROM cfg_dict_entry WHERE dict_code = 'iam.gender'",
        )
      ).map(({ value, ...e }: { value: string }) => [value, e]),
    )
  // an admin renames the dict and an entry (en-US dropped: a language the rows lack), re-sorts and
  // re-styles it, moves the default, disables it and hard-deletes another
  await ds.query("UPDATE cfg_dict SET name = 'Sex', name_i18n = ? WHERE code = 'iam.gender'", [
    JSON.stringify({ 'zh-CN': 'Sex' }),
  ])
  await ds.query(
    "UPDATE cfg_dict_entry SET label_i18n = ?, is_default = 0 WHERE dict_code = 'iam.gender' AND value = 'unknown'",
    [JSON.stringify({ 'zh-CN': '未说明' })],
  )
  await ds.query(
    "UPDATE cfg_dict_entry SET label = '男士', label_i18n = ?, sort_no = 999, tag_type = 'danger', is_default = 1, enabled = 0 WHERE dict_code = 'iam.gender' AND value = 'male'",
    [JSON.stringify({ 'zh-CN': '男士', 'en-US': 'Gentleman' })],
  )
  await ds.query("DELETE FROM cfg_dict_entry WHERE dict_code = 'iam.gender' AND value = 'female'")
  await runSeeds(ds)
  expect(await one(gender)).toEqual({
    name: 'Sex',
    name_i18n: { 'zh-CN': 'Sex', 'en-US': 'Gender' },
  })
  expect(await entries()).toEqual({
    male: {
      label: '男士',
      label_i18n: { 'zh-CN': '男士', 'en-US': 'Gentleman' },
      sort_no: 999,
      tag_type: 'danger',
      is_default: 1,
      enabled: 0,
    },
    female: {
      label: '女',
      label_i18n: { 'zh-CN': '女', 'en-US': 'Female' },
      sort_no: 20,
      tag_type: null,
      is_default: 0,
      enabled: 1,
    },
    unknown: {
      label: '未说明',
      label_i18n: { 'zh-CN': '未说明', 'en-US': 'Not specified' },
      sort_no: 30,
      tag_type: null,
      is_default: 0,
      enabled: 1,
    },
  })
})

it('re-seeding never revives what an administrator deleted: rows and links stay deleted', async () => {
  await runSeeds(ds)
  const userId = await ds.transaction((q) => seedLimitedUser(q, 'seed-deleted', 'Limited@123'))
  const gone = {
    action: await one('SELECT id FROM iam_menu WHERE perms = ?', [dictPerms.remove]),
    entry: await one(
      "SELECT id FROM cfg_dict_entry WHERE dict_code = 'iam.gender' AND value = 'unknown'",
    ),
    position: await one("SELECT id FROM iam_position WHERE code = 'designer'"),
    role: await one("SELECT id FROM iam_role WHERE code = 'member'"),
    config: await one("SELECT id FROM cg_table WHERE table_name = 'demo_topic'"),
  }
  const soft = (table: string, id: number) =>
    // arch-allow: sql-concat table names are the test's constants
    ds.query(`UPDATE ${table} SET deleted_at = NOW(3) WHERE id = ?`, [id])
  await soft('iam_menu', gone.action.id)
  // nor updated: a deleted row keeps what it had
  await ds.query("UPDATE iam_menu SET name = 'admin-edit', sort_no = 999 WHERE id = ?", [
    gone.action.id,
  ])
  await soft('cfg_dict_entry', gone.entry.id)
  await soft('iam_position', gone.position.id)
  await soft('iam_role', gone.role.id)
  await soft('cg_table', gone.config.id)
  await ds.query('UPDATE cg_column SET deleted_at = NOW(3) WHERE table_id = ?', [gone.config.id])
  // links: the admin's position, the limited user's role and its role's home grant
  const admin = await one("SELECT id FROM iam_user WHERE username = 'admin'")
  await ds.query('UPDATE iam_user_positions SET deleted_at = NOW(3) WHERE user_id = ?', [admin.id])
  await ds.query('UPDATE iam_user_roles SET deleted_at = NOW(3) WHERE user_id = ?', [userId])
  await ds.query(
    "UPDATE iam_role_menus SET deleted_at = NOW(3) WHERE role_id = (SELECT id FROM iam_role WHERE code = 'demo')",
  )
  const rows = async () => ({
    action: await ds.query(
      'SELECT id, deleted_at IS NULL AS live, name, sort_no FROM iam_menu WHERE perms = ?',
      [dictPerms.remove],
    ),
    entry: await ds.query(
      "SELECT id, deleted_at IS NULL AS live FROM cfg_dict_entry WHERE dict_code = 'iam.gender' AND value = 'unknown'",
    ),
    position: await ds.query(
      "SELECT id, deleted_at IS NULL AS live FROM iam_position WHERE code = 'designer'",
    ),
    role: await ds.query(
      "SELECT id, deleted_at IS NULL AS live FROM iam_role WHERE code = 'member'",
    ),
    config: await ds.query(
      "SELECT id, deleted_at IS NULL AS live FROM cg_table WHERE table_name = 'demo_topic'",
    ),
    columns: await ds.query(
      'SELECT COUNT(*) AS n FROM cg_column WHERE table_id = ? AND deleted_at IS NULL',
      [gone.config.id],
    ),
    links: await ds.query(
      `SELECT (SELECT COUNT(*) FROM iam_user_positions WHERE user_id = ? AND deleted_at IS NULL) AS positions,
              (SELECT COUNT(*) FROM iam_user_roles WHERE user_id = ? AND deleted_at IS NULL) AS roles,
              (SELECT COUNT(*) FROM iam_role_menus rm JOIN iam_role r ON r.id = rm.role_id
                WHERE r.code = 'demo' AND rm.deleted_at IS NULL) AS grants`,
      [admin.id, userId],
    ),
  })
  const before = await rows()
  expect(before).toMatchObject({
    action: [{ id: gone.action.id, live: 0, name: 'admin-edit', sort_no: 999 }],
    entry: [{ id: gone.entry.id, live: 0 }],
    position: [{ id: gone.position.id, live: 0 }],
    role: [{ id: gone.role.id, live: 0 }],
    config: [{ id: gone.config.id, live: 0 }],
    columns: [{ n: 0 }],
    links: [{ positions: 0, roles: 0, grants: 0 }],
  })
  await runSeeds(ds)
  await ds.transaction((q) => seedLimitedUser(q, 'seed-deleted', 'Limited@123'))
  expect(await rows()).toEqual(before)
})

it('without SEED_ADMIN_PASSWORD: a random password, printed once, that must be changed', async () => {
  vi.stubEnv('SEED_ADMIN_PASSWORD', '')
  const notices = await runSeeds(ds)
  expect(notices).toEqual([
    expect.stringMatching(/^seed: admin password/),
    expect.stringMatching(INITIAL_NOTICE),
    expect.stringMatching(OA_NOTICE),
  ])
  const password = notices[0].split(': ').pop()!
  expect(password).toMatch(/^[\w-]{16}$/)
  const admin = await one(
    "SELECT password_hash, password_changed_at FROM iam_user WHERE username = 'admin'",
  )
  expect(admin.password_changed_at).toBeNull()
  expect(await bcrypt.compare(password, admin.password_hash)).toBe(true)

  expect(await runSeeds(ds)).toEqual([]) // existing admin: nothing new to print, hash untouched
  expect(await one("SELECT password_hash FROM iam_user WHERE username = 'admin'")).toEqual({
    password_hash: admin.password_hash,
  })
  vi.unstubAllEnvs()
})

it('seedLimitedUser: role demo with the home page only (no dict permission), idempotent', async () => {
  await runSeeds(ds)
  const id = await ds.transaction((q) => seedLimitedUser(q, 'e2e-seed-limited', 'Limited@123'))
  expect(await ds.transaction((q) => seedLimitedUser(q, 'e2e-seed-limited', 'Other@123'))).toBe(id)
  const user = await one(
    'SELECT u.password_hash, u.password_changed_at, u.enabled, r.code, r.name, r.data_scope FROM iam_user u JOIN iam_user_roles ur ON ur.user_id = u.id JOIN iam_role r ON r.id = ur.role_id WHERE u.id = ?',
    [id],
  )
  expect(user).toMatchObject({
    enabled: 1,
    code: 'demo',
    name: 'seed.role.demo',
    data_scope: 'own_dept',
  })
  expect(user.password_changed_at).toBeInstanceOf(Date)
  expect(await bcrypt.compare('Limited@123', user.password_hash)).toBe(true)
  const granted = await ds.query(
    "SELECT m.route_name, m.perms FROM iam_role_menus rm JOIN iam_role r ON r.id = rm.role_id JOIN iam_menu m ON m.id = rm.menu_id WHERE r.code = 'demo'",
  )
  expect(granted).toEqual([{ route_name: 'home', perms: null }])
})

it('--only picks domains; unknown domains are rejected', async () => {
  await runSeeds(ds, ['iam'])
  await runSeeds(ds, ['settings'])
  expect(await one('SELECT COUNT(*) AS n FROM iam_role')).toEqual({ n: 2 })
  expect(await one('SELECT COUNT(*) AS n FROM cfg_dict')).toEqual({ n: 10 })
  await expect(runSeeds(ds, ['nope'])).rejects.toThrow('unknown seed domain')
})

it.each(['true', 'false', undefined])(
  'admin seed with APP_DEMO_MODE=%s: random credential, only a new demo admin skips first change',
  async (mode) => {
    vi.stubEnv('APP_DEMO_MODE', mode)
    vi.stubEnv('SEED_ADMIN_PASSWORD', '')
    try {
      const notices = await runSeeds(ds)
      const notice = notices.find((line) => line.startsWith('seed: admin password'))!
      const password = notice.split(': ').pop()!
      expect(password).toMatch(/^[\w-]{16}$/)
      expect(notice.includes('must be changed at first sign-in')).toBe(mode !== 'true')
      const admin = await one(
        "SELECT password_hash, password_changed_at FROM iam_user WHERE username = 'admin'",
      )
      expect(await bcrypt.compare(password, admin.password_hash)).toBe(true)
      expect(admin.password_changed_at instanceof Date).toBe(mode === 'true')
      expect(admin.password_changed_at === null).toBe(mode !== 'true')

      const ordinary = await insertRow(ds.manager, 'iam_user', {
        username: 'test-demo-ordinary',
        display_name: 'Ordinary',
        password_hash: 'keep-ordinary',
        password_changed_at: null,
      })
      // Changing mode and reseeding cannot overwrite any existing account's credential or flags.
      vi.stubEnv('APP_DEMO_MODE', mode === 'true' ? 'false' : 'true')
      expect(await runSeeds(ds)).toEqual([])
      expect(
        await one(
          "SELECT password_hash, password_changed_at FROM iam_user WHERE username = 'admin'",
        ),
      ).toEqual(admin)
      expect(
        await one('SELECT password_hash, password_changed_at FROM iam_user WHERE id = ?', [
          ordinary,
        ]),
      ).toEqual({ password_hash: 'keep-ordinary', password_changed_at: null })
    } finally {
      vi.unstubAllEnvs()
    }
  },
)

it('demo admin uses the deployment preset unchanged, with no password notice', async () => {
  vi.stubEnv('APP_DEMO_MODE', 'true')
  vi.stubEnv('SEED_ADMIN_PASSWORD', 'Deployment-preset#2026')
  try {
    const notices = await runSeeds(ds)
    expect(notices.some((line) => line.startsWith('seed: admin password'))).toBe(false)
    const admin = await one(
      "SELECT password_hash, password_changed_at FROM iam_user WHERE username = 'admin'",
    )
    expect(await bcrypt.compare('Deployment-preset#2026', admin.password_hash)).toBe(true)
    expect(admin.password_changed_at).toBeInstanceOf(Date)
  } finally {
    vi.unstubAllEnvs()
  }
})
