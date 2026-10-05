// Migration round trip through the compiled output (criterion c; see docs/adr/002-orm.md): spawns
// `node dist/db/reset.js` (drop + run) and `node dist/db/migrate.js` run → revert one by one down to an
// empty schema → run, checking the tables and `meta_migrations` rows after every step, plus the DDL
// conventions (soft delete everywhere, no foreign keys; the soft-delete migration's down restores the old shape).
// Needs a fresh build (`pnpm db:reset` and ci:local build first).
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { DataSource } from 'typeorm'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { runSeeds } from '../../src/db/seeds/index.js'

/** Migrations in run order with the tables each creates. A new migration adds its line here. */
const MIGRATIONS: [name: string, tables: string[]][] = [
  [
    'IamCore20260926100000',
    [
      'iam_dept',
      'iam_menu',
      'iam_role',
      'iam_role_depts',
      'iam_role_menus',
      'iam_user',
      'iam_user_roles',
    ],
  ],
  ['Cfg20260926100100', ['cfg_dict', 'cfg_dict_entry', 'cfg_param']],
  ['AudSignin20260926100200', ['aud_signin_log']],
  ['AudAction20260926100300', ['aud_action_log']],
  ['IamPosition20260927100000', ['iam_position', 'iam_user_positions']],
  ['IamUserPref20260927110000', ['iam_user_pref']],
  ['Fs20260927120000', ['fs_object', 'fs_storage']],
  ['Cg20260927130000', ['cg_column', 'cg_table']],
  ['DemoBook20260927130100', ['demo_book']],
  ['DemoTopic20260927140000', ['demo_topic']],
  ['IamMenuTree20260927150000', []],
  ['IamMenuPath20260927150100', []],
  ['MsgBulletin20260927160500', ['msg_bulletin', 'msg_bulletin_receipt']],
  ['DemoInvoice20260927170000', ['demo_invoice', 'demo_invoice_line']],
  ['AudHttp20260928100000', ['aud_http_fault', 'aud_http_trace']],
  ['Job20260928110000', ['job_run', 'job_task']],
  ['JobMisfire20260928120000', []],
  [
    'MsgNotify20260928130000',
    [
      'msg_inbox',
      'msg_inbox_template',
      'msg_mail_account',
      'msg_mail_record',
      'msg_mail_template',
      'msg_sms_channel',
      'msg_sms_otp',
      'msg_sms_record',
      'msg_sms_template',
    ],
  ],
  ['MsgClaim20260928140000', []],
  ['NotifyDispatchOn20260928140100', []],
  ['SignupRoleId20260928150000', []],
  ['SmsOtpUser20260928150100', []],
  ['SoftDeleteAll20260929100000', []],
  [
    'Wf20260930100000',
    ['biz_leave_request', 'wf_cc', 'wf_event', 'wf_instance', 'wf_model', 'wf_task', 'wf_version'],
  ],
  ['AudSigninUser20260930110000', []],
  ['ProjectPaths20260930120000', []],
  ['IamUserSocial20261001100000', ['iam_user_social']],
  ['WfForm20261001110000', ['wf_form']],
  ['WfBpmn20261001120000', []],
  ['Oauth20261002100000', ['oauth_client', 'oauth_consent']],
  ['CfgAppVersion20261002110000', ['cfg_app_version']],
  ['DictSingleDefault20261002120000', []],
  ['AuditUserType20261002120100', []],
]
/** Applied migrations once SoftDeleteAll is reverted: its down is checked there. */
const BEFORE_SOFT_DELETE = MIGRATIONS.findIndex(([name]) => name === 'SoftDeleteAll20260929100000')
/** The foreign keys SoftDeleteAll dropped: its down puts them back. */
const FOREIGN_KEYS = [
  'fk_cg_column_table',
  'fk_cg_table_master',
  'fk_demo_book_dept',
  'fk_demo_invoice_line_invoice',
  'fk_fs_object_storage',
  'fk_iam_user_positions_position',
  'fk_iam_user_pref_user',
  'fk_msg_bulletin_receipt_bulletin',
  'fk_msg_mail_template_account',
  'fk_msg_sms_template_channel',
]
const ALL_TABLES = MIGRATIONS.flatMap(([, tables]) => tables)

let ds: DataSource

// a hung script is killed (status null), so the case fails instead of the file timing out
const node = (script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  })
const migrateOnce = (command: 'run' | 'revert') => {
  const r = node('dist/db/migrate.js', [command])
  expect(r).toMatchObject({ status: 0 }) // a failure diff shows stderr
}
const tables = async (): Promise<string[]> =>
  (
    await ds.query(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (?) ORDER BY table_name',
      [ALL_TABLES],
    )
  ).map((r: { t: string }) => r.t)
const executed = async (): Promise<string[]> =>
  (await ds.query('SELECT name FROM meta_migrations ORDER BY id')).map(
    (r: { name: string }) => r.name,
  )
