// `node dist/db/migrate.js [run|revert|show]` (cwd apps/server; server script `db:migrate`, env from
// `.env.local` + `.env`, shell env wins). Runs the compiled migrations in dist/db/migrations.
// With multi-tenancy on, `run` then drops the tenant columns' defaults (tenancy-harden.ts), unless this
// very run upgraded an existing database to tenancy (see `hardenAfterRun`).
import { DataSource } from 'typeorm'
import { multiTenant } from '../core/config/multi-tenant.js'
import { assertProductionSecrets } from '../core/config/production-secrets.js'
import { dataSourceOptions } from './data-source.js'
import { Tenancy20261007100000 } from './migrations/20261007100000-tenant.js'
import { hardenTenancy } from './tenancy-harden.js'

const TENANCY = new Tenancy20261007100000().name

/** The migrations recorded so far; none while `meta_migrations` does not exist yet. */
async function recorded(ds: DataSource): Promise<string[]> {
  const [table] = await ds.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'meta_migrations'",
  )
  if (!table) return []
  return (await ds.query<{ name: string }[]>('SELECT name FROM meta_migrations')).map((r) => r.name)
}

/**
 * Hardening right after the run that adds the tenant columns to an existing database would break the
 * old version still serving it (its inserts leave `tenant_id` out) and the version a failed deploy rolls
 * back to. So an upgrade turns multi-tenancy on in a second deploy; a new database (nothing recorded
 * before this run) has no old version and is hardened at once.
 */
const hardenAfterRun = (before: string[]): boolean => !before.length || before.includes(TENANCY)

async function run(ds: DataSource): Promise<void> {
  const before = multiTenant() ? await recorded(ds) : []
  await ds.runMigrations({ transaction: 'each' })
  if (!multiTenant()) return
  if (!hardenAfterRun(before)) {
    console.warn(
      'tenancy-harden: skipped, this run has just added the tenant columns. Finish the upgrade with ' +
        'APP_MULTI_TENANT off and make sure every instance runs this version, then deploy again with it ' +
        'on (or run db:migrate once more, only after that)',
    )
    return
  }
  const done = await hardenTenancy(ds)
  if (done.length) console.log(`tenancy-harden: default dropped on ${done.join(' ')}`)
}

const commands = {
  run,
  revert: (ds: DataSource) => ds.undoLastMigration({ transaction: 'each' }),
  show: (ds: DataSource) => ds.showMigrations(),
}

async function main(command = process.argv[2] ?? 'run'): Promise<void> {
  assertProductionSecrets(process.env)
  if (!Object.hasOwn(commands, command)) throw new Error('usage: migrate.js [run|revert|show]')
  const ds = new DataSource({ ...dataSourceOptions(), logging: ['error', 'schema', 'migration'] })
  await ds.initialize()
  try {
    await commands[command as keyof typeof commands](ds)
  } finally {
    await ds.destroy()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
