// Migration round trip (criterion c; see docs/adr/002-orm.md): the compiled `node dist/db/reset.js` (drop +
// run + tenancy-harden), one `node dist/db/migrate.js revert`, then back one by one to an empty schema
// and up again one by one in this process, the newest migration again through `migrate.js run`: after
// every step the `meta_migrations` rows and the schema the way down left at that step. Plus the DDL
// conventions (soft delete everywhere, no foreign keys; the soft-delete migration's down restores the
// old shape) and the tenancy rules over every table the migrations create.
// Nothing here lists the migrations or their tables by hand: both are read from src/db/migrations
// (test/setup/migrations.ts), so a project's own migrations and tables are covered as they are added.
// Needs a fresh build (`pnpm db:reset` and ci:local build first).
import { existsSync, readdirSync } from 'node:fs'
import { DataSource } from 'typeorm'
import { it as nativeIt } from 'vitest'
import { GLOBAL_UNIQUE, PLATFORM_TABLES } from '../../src/core/db/tenant-tables.js'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { Tenancy20261007100000 } from '../../src/db/migrations/20261007100000-tenant.js'
import { tenantDefaults } from '../../src/db/tenancy-harden.js'
import {
  killed,
  MIGRATION_NAMES as MIGRATIONS,
  MIGRATION_TABLES,
  runScript,
  SCRIPT_CASE_MS,
  MigrationCaseFence,
  migrationTests,
  SOURCE_MIGRATIONS,
} from '../setup/migrations.js'
import { restoreTestSchema } from '../setup/schema.js'
import { recoverMigrationRun } from '../setup/migration-run-safety.js'

/** 某个迁移在运行顺序里的位置；找不到就报错（迁移改名后用例不会悄悄失效）。 */
const at = (name: string): number => {
  const i = MIGRATIONS.indexOf(name)
  if (i < 0) throw new Error(`migration ${name} not found in src/db/migrations`)
  return i
}
/** Applied migrations once SoftDeleteAll is reverted: its down is checked there. */
const BEFORE_SOFT_DELETE = at('SoftDeleteAll20260929100000')
const TENANCY_INDEX = at('Tenancy20261007100000')
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

/** The tables the migrations create (present in the migrated database at the start). */
let ALL_TABLES: string[] = []
let ds: DataSource
const fence = new MigrationCaseFence()
/** 本文件的全部普通/参数化用例都使用可取消迁移保护与同一份预算。 */
const it = migrationTests(nativeIt, fence)

const migrateCli = (command: 'run' | 'revert') => {
  const r = runScript('dist/db/migrate.js', [command])
  expect(r).toMatchObject({ status: 0 }) // a failure diff shows stderr
}
/** 回退最新的一个迁移（本进程内，与命令行相同的事务方式）。 */
const undo = () => ds.undoLastMigration({ transaction: 'each' })
/** 执行全部未执行的迁移（本进程内）。 */
const runAll = () => ds.runMigrations({ transaction: 'each' })
/** 逐个回退，直到只剩运行顺序里的前 `n` 个迁移。 */
const revertTo = async (n: number) => {
  while ((await executed()).length > n) await undo()
}
/**
 * 只执行到运行顺序里的第 `n` 个迁移：TypeORM 没有“执行到某一个”的入口，这里在一次调用期间只让前 `n`
 * 个迁移对 DataSource 可见（`migrations` 在类型上只读，运行时是普通数组），之后立即换回全部。
 */
const runTo = async (n: number) => {
  const all = ds.migrations
  Object.assign(ds, { migrations: all.slice(0, n) })
  try {
    await runAll()
  } finally {
    Object.assign(ds, { migrations: all })
  }
}
const tables = async (): Promise<string[]> =>
  (
    await ds.query(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (?) ORDER BY table_name',
      [ALL_TABLES],
    )
  ).map((r: { t: string }) => r.t)
/** Every base table of the schema, whoever created it. */
const everyTable = async (): Promise<string[]> =>
  (
    await ds.query(
      "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name",
    )
  ).map((r: { t: string }) => r.t)
