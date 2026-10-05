// `node dist/db/seed.js [--only iam,settings]` (server script `db:seed`, cwd apps/server, env like
// db:migrate): idempotent upserts by natural key. `pnpm db:seed -- --only iam` from the root.
import { parseArgs } from 'node:util'
import { DataSource } from 'typeorm'
import { assertProductionSecrets } from '../core/config/production-secrets.js'
import { dataSourceOptions } from './data-source.js'
import { runSeeds } from './seeds/index.js'

async function main(): Promise<void> {
  assertProductionSecrets(process.env)
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'), // pnpm may forward the separator
    options: { only: { type: 'string' } },
  })
  const ds = new DataSource(dataSourceOptions())
  await ds.initialize()
  try {
    for (const notice of await runSeeds(ds, values.only?.split(','))) console.log(notice)
  } finally {
    await ds.destroy()
  }
  console.log(`db:seed: ${process.env.DB_NAME} seeded`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
