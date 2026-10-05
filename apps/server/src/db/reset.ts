// `node dist/db/reset.js` (server script `db:reset`, cwd apps/server, env like db:migrate): drops every
// table of DB_NAME, runs the compiled migrations and the seeds. Only for local dev/test/e2e
// databases.
import { DataSource } from 'typeorm'
import { dataSourceOptions } from './data-source.js'
import { runSeeds } from './seeds/index.js'

async function main(): Promise<void> {
  const { NODE_ENV = 'development', DB_NAME = '' } = process.env
  if (NODE_ENV === 'production' || !/_(dev|test|e2e)$/.test(DB_NAME))
    throw new Error(
      `db:reset refused: needs NODE_ENV != production and a DB_NAME ending in _dev/_test/_e2e (got ${NODE_ENV}, '${DB_NAME}')`,
    )
  const ds = new DataSource({ ...dataSourceOptions(), logging: ['error', 'schema', 'migration'] })
  await ds.initialize()
  try {
    await ds.dropDatabase() // every table and view of DB_NAME; the database itself stays
    await ds.runMigrations({ transaction: 'each' })
    for (const notice of await runSeeds(ds)) console.log(notice)
  } finally {
    await ds.destroy()
  }
  console.log(`db:reset: ${DB_NAME} dropped, migrated and seeded`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
