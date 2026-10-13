// Dropping the tenant columns' defaults (see docs/design-notes.md#tenancy): the tenancy-harden command
// (`hardenTenancy`, compiled `dist/db/tenancy-harden.js`) and the migrate entry that runs it after
// migrating while multi-tenancy is on — not in the run that upgrades an existing database to tenancy, at
// once on a new one. Columns are given their default back with SET DEFAULT to stand for a database not
// hardened yet. Needs a fresh build (`pnpm --filter @qiwu/server build`).
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { DataSource } from 'typeorm'
import { PLATFORM_TABLES } from '../../src/core/db/tenant-tables.js'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { Tenancy20261007100000 } from '../../src/db/migrations/20261007100000-tenant.js'
import { hardenTenancy } from '../../src/db/tenancy-harden.js'
import { restoreTestSchema } from '../setup/schema.js'

const TENANCY = new Tenancy20261007100000().name
const FAST = { seconds: 1, attempts: 2, pauseMs: 100 }

let ds: DataSource

// a hung script is killed (status null), so the case fails instead of the file timing out
const node = (script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120_000,
  })
const migrate = (command: 'run' | 'revert', multiTenant: boolean) => {
  const r = node('dist/db/migrate.js', [command], { APP_MULTI_TENANT: String(multiTenant) })
  expect(r).toMatchObject({ status: 0 }) // a failure diff shows stderr
  return r.stdout + r.stderr
}
const executed = async (): Promise<string[]> =>
  (await ds.query('SELECT name FROM meta_migrations ORDER BY id')).map(
    (r: { name: string }) => r.name,
  )
/** `table.column` of the tenant columns (every tenant table's tenant_id, the actor's tenant), `all` or the ones with a default. */
const columns = async (which: 'all' | 'defaulted'): Promise<string[]> =>
  (
    await ds.query(
      `SELECT CONCAT(table_name, '.', column_name) AS c FROM information_schema.columns
        WHERE table_schema = DATABASE() AND column_name IN ('tenant_id', 'actor_tenant_id')
          AND table_name NOT IN (?) ${which === 'defaulted' ? 'AND column_default IS NOT NULL' : ''}
        ORDER BY c`,
      [PLATFORM_TABLES],
    )
  ).map((r: { c: string }) => r.c)
/** Gives the columns their migration default back, as on a database not hardened yet. */
const giveDefaults = async (list: string[]) => {
  for (const column of list) {
    const [table, name] = column.split('.')
    // identifiers come from information_schema or this spec's constants
    await ds.query(`ALTER TABLE ${table} ALTER COLUMN ${name} SET DEFAULT 1`)
  }
}

beforeAll(async () => {
  if (!existsSync('dist/db/tenancy-harden.js') || !existsSync('dist/db/migrate.js'))
    throw new Error('dist is missing: pnpm --filter @qiwu/server build')
  ds = await new DataSource(dataSourceOptions()).initialize()
})

afterAll(async () => {
  // back to the globalSetup state, whatever a failed case left
  if (ds?.isInitialized) await restoreTestSchema(ds)
  await ds?.destroy()
})

it('drops the default of every tenant column, the nullable sign-in one and the actor’s tenant too; a second run alters nothing', async () => {
  const all = await columns('all')
  expect(all).toHaveLength(33) // 32 tenant tables' tenant_id + aud_action_log.actor_tenant_id
  expect(all).toEqual(
    expect.arrayContaining(['aud_action_log.actor_tenant_id', 'aud_signin_log.tenant_id']),
  )
  await giveDefaults(all)
  expect(await columns('defaulted')).toEqual(all)

  expect((await hardenTenancy(ds)).sort()).toEqual(all)
  expect(await columns('defaulted')).toEqual([])

  const sent: string[] = []
  const create = ds.createQueryRunner.bind(ds)
  const spy = vi.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
    const runner = create(...args)
    const query = runner.query.bind(runner)
    runner.query = ((sql: string, ...rest: unknown[]) => {
      sent.push(sql)
      return (query as (...a: unknown[]) => unknown)(sql, ...rest)
    }) as typeof runner.query
    return runner
  })
  try {
    expect(await hardenTenancy(ds)).toEqual([])
  } finally {
    spy.mockRestore()
  }
  expect(sent.length).toBeGreaterThan(0)
  expect(sent.filter((sql) => /^\s*(ALTER|SET)\b/i.test(sql))).toEqual([])
})