/**
 * 迁移建的表此刻的结构：每列（名、类型、可空）与每个索引列（索引名、是否唯一、位置、列名）。不含默认值：
 * 重置会去掉租户列的默认值，逐个重跑的迁移不会。
 */
const schema = async (): Promise<string[]> =>
  [
    ...(
      await ds.query(
        `SELECT CONCAT(table_name, '.', column_name, ' ', column_type, ' ', is_nullable) AS c
         FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name IN (?)`,
        [ALL_TABLES],
      )
    ).map((r: { c: string }) => r.c),
    ...(
      await ds.query(
        `SELECT CONCAT(table_name, '.', index_name, ' ', non_unique, ' ', seq_in_index, ' ', column_name) AS c
         FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name IN (?)`,
        [ALL_TABLES],
      )
    ).map((r: { c: string }) => `key ${r.c}`),
  ].sort()
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
/** Expected state after the first `n` migrations: their rows, in run order. */
const expectApplied = async (n: number) => {
  expect(await executed()).toEqual(MIGRATIONS.slice(0, n))
}

beforeAll(async () => {
  const stale = readdirSync('src/db/migrations')
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !existsSync(`dist/db/migrations/${f.replace(/\.ts$/, '.js')}`))
  if (!existsSync('dist/db/reset.js') || stale.length)
    throw new Error(`dist is missing or stale (${stale}): pnpm --filter @qiwu/server build`)
  ds = await new DataSource({ ...dataSourceOptions(), migrations: SOURCE_MIGRATIONS }).initialize()
  fence.install(ds)
  // globalSetup migrated everything: the tables the migrations name that exist (one created and
  // dropped again by later migrations is none of them)
  const present = new Set(await everyTable())
  ALL_TABLES = MIGRATION_TABLES.filter((t) => present.has(t))
})

// a script killed by its timeout may have left a migration half done: the later cases of this file
// would only fail on that state, so they are skipped and afterAll rebuilds the database
beforeEach((context) => {
  if (killed.script || fence.unsafe)
    context.skip(
      'a prior migration case may have left the database half migrated; the database is rebuilt in afterAll',
    )
  fence.begin(context.signal)
})

// 等待原异步函数的 finally 真正退出；超过可配置预算时 fence 终止 worker，不与恢复并行。
afterEach(async () => {
  await fence.drain()
}, SCRIPT_CASE_MS)

afterAll(async () => {
  // leave the globalSetup state (migrated, hardened, seeded) behind, whatever a failed case reverted
  await fence.drain()
  if (ds?.isInitialized) {
    await recoverMigrationRun(async () => {
      if (killed.script || fence.unsafe) await ds.dropDatabase()
      await restoreTestSchema(ds)
    })
  }
  await ds?.destroy()
}, SCRIPT_CASE_MS)

