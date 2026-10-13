// The test database's full state: every migration, the tenant columns without their defaults (so a test
// insert that leaves out `tenant_id` fails with 1364, as on a hardened production database) and the seed
// rows. globalSetup builds it; a spec that reverted migrations puts it back the same way in its finally.
import type { DataSource, Migration } from 'typeorm'
import { runSeeds } from '../../src/db/seeds/index.js'
import { hardenTenancy } from '../../src/db/tenancy-harden.js'

/** Runs `ds`'s pending migrations, hardens, seeds; returns the migrations it ran. */
export async function restoreTestSchema(ds: DataSource): Promise<Migration[]> {
  const ran = await ds.runMigrations({ transaction: 'each' })
  await hardenTenancy(ds)
  await runSeeds(ds)
  return ran
}