const foreignKeys = async (): Promise<string[]> =>
  (
    await ds.query(
      'SELECT constraint_name AS k FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() ORDER BY k',
    )
  ).map((r: { k: string }) => r.k)
/** Expected state after the first `n` migrations. */
const expectApplied = async (n: number) => {
  expect(await executed()).toEqual(MIGRATIONS.slice(0, n).map(([name]) => name))
  expect(await tables()).toEqual(
    MIGRATIONS.slice(0, n)
      .flatMap(([, t]) => t)
      .sort(),
  )
}

beforeAll(async () => {
  const stale = readdirSync('src/db/migrations')
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !existsSync(`dist/db/migrations/${f.replace(/\.ts$/, '.js')}`))
  if (!existsSync('dist/db/reset.js') || stale.length)
    throw new Error(`dist is missing or stale (${stale}): pnpm --filter @qiwu/server build`)
  ds = await new DataSource(dataSourceOptions()).initialize()
})

afterAll(async () => {
  // leave the globalSetup state (migrated + seeded) behind, whatever a failed case reverted
  node('dist/db/migrate.js', ['run'])
  if (ds?.isInitialized) await runSeeds(ds)
  await ds?.destroy()
})

it('lists every source migration', () => {
  expect(readdirSync('src/db/migrations').filter((f) => f.endsWith('.ts'))).toHaveLength(
    MIGRATIONS.length,
  )
})

it.each(['APP_SECRET', 'SEED_ADMIN_PASSWORD'] as const)(
  'dist/db/migrate.js refuses a production marker in %s before connecting or changing migrations',
  async (field) => {
    const marker = 'Admin@12345-NoT-FoR-PrOdUcTiOn'
    const secret = 'production-secret-fixture-0123456789abcdef'
    const before = { migrations: await executed(), tables: await tables() }
    try {
      for (const command of ['run', 'revert', 'show']) {
        // An unreachable port must still give the credential error, before any DB operation.
        for (const port of ['1', process.env.DB_PORT!]) {
          const r = node('dist/db/migrate.js', [command], {
            NODE_ENV: 'production',
            DB_PORT: port,
            APP_SECRET: secret,
            SEED_ADMIN_PASSWORD: '',
            [field]: marker,
          })
          expect(r.error).toBeUndefined()
          expect(r.status).toBe(1)
          const output = r.stdout + r.stderr
          expect(output).toContain(
            `${field}: production credentials must not contain the test marker`,
          )
          expect(output).not.toContain(marker)
          expect(output).not.toContain(secret)
          expect({ migrations: await executed(), tables: await tables() }).toEqual(before)
        }
      }
    } finally {
      migrateOnce('run')
    }
  },
)

// a failure (or the timeout, which vitest does not stop: the body ends at its next step) migrates again in
// `finally`, so no half-reverted qiwu_test is left to fail every later file
it('dist reset.js drops and migrates; migrate.js reverts one by one to empty and runs again', async ({
  signal,
}) => {
  try {
    await roundTrip((command) => {
      signal.throwIfAborted()
      migrateOnce(command)
    })
  } finally {
    node('dist/db/migrate.js', ['run'])
  }
  expect(await executed()).toEqual(MIGRATIONS.map(([name]) => name))
  // one node process per migration and more: it grows with each new migration
}, 180_000)

async function roundTrip(migrate: (command: 'run' | 'revert') => void) {
  const reset = node('dist/db/reset.js')
  expect(reset).toMatchObject({ status: 0 })
  await expectApplied(MIGRATIONS.length)

  migrate('run') // nothing pending: a no-op
  await expectApplied(MIGRATIONS.length)
  expect(await foreignKeys()).toEqual([])

  // SoftDeleteAll's down: soft-deleted rows of tables it made soft go for good (a live row may reuse
  // their key meanwhile), so do rows a former CASCADE key would have taken with a parent now gone
  const [param] = await ds.query(
    "SELECT * FROM cfg_param WHERE param_key = 'core.default_timezone'",
  )
  await ds.query('UPDATE cfg_param SET deleted_at = NOW(3) WHERE id = ?', [param.id])
  await ds.query(
    "INSERT INTO cfg_param (param_key, param_value, name) VALUES ('core.default_timezone', 'UTC', 'again')",
  )
  const { insertId: bulletin } = await ds.query(
    "INSERT INTO msg_bulletin (title, kind, body, deleted_at) VALUES ('gone', 'notice', 'x', NOW(3))",
  )
  await ds.query('INSERT INTO msg_bulletin_receipt (bulletin_id, user_id) VALUES (?, 1)', [
    bulletin,
  ])

  for (let n = MIGRATIONS.length - 1; n >= 0; n--) {
    migrate('revert')
    await expectApplied(n)
    if (n !== BEFORE_SOFT_DELETE) continue
    expect(await foreignKeys()).toEqual(FOREIGN_KEYS)
    expect(
      await ds.query("SELECT name FROM cfg_param WHERE param_key = 'core.default_timezone'"),
    ).toEqual([{ name: 'again' }])
    expect(
      await ds.query('SELECT bulletin_id FROM msg_bulletin_receipt WHERE bulletin_id = ?', [
        bulletin,
      ]),
    ).toEqual([])
    const [{ n: soft }] = await ds.query(
      "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name = 'deleted_at'",
    )
    expect(soft).toBe(4) // iam_user, iam_role, iam_dept, demo_book: soft-deleted before SoftDeleteAll
  }
  migrate('revert') // nothing left: a no-op
  await expectApplied(0)

  migrate('run')
  await expectApplied(MIGRATIONS.length)
  expect(await foreignKeys()).toEqual([])
}