it('hardened, an insert that leaves out a tenant column fails (1364), the nullable sign-in log’s too', async () => {
  const runner = ds.createQueryRunner()
  await runner.startTransaction()
  try {
    const missing = (column: string) => ({
      driverError: {
        code: 'ER_NO_DEFAULT_FOR_FIELD',
        sqlMessage: `Field '${column}' doesn't have a default value`,
      },
    })
    const dept = (columns: string, values: string) =>
      runner.query(
        `INSERT INTO iam_dept (${columns}tree_path, name) VALUES (${values}'/', 'harden-x')`,
      )
    await expect(dept('', '')).rejects.toMatchObject(missing('tenant_id'))
    await dept('tenant_id, ', '1, ') // nothing else missing
    const action = (columns: string, values: string) =>
      runner.query(
        `INSERT INTO aud_action_log (${columns}tenant_id, domain, verb, http_method, url, ok, cost_ms)
         VALUES (${values}1, 'iam.dept', 'create', 'POST', '/x', 1, 1)`,
      )
    await expect(action('', '')).rejects.toMatchObject(missing('actor_tenant_id'))
    await action('actor_tenant_id, ', '1, ')
    // the nullable one has no default either: left out it fails the same way (strict mode); an attempt
    // for an unknown tenant code names its NULL
    const signin = (columns: string, values: string) =>
      runner.query(
        `INSERT INTO aud_signin_log (${columns}kind, username, client_id, ok, msg_key)
         VALUES (${values}'password', 'harden-x', 'console', 0, 'signin.fail')`,
      )
    await expect(signin('', '')).rejects.toMatchObject(missing('tenant_id'))
    const { insertId } = await signin('tenant_id, ', 'NULL, ')
    expect(
      await runner.query('SELECT tenant_id FROM aud_signin_log WHERE id = ?', [insertId]),
    ).toEqual([{ tenant_id: null }])
  } finally {
    await runner.rollbackTransaction()
    await runner.release()
  }
})

it.each(['APP_SECRET', 'SEED_ADMIN_PASSWORD'] as const)(
  'dist/db/tenancy-harden.js refuses a production marker in %s before connecting or changing a column',
  async (field) => {
    const marker = 'Admin@12345-NoT-FoR-PrOdUcTiOn'
    const secret = 'production-secret-fixture-0123456789abcdef'
    await giveDefaults(['demo_book.tenant_id'])
    try {
      // an unreachable port must still give the credential error, before any DB operation
      for (const port of ['1', process.env.DB_PORT!]) {
        const r = node('dist/db/tenancy-harden.js', [], {
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
        expect(await columns('defaulted')).toEqual(['demo_book.tenant_id'])
      }
      // the same command with test credentials does the work
      const r = node('dist/db/tenancy-harden.js')
      expect(r).toMatchObject({ status: 0 })
      expect(r.stdout).toContain('demo_book.tenant_id')
      expect(await columns('defaulted')).toEqual([])
    } finally {
      await hardenTenancy(ds)
    }
  },
)

it('migrate run hardens after migrating with multi-tenancy on; off, the defaults stay', async () => {
  const two = ['aud_action_log.actor_tenant_id', 'demo_book.tenant_id']
  await giveDefaults(two)
  try {
    migrate('run', false)
    expect(await columns('defaulted')).toEqual(two)
    expect(migrate('run', true)).toContain('tenancy-harden: default dropped on')
    expect(await columns('defaulted')).toEqual([])
  } finally {
    await hardenTenancy(ds)
  }
}, 60_000)

it('upgrading a database to tenancy with multi-tenancy on: that run keeps the defaults and says why; the next run hardens', async () => {
  try {
    // a database from before tenancy: the tenancy migration and every later one reverted
    while ((await executed()).includes(TENANCY)) migrate('revert', false)
    expect(await executed()).not.toHaveLength(0)

    const said = migrate('run', true)
    expect(await executed()).toContain(TENANCY)
    expect(said).toContain('tenancy-harden: skipped')
    expect(said).toContain('APP_MULTI_TENANT off')
    expect(await columns('defaulted')).toEqual(await columns('all'))

    expect(migrate('run', true)).toContain('tenancy-harden: default dropped on')
    expect(await columns('defaulted')).toEqual([])
  } finally {
    await restoreTestSchema(ds) // the reverted platform flags and seed rows come back
  }
}, 120_000)

it('a new database with multi-tenancy on: one run migrates and hardens', async () => {
  try {
    await ds.dropDatabase()
    migrate('run', true)
    expect(await executed()).toHaveLength(
      readdirSync('src/db/migrations').filter((f) => f.endsWith('.ts')).length,
    )
    expect(await columns('all')).toHaveLength(33)
    expect(await columns('defaulted')).toEqual([])
  } finally {
    await restoreTestSchema(ds) // the seed rows
  }
}, 120_000)

it('fails in bounded time while another session holds a tenant table, and finishes once it is released', async () => {
  const holder = ds.createQueryRunner()
  try {
    await giveDefaults(['wf_task.tenant_id'])
    await holder.startTransaction()
    await holder.query('SELECT id FROM wf_task LIMIT 1') // its metadata lock is held until commit
    const started = Date.now()
    await expect(hardenTenancy(ds, FAST)).rejects.toMatchObject({
      driverError: { code: 'ER_LOCK_WAIT_TIMEOUT' },
    })
    const elapsed = Date.now() - started
    // tried as often as allowed, each time waiting the bounded time
    expect(elapsed).toBeGreaterThanOrEqual(2000)
    expect(elapsed).toBeLessThan(10_000)
    expect(await columns('defaulted')).toEqual(['wf_task.tenant_id'])
    await holder.commitTransaction()
    expect(await hardenTenancy(ds, FAST)).toEqual(['wf_task.tenant_id'])
    expect(await columns('defaulted')).toEqual([])
  } finally {
    if (holder.isTransactionActive) await holder.rollbackTransaction()
    await holder.release()
    await hardenTenancy(ds) // whatever failed above
  }
}, 30_000)
