// `node dist/db/tenancy-harden.js` (cwd apps/server, env like db:migrate: `node
// --env-file-if-exists=.env.local --env-file-if-exists=.env dist/db/tenancy-harden.js`): drops the
// `DEFAULT 1` of every tenant column (see docs/design-notes.md#tenancy), so an INSERT that leaves out
// `tenant_id` fails (1364; `aud_signin_log`'s nullable one too) instead of landing in the default tenant.
// Idempotent and metadata only (`ALGORITHM=INSTANT`): running code is not held up, a column without a
// default is skipped. `db:migrate` runs the same after migrating while
// multi-tenancy is on, and db:reset and the test setup on every reset.
import { DataSource } from 'typeorm'
import { assertProductionSecrets } from '../core/config/production-secrets.js'
import { PLATFORM_TABLES } from '../core/db/tenant-tables.js'
import { dataSourceOptions } from './data-source.js'

type Queryable = { query(sql: string, params?: unknown[]): Promise<unknown> }

/**
 * How long an ALTER waits for its table's metadata lock (seconds), how many times it tries, the pause
 * between: even an instant ALTER needs a brief exclusive lock, and a long transaction on a busy table
 * would hold it (and every statement queued behind it) up.
 */
export const LOCK_WAIT = { seconds: 5, attempts: 3, pauseMs: 3000 }

/**
 * The tenant columns that still have a default (`table.column`): `tenant_id` of every tenant table and
 * `aud_action_log.actor_tenant_id`.
 */
export async function tenantDefaults(q: Queryable): Promise<string[]> {
  const rows = (await q.query(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns
      WHERE table_schema = DATABASE() AND column_default IS NOT NULL
        AND ((column_name = 'tenant_id' AND table_name NOT IN (?))
          OR (table_name = 'aud_action_log' AND column_name = 'actor_tenant_id'))
      ORDER BY table_name, column_name`,
    [PLATFORM_TABLES],
  )) as { t: string; c: string }[]
  return rows.map((r) => `${r.t}.${r.c}`)
}

/**
 * Drops the default of every column `tenantDefaults` names, each ALTER waiting at most `lockWait` for its
 * table, a few times, then failing (run it again). Returns the columns changed.
 */
export async function hardenTenancy(ds: DataSource, lockWait = LOCK_WAIT): Promise<string[]> {
  const q = ds.createQueryRunner()
  try {
    const columns = await tenantDefaults(q)
    if (!columns.length) return []
    await q.query('SET SESSION lock_wait_timeout = ?', [lockWait.seconds])
    try {
      for (const column of columns) {
        const [table, name] = column.split('.')
        // arch-allow: sql-concat table and column names read from information_schema just above; tenant: a schema change over every tenant's rows
        const sql = `ALTER TABLE \`${table}\` ALTER COLUMN \`${name}\` DROP DEFAULT, ALGORITHM=INSTANT`
        for (let attempt = 1; ; attempt++) {
          try {
            // arch-allow: sql-concat the ALTER assembled just above; tenant: a schema change over every tenant's rows
            await q.query(sql)
            break
          } catch (err) {
            const code = (err as { driverError?: { code?: string } }).driverError?.code
            if (code !== 'ER_LOCK_WAIT_TIMEOUT' || attempt >= lockWait.attempts) throw err
            await new Promise((resolve) => setTimeout(resolve, lockWait.pauseMs))
          }
        }
      }
    } finally {
      await q.query('SET SESSION lock_wait_timeout = DEFAULT')
    }
    return columns
  } finally {
    await q.release()
  }
}

async function main(): Promise<void> {
  assertProductionSecrets(process.env)
  const ds = new DataSource(dataSourceOptions())
  await ds.initialize()
  try {
    const done = await hardenTenancy(ds)
    console.log(
      done.length
        ? `tenancy-harden: default dropped on ${done.join(' ')}`
        : 'tenancy-harden: no tenant column has a default, nothing to do',
    )
  } finally {
    await ds.destroy()
  }
}

// runs as the command only: migrate, reset and the specs import the functions
if (process.argv[1]?.endsWith('tenancy-harden.js'))
  main().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