it('every source migration file holds one migration, in timestamp order', () => {
  const files = readdirSync('src/db/migrations').filter((f) => f.endsWith('.ts'))
  expect(MIGRATIONS).toHaveLength(files.length)
  expect(ALL_TABLES.length).toBeGreaterThan(0)
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
          const r = runScript('dist/db/migrate.js', [command], {
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
      if (!killed.script) await runAll()
    }
  },
  SCRIPT_CASE_MS,
)

// a failure (or the timeout, which vitest does not stop: the body ends at its next step) migrates again in
// `finally`, so no half-reverted test database is left to fail every later file; after a killed script
// nothing runs on the half-migrated database (afterAll rebuilds it)
it(
  'dist reset.js drops and migrates; back one by one to empty and up again, the command line first and last',
  async ({ signal }) => {
    try {
      await roundTrip(() => signal.throwIfAborted())
    } finally {
      // the case's own failure is the one to report, not a follow-up error of this way back
      if (!killed.script) await runAll().catch(() => undefined)
    }
    expect(await executed()).toEqual(MIGRATIONS)
  },
  SCRIPT_CASE_MS,
)

async function roundTrip(step: () => void) {
  const N = MIGRATIONS.length
  const reset = runScript('dist/db/reset.js')
  expect(reset).toMatchObject({ status: 0 })
  await expectApplied(N)
  // after the drop only the migrations made tables: one the source scan cannot name fails here
  expect(await everyTable()).toEqual([...ALL_TABLES, 'meta_migrations'].sort())
  expect(await tenantDefaults(ds)).toEqual([]) // reset hardens the tenant columns before seeding

  await runAll() // nothing pending: a no-op
  await expectApplied(N)
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
    "INSERT INTO msg_bulletin (tenant_id, title, kind, body, deleted_at) VALUES (1, 'gone', 'notice', 'x', NOW(3))",
  )
  await ds.query(
    'INSERT INTO msg_bulletin_receipt (tenant_id, bulletin_id, user_id) VALUES (1, ?, 1)',
    [bulletin],
  )

  // the schema after the first n migrations, as the way down leaves it
  const states: string[][] = []
  states[N] = await schema()
  migrateCli('revert') // the command line reverts the newest one
  for (let n = N - 1; n >= 0; n--) {
    step()
    if (n < N - 1) await undo()
    await expectApplied(n)
    states[n] = await schema()
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
  await undo() // nothing left: a no-op
  await expectApplied(0)
  expect(await tables()).toEqual([])

  // up again one by one: each up gives back the schema its down took away
  for (let n = 1; n < N; n++) {
    step()
    await runTo(n)
    await expectApplied(n)
    expect(await schema()).toEqual(states[n])
  }
  migrateCli('run') // the newest one through the command line again
  await expectApplied(N)
  expect(await schema()).toEqual(states[N])
  expect(await foreignKeys()).toEqual([])

  // the migrations' own shape (multi-tenancy off keeps it; hardening drops the defaults): the tenant
  // column of every tenant table that existed once the tenancy migration ran, and the operator's
  // tenant, default to 1; tables created later carry a required tenant_id without one
  const afterTenancy = new Set(states[TENANCY_INDEX + 1].map((c) => c.split('.')[0]))
  const required = await ds.query(
    `SELECT table_name AS t FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name IN (?) AND column_name = 'tenant_id'`,
    [ALL_TABLES],
  )
  const defaulted = await tenantDefaults(ds)
  expect([...defaulted].sort()).toEqual(
    [
      'aud_action_log.actor_tenant_id',
      ...required
        .map((r: { t: string }) => r.t)
        .filter((t: string) => afterTenancy.has(t) && !PLATFORM_TABLES.includes(t))
        .map((t: string) => `${t}.tenant_id`),
    ].sort(),
  )
  expect(
    await ds.query(
      `SELECT DISTINCT column_default AS d FROM information_schema.columns
        WHERE table_schema = DATABASE() AND CONCAT(table_name, '.', column_name) IN (?)`,
      [defaulted],
    ),
  ).toEqual([{ d: '1' }])
}

it('ProjectPaths moves the stored view paths of the moved views, down moves them back', async () => {
  // rows as a database before the move holds them (the migrations after ProjectPaths reverted first)
  const before = at('ProjectPaths20260930120000')
  await revertTo(before)
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
    await runAll()
    expect(await stored()).toEqual(expected(NEW))
    await revertTo(before)
    expect(await stored()).toEqual(expected(OLD))
  } finally {
    await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [menus.length ? menus : [0]])
    await ds.query('DELETE FROM wf_model WHERE id IN (?)', [models.length ? models : [0]])
    await runAll()
  }
  await expectApplied(MIGRATIONS.length)
})

