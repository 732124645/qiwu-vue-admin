// Vitest globalSetup: resets the test database once per run (drop every table, migrate
// from source, drop the tenant columns' defaults, seed: restoreTestSchema), so every spec starts from the
// full schema and seed rows. E2e specs still reset the tables they write in beforeAll (resetDb), and
// db-migrations restores the same state after its round trip.
/// <reference types="vite/client" />
import './load-env.js'
import { DataSource, type MigrationInterface } from 'typeorm'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { restoreTestSchema } from './schema.js'

const migrations = Object.values(
  import.meta.glob<Record<string, new () => MigrationInterface>>('../../src/db/migrations/*.ts', {
    eager: true,
  }),
).flatMap((mod) => Object.values(mod))

export default async function setup(): Promise<void> {
  if (!process.env.DB_NAME?.endsWith('_test'))
    throw new Error(`globalSetup resets only *_test databases, got '${process.env.DB_NAME}'`)
  const ds = new DataSource({ ...dataSourceOptions(), migrations })
  await ds.initialize()
  try {
    await ds.dropDatabase()
    await restoreTestSchema(ds)
  } finally {
    await ds.destroy()
  }
}