it('ProjectPaths moves the stored view paths of the moved views, down moves them back', async () => {
  // rows as a database before the move holds them (the migrations after ProjectPaths reverted first)
  const after =
    MIGRATIONS.length - MIGRATIONS.findIndex(([name]) => name === 'ProjectPaths20260930120000')
  for (let n = 0; n < after; n++) migrateOnce('revert')
  const OLD = [
    'biz/demo/book/index',
    'biz/biz/leave/view',
    'Biz/Demo/other', // another case: not a moved path
    'platform/iam/user/index',
    'x/biz/demo/y',
    null,
  ]
  const NEW = ['demo/book/index', 'biz/leave/view', ...OLD.slice(2)]
  const menus: number[] = []
  const models: number[] = []
  try {
    for (const [i, path] of OLD.entries()) {
      const { insertId: menu } = await ds.query(
        "INSERT INTO iam_menu (tree_path, kind, name, component, updated_at, deleted_at) VALUES ('/', 'page', 'pd-t', ?, '2026-01-01', IF(? = 1, NOW(3), NULL))",
        [path, i % 2],
      )
      menus.push(menu)
      const { insertId: model } = await ds.query(
        "INSERT INTO wf_model (model_key, name, form_kind, view_component, updated_at) VALUES (?, 'x', 'custom', ?, '2026-01-01')",
        [`pd-t-${i}`, path],
      )
      models.push(model)
    }
    const stored = async () => [
      (
        await ds.query(
          'SELECT component AS c, updated_at AS u FROM iam_menu WHERE id IN (?) ORDER BY id',
          [menus],
        )
      ).map((r: { c: string | null; u: Date }) => [r.c, r.u.toISOString()]),
      (
        await ds.query(
          'SELECT view_component AS c, updated_at AS u FROM wf_model WHERE id IN (?) ORDER BY id',
          [models],
        )
      ).map((r: { c: string | null; u: Date }) => [r.c, r.u.toISOString()]),
    ]
    const expected = (paths: (string | null)[]) => {
      const rows = paths.map((p) => [p, '2026-01-01T00:00:00.000Z'])
      return [rows, rows]
    }
    migrateOnce('run')
    expect(await stored()).toEqual(expected(NEW))
    for (let n = 0; n < after; n++) migrateOnce('revert')
    expect(await stored()).toEqual(expected(OLD))
  } finally {
    await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [menus.length ? menus : [0]])
    await ds.query('DELETE FROM wf_model WHERE id IN (?)', [models.length ? models : [0]])
    migrateOnce('run')
  }
  await expectApplied(MIGRATIONS.length)
}, 30_000)

it('dist reset.js refuses production and databases without a _dev/_test/_e2e suffix', () => {
  for (const env of [{ NODE_ENV: 'production' }, { DB_NAME: 'qiwu' }]) {
    const r = node('dist/db/reset.js', [], env)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('db:reset refused')
  }
})