it('dist reset.js refuses production and databases without a _dev/_test/_e2e suffix', () => {
  for (const env of [{ NODE_ENV: 'production' }, { DB_NAME: 'qiwu' }]) {
    const r = runScript('dist/db/reset.js', [], env)
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

  it('every table is soft-deleted, ordinary unique keys end with alive, effect and delivery keys stay durable, and no foreign keys remain', async () => {
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
    // 效果与投递键永久占用；缺键、添加 alive 或增加其它例外都必须由精确比较检出。
    expect(
      keys.filter((k) => !k.cols.endsWith(',alive')).sort((a, b) => a.k.localeCompare(b.k)),
    ).toEqual([
      {
        k: 'agent_message_receipt.uk_agent_message_client',
        cols: 'tenant_id,user_id,client_message_id',
      },
      {
        k: 'agent_thread.uk_agent_thread_client',
        cols: 'tenant_id,user_id,client_draft_id',
      },
    ])
    const alive = await ds.query<{ t: string; c: string }[]>(
      `SELECT table_name AS t, CONCAT(table_name, ' ', generation_expression) AS c FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name IN (?) AND column_name = 'alive'`,
      [ALL_TABLES],
    )
    // 永久收据表不靠 alive 释放唯一键；其他次级唯一键所在表仍必须有正确的生成列。
    expect(
      [...new Set(keys.map((k) => k.k.split('.')[0]))].filter(
        (table) => table !== 'agent_message_receipt' && !alive.some((column) => column.t === table),
      ),
    ).toEqual([])
    for (const { c } of alive) expect(c).toMatch(/ if\(\(`deleted_at` is null\),1,NULL\)$/)
    expect(await foreignKeys()).toEqual([])
  })

  it.each([
    ['iam_dept', "INSERT INTO iam_dept (tenant_id, tree_path, name) VALUES (1, ?, 'x')"],
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
  const WF_TABLES = [
    'biz_leave_request',
    'wf_cc',
    'wf_event',
    'wf_instance',
    'wf_model',
    'wf_task',
    'wf_version',
  ]
  const AUDIT = 'created_by created_at updated_by updated_at deleted_at'

  it('every workflow column, the later additions included, in order', async () => {
    const rows: { t: string; cols: string }[] = await ds.query(
      `SELECT table_name AS t, GROUP_CONCAT(column_name ORDER BY ordinal_position SEPARATOR ' ') AS cols
         FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name IN (?)
        GROUP BY table_name ORDER BY table_name`,
      [WF_TABLES],
    )
    expect(Object.fromEntries(rows.map((r) => [r.t, r.cols]))).toEqual({
      wf_model: `id model_key name category icon description form_kind flow_kind form_id create_route view_component draft_json draft_xml initiator_scope manager_user_ids allow_cancel allow_withdraw enabled sort_no current_version_id ${AUDIT} alive tenant_id`,
      wf_version:
        'id model_id model_key version tree_json bpmn_xml form_snapshot published_by published_at deleted_at alive tenant_id',
      wf_instance: `id version_id model_key business_key initiator_id initiator_dept_id state form_values initiator_picks initiator_ctx active_node_ids urged_at started_at ended_at ${AUDIT} tenant_id`,
      wf_task: `id instance_id node_id node_name assignee_id owner_id parent_task_id from_task_id sign_kind seq state comment due_at reminded_at handled_at ${AUDIT} tenant_id`,
      wf_cc:
        'id instance_id node_id user_id from_task_id from_user_id reason read_at created_at deleted_at tenant_id',
      wf_event:
        'id instance_id task_id node_id actor_id action target_ids comment created_at deleted_at tenant_id',
      biz_leave_request: `id user_id dept_id leave_kind start_at end_at days reason state instance_id ${AUDIT} tenant_id attachment_ids`,
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
        'biz_leave_request.idx_biz_leave_request_tenant': 'tenant_id',
        'biz_leave_request.idx_biz_leave_request_user': 'user_id',
        'wf_cc.idx_wf_cc_instance': 'instance_id',
        'wf_cc.idx_wf_cc_tenant': 'tenant_id',
        'wf_cc.idx_wf_cc_user': 'user_id',
        'wf_event.idx_wf_event_instance': 'instance_id',
        'wf_event.idx_wf_event_tenant': 'tenant_id',
        'wf_instance.idx_wf_instance_business': 'business_key',
        'wf_instance.idx_wf_instance_dept': 'initiator_dept_id',
        'wf_instance.idx_wf_instance_initiator_state': 'initiator_id,state',
        'wf_instance.idx_wf_instance_tenant': 'tenant_id',
        'wf_model.uk_wf_model_key': 'tenant_id,model_key,alive',
        'wf_task.idx_wf_task_assignee_state': 'assignee_id,state',
        'wf_task.idx_wf_task_instance': 'instance_id',
        'wf_task.idx_wf_task_state_due': 'state,due_at',
        'wf_task.idx_wf_task_tenant': 'tenant_id',
        'wf_version.idx_wf_version_model': 'model_id',
        'wf_version.uk_wf_version_model_version': 'tenant_id,model_key,version,alive',
      },
    )
  })

  it('a live model key and a model version are unique; a deleted one is free again', async () => {
    const qr = ds.createQueryRunner()
    await qr.startTransaction()
    try {
      const model =
        "INSERT INTO wf_model (tenant_id, model_key, name, form_kind) VALUES (1, 'mig-t', 'x', 'custom')"
      const dup = { driverError: { code: 'ER_DUP_ENTRY' } }
      const { insertId } = await qr.query(model)
      await expect(qr.query(model)).rejects.toMatchObject(dup)
      await qr.query('UPDATE wf_model SET deleted_at = NOW(3) WHERE id = ?', [insertId])
      await qr.query(model)

      const version = `INSERT INTO wf_version (tenant_id, model_id, model_key, version, tree_json, form_snapshot)
        VALUES (1, ?, 'mig-t', ?, '{}', '{}')`
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
      { k: 'idx_iam_user_social_tenant', cols: 'tenant_id' },
      { k: 'uk_iam_user_social_openid', cols: 'provider,appid,openid,alive' },
      { k: 'uk_iam_user_social_user', cols: 'user_id,provider,appid,alive' },
    ])
    const qr = ds.createQueryRunner()
    await qr.startTransaction()
    try {
      const bind = (userId: number, openid: string) =>
        qr.query(
          "INSERT INTO iam_user_social (tenant_id, provider, appid, openid, user_id) VALUES (1, 'wx-mp', 'wx-app', ?, ?)",
          [openid, userId],
        )
      const dup = { driverError: { code: 'ER_DUP_ENTRY' } }
      const { insertId } = await bind(1, 'o-1')
      await expect(bind(2, 'o-1')).rejects.toMatchObject(dup)
      await expect(bind(1, 'o-2')).rejects.toMatchObject(dup)
      // WeChat ids are case-sensitive (ascii_bin): another case is another identity
      await bind(3, 'O-1')
      await qr.query(
        "INSERT INTO iam_user_social (tenant_id, provider, appid, openid, user_id) VALUES (1, 'wx-mp', 'other-app', 'o-1', 1)",
      )
      await qr.query('UPDATE iam_user_social SET deleted_at = NOW(3) WHERE id = ?', [insertId])
      await bind(2, 'o-1')
      await bind(1, 'o-2')
      // across tenants too: a live identity binds one user of one tenant
      await expect(
        qr.query(
          "INSERT INTO iam_user_social (tenant_id, provider, appid, openid, user_id) VALUES (2, 'wx-mp', 'wx-app', 'o-1', 4)",
        ),
      ).rejects.toMatchObject(dup)
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
    const before = at('DictSingleDefault20261002120000')
    try {
      await revertTo(before)
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
      await runAll()
      expect(await stored()).toEqual(expected)
      // Revert later migrations first when new ones are appended.
      await revertTo(before)
      expect(await column()).toEqual([])
      expect(await index()).toEqual([])
      expect(await stored()).toEqual(expected) // down does not restore cleared duplicates
    } finally {
      await ds.query(
        "DELETE FROM cfg_dict_entry WHERE dict_code IN ('mig.upgrade', 'mig.upgrade.other')",
      )
      await runAll()
    }
    await expectApplied(MIGRATIONS.length)
  })
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
    const before = at('AuditUserType20261002120100')
    const marker = 'mig-audit-upgrade'
    let userId = 0
    try {
      await revertTo(before)
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
      await runAll()
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
      await revertTo(before)
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
      await runAll()
    }
    await expectApplied(MIGRATIONS.length)
  })
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
          "INSERT INTO oauth_consent (tenant_id, user_id, client_id, scope, expires_at) VALUES (1, 1, ?, 'user.read', NOW(3))",
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

describe('Tenancy', () => {
  const dup = { driverError: { code: 'ER_DUP_ENTRY' } }
  /** Every table the migrations create but the registered platform ones. */
  const tenantTables = () => ALL_TABLES.filter((t) => !PLATFORM_TABLES.includes(t))
  /** `tenant_id` of every table that has one: table → `type nullable`. */
  const tenantColumns = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (
        await ds.query(
          `SELECT table_name AS t, CONCAT(column_type, ' ', is_nullable) AS c
             FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name IN (?) AND column_name = 'tenant_id'`,
          [ALL_TABLES],
        )
      ).map((r: { t: string; c: string }) => [r.t, r.c]),
    )
  /** Every column and key the migration adds or changes, to compare whole states. */
  const tenancyState = async () => ({
    columns: await ds.query(
      `SELECT CONCAT(table_name, '.', column_name, ' ', column_type, ' ', is_nullable, ' ',
                     COALESCE(column_default, '-'), ' ', ordinal_position, ' ', column_comment) AS c
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name IN (?)
          AND column_name IN ('tenant_id', 'actor_tenant_id', 'platform_only')
        ORDER BY c`,
      [ALL_TABLES],
    ),
    keys: await ds.query(
      `SELECT CONCAT(table_name, '.', index_name, ' ', non_unique, ' ',
                     GROUP_CONCAT(column_name ORDER BY seq_in_index)) AS k
         FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name IN (?)
        GROUP BY table_name, index_name, non_unique ORDER BY k`,
      [ALL_TABLES],
    ),
  })
  const keyColumns = async (table: string, key: string) =>
    (
      await ds.query(
        `SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [table, key],
      )
    )[0].cols
  /** Runs `body` in a transaction that is always rolled back. */
  const rolledBack = async (
    body: (query: (sql: string, params?: unknown[]) => Promise<any>) => Promise<void>,
  ) => {
    const qr = ds.createQueryRunner()
    await qr.startTransaction()
    try {
      await body((sql, params) => qr.query(sql, params))
    } finally {
      await qr.rollbackTransaction()
      await qr.release()
    }
  }

  it('every table but the platform ones has a non-null tenant_id (nullable on aud_signin_log); a platform table may have a plain one', async () => {
    // a registered platform table exists (a misspelt name would leave the real table a tenant one)
    expect(
      PLATFORM_TABLES.filter((t) => t !== 'meta_migrations' && !ALL_TABLES.includes(t)),
    ).toEqual([])
    // a table that is neither a tenant table (tenant_id) nor a registered platform table fails here;
    // the defaults: hardened or not, depending on what ran before (see the migration round trip)
    const columns = await tenantColumns()
    expect(Object.fromEntries(tenantTables().map((t) => [t, columns[t]]))).toEqual(
      Object.fromEntries(
        tenantTables().map((t) => [
          t,
          t === 'aud_signin_log' ? 'bigint unsigned YES' : 'bigint unsigned NO',
        ]),
      ),
    )
    expect(columns).toMatchObject({
      aud_http_fault: 'bigint unsigned YES',
      aud_http_trace: 'bigint unsigned YES',
      iam_tenant_domain: 'bigint unsigned NO',
    })
    const added = await ds.query(
      `SELECT CONCAT(table_name, '.', column_name, ' ', column_type, ' ', is_nullable) AS c
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND column_name IN ('actor_tenant_id', 'platform_only')
        ORDER BY c`,
    )
    expect(added.map((r: { c: string }) => r.c)).toEqual([
      'aud_action_log.actor_tenant_id bigint unsigned NO',
      'iam_menu.platform_only tinyint(1) NO',
    ])
    expect(
      await ds.query('SELECT id, code, name, enabled, package_id, expires_at FROM iam_tenant'),
    ).toEqual([
      {
        id: 1,
        code: 'default',
        name: 'seed.tenant.default',
        enabled: 1,
        package_id: null,
        expires_at: null,
      },
    ])
  })

  it('an index led by tenant_id on every table with one but the join tables; unique keys start with it unless listed as global', async () => {
    const tablesWhere = async (condition: string) =>
      new Set(
        (
          await ds.query(
            `SELECT DISTINCT table_name AS t FROM information_schema.statistics
              WHERE table_schema = DATABASE() AND table_name IN (?) AND ${condition}`,
            [ALL_TABLES],
          )
        ).map((r: { t: string }) => r.t),
      )
    const led = await tablesWhere("seq_in_index = 1 AND column_name = 'tenant_id'")
    // join tables (a primary key of two or more columns) are read through one of their ids
    const joins = await tablesWhere("index_name = 'PRIMARY' AND seq_in_index = 2")
    expect(Object.keys(await tenantColumns()).filter((t) => !joins.has(t) && !led.has(t))).toEqual(
      [],
    )

    const uniques: { t: string; k: string; cols: string }[] = await ds.query(
      `SELECT table_name AS t, index_name AS k, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
         FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name IN (?) AND non_unique = 0 AND index_name <> 'PRIMARY'
        GROUP BY table_name, index_name`,
      [tenantTables()],
    )
    expect(
      uniques.filter((u) => !Object.hasOwn(GLOBAL_UNIQUE, u.k) && !u.cols.startsWith('tenant_id,')),
    ).toEqual([])
    expect(uniques.some((u) => u.cols.startsWith('tenant_id,'))).toBe(true)
    // every global key is a key of its table, each with how a taken value is freed
    expect(
      Object.fromEntries(
        uniques.filter((u) => Object.hasOwn(GLOBAL_UNIQUE, u.k)).map((u) => [u.k, u.t]),
      ),
    ).toEqual(Object.fromEntries(Object.entries(GLOBAL_UNIQUE).map(([k, { table }]) => [k, table])))
    for (const { release } of Object.values(GLOBAL_UNIQUE))
      expect(['none', 'row-delete', 'takeover']).toContain(release)
  })

  it('two tenants each have an admin, a top-level dept of one name and a model key; within a tenant they stay unique', async () => {
    await rolledBack(async (query) => {
      const user = (tenant: number, username: string) =>
        query(
          "INSERT INTO iam_user (tenant_id, username, password_hash, display_name) VALUES (?, ?, 'x', 'x')",
          [tenant, username],
        )
      await user(1, 'mig-admin')
      await user(2, 'mig-admin')
      await expect(user(2, 'mig-admin')).rejects.toMatchObject(dup)
      await expect(user(1, 'mig-admin')).rejects.toMatchObject(dup)
      const dept = (tenant: number) =>
        query("INSERT INTO iam_dept (tenant_id, tree_path, name) VALUES (?, '/', 'mig-top')", [
          tenant,
        ])
      await dept(1)
      await dept(2)
      await expect(dept(2)).rejects.toMatchObject(dup)
      const model = (tenant: number) =>
        query(
          "INSERT INTO wf_model (tenant_id, model_key, name, form_kind) VALUES (?, 'mig-t', 'x', 'custom')",
          [tenant],
        )
      await model(1)
      await model(2)
      await expect(model(1)).rejects.toMatchObject(dup)
    })
  })

  it('a live tenant code and a live domain are unique across tenants; a deleted domain is free again', async () => {
    await rolledBack(async (query) => {
      const tenant = (code: string) =>
        query("INSERT INTO iam_tenant (code, name) VALUES (?, 'x')", [code])
      const { insertId: second } = await tenant('mig-two')
      await expect(tenant('mig-two')).rejects.toMatchObject(dup)
      await expect(tenant('default')).rejects.toMatchObject(dup)
      const bind = (tenantId: number, domain: string) =>
        query('INSERT INTO iam_tenant_domain (tenant_id, domain) VALUES (?, ?)', [tenantId, domain])
      const { insertId } = await bind(1, 'a.example.com')
      await bind(1, 'b.example.com') // a tenant binds several
      await expect(bind(second, 'a.example.com')).rejects.toMatchObject(dup)
      await query('UPDATE iam_tenant_domain SET deleted_at = NOW(3) WHERE id = ?', [insertId])
      await bind(second, 'a.example.com')
    })
  })

  it('down refuses while a second tenant exists and changes nothing', async () => {
    // Tenancy 后面已有 WXOA 迁移：先只回退后续迁移，确保本用例实际测试 Tenancy.down 的拒绝逻辑。
    await revertTo(TENANCY_INDEX + 1)
    const before = await tenancyState()
    const { insertId } = await ds.query(
      "INSERT INTO iam_tenant (code, name) VALUES ('mig-second', 'x')",
    )
    try {
      await expect(undo()).rejects.toThrow('Tenancy down refused')
      await expectApplied(TENANCY_INDEX + 1)
      expect(await tenancyState()).toEqual(before)
    } finally {
      await runAll() // back, had the down gone through
      await ds.query('DELETE FROM iam_tenant WHERE id = ?', [insertId])
    }
  })

  it('the Official Account tenant migration refuses its down while a row of another tenant exists and changes nothing', async () => {
    const wxoa = at('WxoaTenant20261018100000')
    await revertTo(wxoa + 1)
    const before = await tenancyState()
    const { insertId } = await ds.query(
      "INSERT INTO wxoa_tag (tenant_id, account_id, tag_id, name) VALUES (2, 999999, 1, 'mig-other')",
    )
    try {
      await expect(undo()).rejects.toThrow('WxoaTenant down refused')
      await expectApplied(wxoa + 1)
      expect(await tenancyState()).toEqual(before)
    } finally {
      await ds.query('DELETE FROM wxoa_tag WHERE id = ?', [insertId])
      await runAll()
    }
    await expectApplied(MIGRATIONS.length)
  })

  it('an up stopped halfway finishes when run again', async () => {
    const before = await tenancyState()
    try {
      // 后续迁移在真实的 Tenancy.up 失败时不会运行；先回退它们再模拟中途留下的 DDL。
      await revertTo(TENANCY_INDEX + 1)
      // 模拟迁移执行到一半失败：记录未写入，但部分 DDL 已经落库。
      await ds.query('DELETE FROM meta_migrations WHERE name = ?', [MIGRATIONS[TENANCY_INDEX]])
      await ds.query('ALTER TABLE wf_task DROP INDEX idx_wf_task_tenant')
      await ds.query(
        'ALTER TABLE wf_form DROP INDEX uk_wf_form_name, ADD UNIQUE KEY uk_wf_form_name (name, alive)',
      )
      await ds.query('ALTER TABLE wf_cc DROP COLUMN tenant_id')
      await ds.query('ALTER TABLE iam_menu DROP COLUMN platform_only')
      expect(await tenancyState()).not.toEqual(before)
    } finally {
      await runAll()
    }
    await expectApplied(MIGRATIONS.length)
    expect(await tenancyState()).toEqual(before)
  })

  it('up fails in bounded time while another session holds a table it alters, and finishes once released', async () => {
    const holder = ds.createQueryRunner()
    const runner = ds.createQueryRunner()
    const tenancy = new Tenancy20261007100000()
    tenancy.lockWait = { seconds: 1, attempts: 2, pauseMs: 100 }
    try {
      await ds.query('ALTER TABLE wf_task DROP INDEX idx_wf_task_tenant')
      await holder.startTransaction()
      await holder.query('SELECT id FROM wf_task LIMIT 1') // its metadata lock is held until commit
      const query = runner.query.bind(runner)
      const tries: string[] = []
      runner.query = ((sql: string, ...rest: unknown[]) => {
        if (sql.startsWith('ALTER TABLE wf_task ')) tries.push(sql)
        return (query as (...args: unknown[]) => unknown)(sql, ...rest)
      }) as typeof runner.query
      const started = Date.now()
      await expect(tenancy.up(runner)).rejects.toMatchObject({
        driverError: { code: 'ER_LOCK_WAIT_TIMEOUT' },
      })
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(10_000)
      // tried as often as allowed, each time waiting the bounded time
      expect(tries).toHaveLength(2)
      expect(elapsed).toBeGreaterThanOrEqual(2000)
      runner.query = query
      expect(await keyColumns('wf_task', 'idx_wf_task_tenant')).toBeNull()
      await holder.commitTransaction()
      await tenancy.up(runner)
      expect(await keyColumns('wf_task', 'idx_wf_task_tenant')).toBe('tenant_id')
    } finally {
      if (holder.isTransactionActive) await holder.rollbackTransaction()
      await holder.release()
      await new Tenancy20261007100000().up(runner) // whatever failed above
      await runner.release()
    }
  })
})
