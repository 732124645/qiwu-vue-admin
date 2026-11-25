// Vitest globalSetup: refuses an unregistered DB_NAME / REDIS_DB pair or a database another run holds
// (test-channel.ts; the lock stays held until teardown), then resets the test database once per run
// (drop every table, migrate from source, drop the tenant columns' defaults, seed: restoreTestSchema),
// so every spec starts from the full schema and seed rows. E2e specs still reset the tables they write
// in beforeAll (resetDb), and db-migrations restores the same state after its round trip.
// Local fast mode (QW_TEST_REUSE_DB=1; ci:local drops it, CI ignores it; see docs/getting-started.md): when the
// fingerprint recorded in the database matches the current migrations, seeds and schema switches, the
// drop is skipped; pending migrations, hardening and the idempotent seeds still run.
import './load-env.js'
import { DataSource } from 'typeorm'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { SOURCE_MIGRATIONS } from './migrations.js'
import { restoreTestSchema, schemaFingerprint, storedFingerprint } from './schema.js'
import { assertTestChannel, holdTestRun } from './test-channel.js'
import { migrationRunUnsafe, recoverMigrationRun } from './migration-run-safety.js'

export default async function setup(): Promise<() => Promise<void>> {
  if (!process.env.DB_NAME?.endsWith('_test'))
    throw new Error(`globalSetup resets only *_test databases, got '${process.env.DB_NAME}'`)
  // a registered database / Redis pair only: a half-configured checkout must not reset another run's
  await assertTestChannel(process.env)
  // the run lock lives on its own connection until teardown (the reset below drops the database, not it)
  const lockDs = await new DataSource(dataSourceOptions()).initialize()
  let release: (() => Promise<void>) | undefined
  try {
    release = await holdTestRun(lockDs)
    const ds = new DataSource({ ...dataSourceOptions(), migrations: SOURCE_MIGRATIONS })
    await ds.initialize()
    try {
      const reuse =
        !migrationRunUnsafe() &&
        process.env.QW_TEST_REUSE_DB === '1' &&
        !process.env.CI &&
        (await storedFingerprint(ds)) === schemaFingerprint()
      await recoverMigrationRun(async () => {
        if (reuse) console.log(`globalSetup: QW_TEST_REUSE_DB=1, reusing ${process.env.DB_NAME}`)
        else await ds.dropDatabase()
        await restoreTestSchema(ds)
      })
    } finally {
      await ds.destroy()
    }
  } catch (err) {
    await release?.()
    await lockDs.destroy()
    throw err
  }
  return async () => {
    await release!()
    await lockDs.destroy()
  }
}