describe('DDL conventions', () => {
  it('InnoDB, utf8mb4_0900_ai_ci and a comment on every table and column', async () => {
    const bad = await ds.query(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()
         AND table_name IN (?) AND (engine <> 'InnoDB' OR table_collation <> 'utf8mb4_0900_ai_ci' OR table_comment = '')`,
      [ALL_TABLES],
    )
    expect(bad).toEqual([])
    const uncommented = await ds.query(
      `SELECT CONCAT(table_name, '.', column_name) AS c FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name IN (?) AND column_comment = ''`,
      [ALL_TABLES],
    )
    expect(uncommented).toEqual([])
  })

  it('ids and *_by are bigint unsigned, *_at are datetime(3)', async () => {
    const bad = await ds.query(
      `SELECT CONCAT(table_name, '.', column_name, ' ', column_type) AS c FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name IN (?) AND (
           ((column_name = 'id' OR column_name LIKE '%\\_by') AND column_type <> 'bigint unsigned')
           OR (column_name LIKE '%\\_at' AND column_type <> 'datetime(3)'))`,
      [ALL_TABLES],
    )
    expect(bad).toEqual([])
  })

  it('Every table soft-deleted, a unique key besides the primary one ends with alive, no foreign keys', async () => {
    const hard = await ds.query(
      `SELECT t.table_name AS t FROM information_schema.tables t WHERE t.table_schema = DATABASE()
         AND t.table_name IN (?) AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name
             AND c.column_name = 'deleted_at' AND c.column_type = 'datetime(3)' AND c.is_nullable = 'YES')`,
      [ALL_TABLES],
    )
    expect(hard).toEqual([])
    const keys: { k: string; cols: string }[] = await ds.query(
      `SELECT CONCAT(table_name, '.', index_name) AS k, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
         FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name IN (?) AND non_unique = 0 AND index_name <> 'PRIMARY'
        GROUP BY table_name, index_name`,
      [ALL_TABLES],
    )
    expect(keys.length).toBeGreaterThan(20)
    expect(keys.filter((k) => !k.cols.endsWith(',alive'))).toEqual([])
    const alive = await ds.query(
      `SELECT CONCAT(table_name, ' ', generation_expression) AS c FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name IN (?) AND column_name = 'alive'`,
      [ALL_TABLES],
    )
    expect(alive.length).toBe(new Set(keys.map((k) => k.k.split('.')[0])).size)
    for (const { c } of alive) expect(c).toMatch(/ if\(\(`deleted_at` is null\),1,NULL\)$/)
    expect(await foreignKeys()).toEqual([])
  })

  it.each([
    ['iam_dept', "INSERT INTO iam_dept (tree_path, name) VALUES (?, 'x')"],
    ['iam_menu', "INSERT INTO iam_menu (tree_path, kind, name) VALUES (?, 'group', 'x')"],
  ])('%s.tree_path is ascii and must end with /', async (table, insert) => {
    const [col] = await ds.query(
      "SELECT character_set_name AS cs FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'tree_path'",
      [table],
    )
    expect(col.cs).toBe('ascii')
    for (const path of ['/1', '1/', '/1//', '/a/'])
      await expect(ds.query(insert, [path])).rejects.toMatchObject({
        driverError: { code: 'ER_CHECK_CONSTRAINT_VIOLATED' },
      })
  })
})

describe('Workflow tables', () => {
  const WF_TABLES = MIGRATIONS.find(([name]) => name === 'Wf20260930100000')![1]
  const AUDIT = 'created_by created_at updated_by updated_at deleted_at'

  it('every workflow column, the later additions included, in order', async () => {
    const rows: { t: string; cols: string }[] = await ds.query(
      `SELECT table_name AS t, GROUP_CONCAT(column_name ORDER BY ordinal_position SEPARATOR ' ') AS cols
         FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name IN (?)
        GROUP BY table_name ORDER BY table_name`,
      [WF_TABLES],
    )
    expect(Object.fromEntries(rows.map((r) => [r.t, r.cols]))).toEqual({
      wf_model: `id model_key name category icon description form_kind flow_kind form_id create_route view_component draft_json draft_xml initiator_scope manager_user_ids allow_cancel allow_withdraw enabled sort_no current_version_id ${AUDIT} alive`,
      wf_version:
        'id model_id model_key version tree_json bpmn_xml form_snapshot published_by published_at deleted_at alive',
      wf_instance: `id version_id model_key business_key initiator_id initiator_dept_id state form_values initiator_picks initiator_ctx active_node_ids urged_at started_at ended_at ${AUDIT}`,
      wf_task: `id instance_id node_id node_name assignee_id owner_id parent_task_id from_task_id sign_kind seq state comment due_at reminded_at handled_at ${AUDIT}`,
      wf_cc:
        'id instance_id node_id user_id from_task_id from_user_id reason read_at created_at deleted_at',
      wf_event:
        'id instance_id task_id node_id actor_id action target_ids comment created_at deleted_at',
      biz_leave_request: `id user_id dept_id leave_kind start_at end_at days reason state instance_id ${AUDIT}`,
    })
    // the engine's ids, lengths and json columns (WfInstance / WfTask, shared wf-engine.ts)
    const types = Object.fromEntries(
      (
        await ds.query(
          `SELECT CONCAT(table_name, '.', column_name) AS c, CONCAT(column_type, IF(is_nullable = 'YES', ' null', '')) AS type
             FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name IN (?)`,
          [WF_TABLES],
        )
      ).map((r: { c: string; type: string }) => [r.c, r.type]),
    )
    expect(types).toMatchObject({
      'wf_instance.initiator_ctx': 'json',
      'wf_instance.active_node_ids': 'json',
      'wf_instance.urged_at': 'datetime(3) null',
      'wf_task.node_id': 'varchar(64)',
      'wf_task.node_name': 'varchar(64)',
      'wf_task.from_task_id': 'bigint unsigned null',
      'wf_task.due_at': 'datetime(3) null',
      'wf_task.reminded_at': 'datetime(3) null',
      'wf_task.comment': 'varchar(1000) null',
      'wf_event.comment': 'varchar(1000) null',
      'wf_cc.reason': 'varchar(1000) null',
      'biz_leave_request.days': 'decimal(5,1)',
      'biz_leave_request.instance_id': 'bigint unsigned null',
      'wf_model.flow_kind': 'varchar(8)',
      'wf_model.draft_xml': 'mediumtext null',
      'wf_version.bpmn_xml': 'mediumtext null',
    })
  })

  it('the listed indexes (to-do lists, reminders, lookups by instance, user and business key)', async () => {
    const keys = await ds.query(
      `SELECT CONCAT(table_name, '.', index_name) AS k, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
         FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name IN (?) AND index_name <> 'PRIMARY'
        GROUP BY table_name, index_name ORDER BY k`,
      [WF_TABLES],
    )
    expect(Object.fromEntries(keys.map((r: { k: string; cols: string }) => [r.k, r.cols]))).toEqual(
      {
        'biz_leave_request.idx_biz_leave_request_dept': 'dept_id',
        'biz_leave_request.idx_biz_leave_request_user': 'user_id',
        'wf_cc.idx_wf_cc_instance': 'instance_id',
        'wf_cc.idx_wf_cc_user': 'user_id',
        'wf_event.idx_wf_event_instance': 'instance_id',
        'wf_instance.idx_wf_instance_business': 'business_key',
        'wf_instance.idx_wf_instance_dept': 'initiator_dept_id',
        'wf_instance.idx_wf_instance_initiator_state': 'initiator_id,state',
        'wf_model.uk_wf_model_key': 'model_key,alive',
        'wf_task.idx_wf_task_assignee_state': 'assignee_id,state',
        'wf_task.idx_wf_task_instance': 'instance_id',
        'wf_task.idx_wf_task_state_due': 'state,due_at',
        'wf_version.idx_wf_version_model': 'model_id',
        'wf_version.uk_wf_version_model_version': 'model_key,version,alive',
      },
    )
  })

  it('a live model key and a model version are unique; a deleted one is free again', async () => {
    const qr = ds.createQueryRunner()
    await qr.startTransaction()
    try {
      const model =
        "INSERT INTO wf_model (model_key, name, form_kind) VALUES ('mig-t', 'x', 'custom')"
      const dup = { driverError: { code: 'ER_DUP_ENTRY' } }
      const { insertId } = await qr.query(model)
      await expect(qr.query(model)).rejects.toMatchObject(dup)
      await qr.query('UPDATE wf_model SET deleted_at = NOW(3) WHERE id = ?', [insertId])
      await qr.query(model)

      const version = `INSERT INTO wf_version (model_id, model_key, version, tree_json, form_snapshot)
        VALUES (?, 'mig-t', ?, '{}', '{}')`
      const { insertId: v1 } = await qr.query(version, [insertId, 1])
      await qr.query(version, [insertId, 2])
      await expect(qr.query(version, [insertId, 1])).rejects.toMatchObject(dup)
      await qr.query('UPDATE wf_version SET deleted_at = NOW(3) WHERE id = ?', [v1])
      await qr.query(version, [insertId, 1])
    } finally {
      await qr.rollbackTransaction()
      await qr.release()
    }
  })
})

describe('Sign-in bindings', () => {
  it('a live identity (case-sensitive) binds one user, a user one identity per provider and app; unbinding frees both', async () => {
    const keys = await ds.query(
      `SELECT index_name AS k, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
         FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'iam_user_social' AND index_name <> 'PRIMARY'
        GROUP BY index_name ORDER BY k`,
    )
    expect(keys).toEqual([
      { k: 'uk_iam_user_social_openid', cols: 'provider,appid,openid,alive' },
      { k: 'uk_iam_user_social_user', cols: 'user_id,provider,appid,alive' },
    ])
    const qr = ds.createQueryRunner()
    await qr.startTransaction()
    try {
      const bind = (userId: number, openid: string) =>
        qr.query(
          "INSERT INTO iam_user_social (provider, appid, openid, user_id) VALUES ('wx-mp', 'wx-app', ?, ?)",
          [openid, userId],
        )
      const dup = { driverError: { code: 'ER_DUP_ENTRY' } }
      const { insertId } = await bind(1, 'o-1')
      await expect(bind(2, 'o-1')).rejects.toMatchObject(dup)
      await expect(bind(1, 'o-2')).rejects.toMatchObject(dup)
      // WeChat ids are case-sensitive (ascii_bin): another case is another identity
      await bind(3, 'O-1')
      await qr.query(
        "INSERT INTO iam_user_social (provider, appid, openid, user_id) VALUES ('wx-mp', 'other-app', 'o-1', 1)",
      )
      await qr.query('UPDATE iam_user_social SET deleted_at = NOW(3) WHERE id = ?', [insertId])
      await bind(2, 'o-1')
      await bind(1, 'o-2')
    } finally {
      await qr.rollbackTransaction()
      await qr.release()
    }
  })
})

describe('Dict single default', () => {
  const dup = { driverError: { code: 'ER_DUP_ENTRY' } }
  const column = () =>
    ds.query(
      `SELECT column_type AS type, is_nullable AS nullable, extra AS gen
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'cfg_dict_entry' AND column_name = 'default_one'`,
    )
  const index = () =>
    ds.query(
      `SELECT non_unique AS nonUnique, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
         FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'cfg_dict_entry' AND index_name = 'uk_cfg_dict_entry_default'
        GROUP BY non_unique`,
    )

  it('uses a nullable tinyint VIRTUAL column and a unique (dict_code, default_one, alive) key', async () => {
    expect(await column()).toEqual([{ type: 'tinyint', nullable: 'YES', gen: 'VIRTUAL GENERATED' }])
    expect(await index()).toEqual([{ nonUnique: 0, cols: 'dict_code,default_one,alive' }])
  })

  it('allows zero or one default per dict, unlimited non-defaults; insert and update reject a second default', async () => {
    const qr = ds.createQueryRunner()
    await qr.startTransaction()
    try {
      const add = (dict: string, value: string, isDefault: number) =>
        qr.query(
          "INSERT INTO cfg_dict_entry (dict_code, value, label, is_default) VALUES (?, ?, 'x', ?)",
          [dict, value, isDefault],
        )
      const { insertId } = await add('mig.zero', 'a', 0)
      await add('mig.zero', 'b', 0)
      await add('mig.zero', 'c', 0)
      expect(
        await qr.query(
          "SELECT COUNT(*) AS n FROM cfg_dict_entry WHERE dict_code = 'mig.zero' AND is_default = 1",
        ),
      ).toEqual([{ n: 0 }])
      await add('mig.zero', 'default', 1)
      await expect(add('mig.zero', 'second', 1)).rejects.toMatchObject(dup)
      await expect(
        qr.query('UPDATE cfg_dict_entry SET is_default = 1 WHERE id = ?', [insertId]),
      ).rejects.toMatchObject(dup)
      await add('mig.other', 'default', 1)
      expect(
        await qr.query(
          "SELECT dict_code, COUNT(*) AS n FROM cfg_dict_entry WHERE dict_code IN ('mig.zero', 'mig.other') AND is_default = 1 GROUP BY dict_code ORDER BY dict_code",
        ),
      ).toEqual([
        { dict_code: 'mig.other', n: 1 },
        { dict_code: 'mig.zero', n: 1 },
      ])
    } finally {
      await qr.rollbackTransaction()
      await qr.release()
    }
  })

  it('soft-delete and clearing the default free the slot; a disabled default still occupies it', async () => {
    const qr = ds.createQueryRunner()
    await qr.startTransaction()
    try {
      const add = (value: string, enabled = 1) =>
        qr.query(
          "INSERT INTO cfg_dict_entry (dict_code, value, label, is_default, enabled) VALUES ('mig.slot', ?, 'x', 1, ?)",
          [value, enabled],
        )
      const { insertId: first } = await add('first')
      await qr.query('UPDATE cfg_dict_entry SET deleted_at = NOW(3) WHERE id = ?', [first])
      const { insertId: next } = await add('next')
      await qr.query('UPDATE cfg_dict_entry SET is_default = 0 WHERE id = ?', [next])
      await add('disabled', 0)
      await expect(add('enabled')).rejects.toMatchObject(dup)
      expect(
        await qr.query(
          "SELECT value, is_default, default_one, alive FROM cfg_dict_entry WHERE dict_code = 'mig.slot' ORDER BY id",
        ),
      ).toEqual([
        { value: 'first', is_default: 1, default_one: 1, alive: null },
        { value: 'next', is_default: 0, default_one: null, alive: 1 },
        { value: 'disabled', is_default: 1, default_one: 1, alive: 1 },
      ])
    } finally {
      await qr.rollbackTransaction()
      await qr.release()
    }
  })

  it('two connections racing to insert a default have exactly one winner after commit', async () => {
    const first = ds.createQueryRunner()
    const second = ds.createQueryRunner()
    try {
      await first.startTransaction()
      await second.startTransaction()
      const [a] = await first.query('SELECT CONNECTION_ID() AS id')
      const [b] = await second.query('SELECT CONNECTION_ID() AS id')
      expect(a.id).not.toBe(b.id)
      // Bound the wait in MySQL itself, so a failed case cannot leave a pending lock holder.
      await second.query('SET SESSION innodb_lock_wait_timeout = 3')
      const insert =
        "INSERT INTO cfg_dict_entry (dict_code, value, label, is_default) VALUES ('mig.race', ?, 'x', 1)"
      const winner = await first.query(insert, ['first'])
      const contender = Promise.allSettled([second.query(insert, ['second'])])
      await first.commitTransaction()
      expect(winner.affectedRows).toBe(1)
      expect(await contender).toMatchObject([{ status: 'rejected', reason: dup }])
      await second.rollbackTransaction()
      expect(
        await ds.query(
          "SELECT value FROM cfg_dict_entry WHERE dict_code = 'mig.race' AND is_default = 1",
        ),
      ).toEqual([{ value: 'first' }])
    } finally {
      for (const qr of [first, second]) {
        if (qr.isTransactionActive) await qr.rollbackTransaction()
        await qr.release()
      }
      await ds.query("DELETE FROM cfg_dict_entry WHERE dict_code = 'mig.race'")
    }
  })

  it('upgrade keeps the lowest sort_no then id, leaves deleted defaults and other dicts alone; down removes the constraint', async () => {
    const after =
      MIGRATIONS.length -
      MIGRATIONS.findIndex(([name]) => name === 'DictSingleDefault20261002120000')
    try {
      for (let n = 0; n < after; n++) migrateOnce('revert')
      const add = (
        dict: string,
        value: string,
        sort: number,
        deleted = 0,
        isDefault = 1,
        enabled = 1,
      ) =>
        ds.query(
          `INSERT INTO cfg_dict_entry (dict_code, value, label, sort_no, is_default, enabled, deleted_at)
           VALUES (?, ?, 'x', ?, ?, ?, IF(? = 1, NOW(3), NULL))`,
          [dict, value, sort, isDefault, enabled, deleted],
        )
      await add('mig.upgrade', 'sort5', 5)
      const { insertId: survivor } = await add('mig.upgrade', 'sort1-first', 1, 0, 1, 0)
      const { insertId: duplicate } = await add('mig.upgrade', 'sort1-second', 1)
      expect(survivor).toBeLessThan(duplicate)
      await add('mig.upgrade', 'deleted', 0, 1)
      await add('mig.upgrade', 'non-default', -1, 0, 0)
      await add('mig.upgrade.other', 'single', 5)
      const stored = () =>
        ds.query(
          "SELECT value, is_default FROM cfg_dict_entry WHERE dict_code IN ('mig.upgrade', 'mig.upgrade.other') ORDER BY id",
        )
      const expected = [
        { value: 'sort5', is_default: 0 },
        { value: 'sort1-first', is_default: 1 },
        { value: 'sort1-second', is_default: 0 },
        { value: 'deleted', is_default: 1 },
        { value: 'non-default', is_default: 0 },
        { value: 'single', is_default: 1 },
      ]
      migrateOnce('run')
      expect(await stored()).toEqual(expected)
      // Revert later migrations first when new ones are appended.
      for (let n = 0; n < after; n++) migrateOnce('revert')
      expect(await column()).toEqual([])
      expect(await index()).toEqual([])
      expect(await stored()).toEqual(expected) // down does not restore cleared duplicates
    } finally {
      await ds.query(
        "DELETE FROM cfg_dict_entry WHERE dict_code IN ('mig.upgrade', 'mig.upgrade.other')",
      )
      migrateOnce('run')
    }
    await expectApplied(MIGRATIONS.length)
  }, 30_000)
})

describe('Audit user_type', () => {
  const logs = [
    {
      table: 'aud_signin_log',
      columns: 'kind, username, client_id, ok',
      values: "'password', 'mig-audit', 'console', 1",
    },
    {
      table: 'aud_action_log',
      columns: 'domain, verb, http_method, url, ok, cost_ms',
      values: "'mig.audit', 'create', 'POST', '/mig-audit', 1, 0",
    },
  ]
  const column = (table: string) =>
    ds.query(
      `SELECT column_type AS type, is_nullable AS nullable, column_default AS def,
              column_comment AS comment, ordinal_position AS pos
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'user_type'`,
      [table],
    )

  it.each(logs)(
    '$table: non-null varchar(16), default admin, directly after user_id',
    async ({ table }) => {
      const [{ pos }] = await ds.query(
        `SELECT ordinal_position AS pos FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'user_id'`,
        [table],
      )
      expect(await column(table)).toEqual([
        {
          type: 'varchar(16)',
          nullable: 'NO',
          def: 'admin',
          comment: '用户类型（admin/member，来源于会话）',
          pos: pos + 1,
        },
      ])
    },
  )

  it.each(logs)(
    '$table: omitted identity defaults to admin, explicit member persists, NULL is rejected',
    async ({ table, columns, values }) => {
      const qr = ds.createQueryRunner()
      await qr.startTransaction()
      try {
        const { insertId: omitted } = await qr.query(
          `INSERT INTO ${table} (${columns}) VALUES (${values})`,
        )
        const { insertId: member } = await qr.query(
          `INSERT INTO ${table} (${columns}, user_type) VALUES (${values}, ?)`,
          ['member'],
        )
        expect(
          await qr.query(`SELECT user_type FROM ${table} WHERE id IN (?, ?) ORDER BY id`, [
            omitted,
            member,
          ]),
        ).toEqual([{ user_type: 'admin' }, { user_type: 'member' }])
        await expect(
          qr.query(`INSERT INTO ${table} (${columns}, user_type) VALUES (${values}, ?)`, [null]),
        ).rejects.toMatchObject({ driverError: { code: 'ER_BAD_NULL_ERROR' } })
      } finally {
        await qr.rollbackTransaction()
        await qr.release()
      }
    },
  )

  it('upgrade makes live and deleted historic rows admin regardless of current user identity; down preserves rows', async () => {
    const after =
      MIGRATIONS.length - MIGRATIONS.findIndex(([name]) => name === 'AuditUserType20261002120100')
    const marker = 'mig-audit-upgrade'
    let userId = 0
    try {
      for (let n = 0; n < after; n++) migrateOnce('revert')
      // a member today: the historic rows still read admin (no back-fill from iam_user)
      ;({ insertId: userId } = await ds.query(
        "INSERT INTO iam_user (username, password_hash, display_name, user_type) VALUES (?, 'x', 'x', 'member')",
        [marker],
      ))
      for (const { table, columns, values } of logs) {
        expect(await column(table)).toEqual([])
        for (const deleted of [0, 1])
          await ds.query(
            `INSERT INTO ${table} (${columns}, trace_id, user_id, deleted_at)
             VALUES (${values}, ?, ?, IF(? = 1, NOW(3), NULL))`,
            [marker, userId, deleted],
          )
      }
      migrateOnce('run')
      for (const { table } of logs)
        expect(
          await ds.query(
            `SELECT user_id, user_type, deleted_at IS NOT NULL AS deleted FROM ${table} WHERE trace_id = ? ORDER BY id`,
            [marker],
          ),
        ).toEqual([
          { user_id: userId, user_type: 'admin', deleted: 0 },
          { user_id: userId, user_type: 'admin', deleted: 1 },
        ])
      for (let n = 0; n < after; n++) migrateOnce('revert')
      for (const { table } of logs) {
        expect(await column(table)).toEqual([])
        expect(
          await ds.query(
            `SELECT user_id, deleted_at IS NOT NULL AS deleted FROM ${table} WHERE trace_id = ? ORDER BY id`,
            [marker],
          ),
        ).toEqual([
          { user_id: userId, deleted: 0 },
          { user_id: userId, deleted: 1 },
        ])
      }
    } finally {
      for (const { table } of logs)
        await ds.query(`DELETE FROM ${table} WHERE trace_id = ?`, [marker])
      await ds.query('DELETE FROM iam_user WHERE username = ?', [marker])
      migrateOnce('run')
    }
    await expectApplied(MIGRATIONS.length)
  }, 30_000)
})

describe('OAuth2 clients and consents', () => {
  it('a live client id (case-sensitive) is unique and free again once deleted; a consent is one per user, client row and scope', async () => {
    const cols = await ds.query(
      `SELECT CONCAT(table_name, '.', column_name, ' ', column_type, ' ', COALESCE(collation_name, '-'), ' ', is_nullable) AS c
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name IN ('oauth_client', 'oauth_consent')
          AND column_name IN ('client_id', 'secret_hash', 'scope')
`,
    )
    expect(cols.map((r: { c: string }) => r.c).sort()).toEqual([
      'oauth_client.client_id varchar(64) ascii_bin NO',
      'oauth_client.secret_hash varchar(100) ascii_bin YES',
      'oauth_consent.client_id bigint unsigned - NO',
      'oauth_consent.scope varchar(64) ascii_bin NO',
    ])
    const keys = await ds.query(
      `SELECT CONCAT(table_name, '.', index_name, ' ', IF(non_unique, 'key', 'unique')) AS k,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
         FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name IN ('oauth_client', 'oauth_consent')
        GROUP BY table_name, index_name, non_unique`,
    )
    expect(keys.map((r: { k: string; cols: string }) => `${r.k} ${r.cols}`).sort()).toEqual([
      'oauth_client.PRIMARY unique id',
      'oauth_client.uk_oauth_client_client_id unique client_id,alive',
      'oauth_consent.PRIMARY unique user_id,client_id,scope',
      'oauth_consent.idx_oauth_consent_client key client_id',
    ])
    const qr = ds.createQueryRunner()
    await qr.startTransaction()
    try {
      const add = (clientId: string) =>
        qr.query(
          `INSERT INTO oauth_client (client_id, name, grant_types, redirect_uris, scopes, auto_approve_scopes)
           VALUES (?, 'x', '[]', '[]', '[]', '[]')`,
          [clientId],
        )
      const dup = { driverError: { code: 'ER_DUP_ENTRY' } }
      const { insertId } = await add('crm-web')
      await expect(add('crm-web')).rejects.toMatchObject(dup)
      await add('CRM-web')
      await qr.query('UPDATE oauth_client SET deleted_at = NOW(3) WHERE id = ?', [insertId])
      const { insertId: again } = await add('crm-web')
      expect(again).not.toBe(insertId)
      const consent = (clientPk: number) =>
        qr.query(
          "INSERT INTO oauth_consent (user_id, client_id, scope, expires_at) VALUES (1, ?, 'user.read', NOW(3))",
          [clientPk],
        )
      await consent(insertId)
      await expect(consent(insertId)).rejects.toMatchObject(dup)
      // the re-registered id is another row: the deleted client's consent is not its consent
      await consent(again)
    } finally {
      await qr.rollbackTransaction()
      await qr.release()
    }
  })
})
