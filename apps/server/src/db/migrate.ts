// `node dist/db/migrate.js [run|revert|show]` (cwd apps/server; server script `db:migrate`, env from
// `.env.local` + `.env`, shell env wins). Runs the compiled migrations in dist/db/migrations.
import { DataSource } from 'typeorm'
import { assertProductionSecrets } from '../core/config/production-secrets.js'
import { dataSourceOptions } from './data-source.js'

const commands = {
  run: (ds: DataSource) => ds.runMigrations({ transaction: 'each' }),
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
