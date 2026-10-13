// `node dist/db/tenant-disable.js <code…>` (cwd apps/server, env like db:migrate: `node
// --env-file-if-exists=.env.local --env-file-if-exists=.env dist/db/tenant-disable.js <code…>`): disables
// tenants while multi-tenancy is off (see docs/design-notes.md#tenancy). Idempotent; it only changes their
// rows. With multi-tenancy on, tenants are disabled on the tenant management page, which also ends
// their sessions.
import { DataSource } from 'typeorm'
import { multiTenant } from '../core/config/multi-tenant.js'
import { assertProductionSecrets } from '../core/config/production-secrets.js'
import { dataSourceOptions } from './data-source.js'

/**
 * Sets `enabled = 0` on the tenants with these codes (case-insensitive). Throws, changing no row, when
 * multi-tenancy is on, no code is given, or a code is the default tenant's or unknown.
 */
export async function disableTenants(
  ds: DataSource,
  codes: readonly string[],
  multiTenantOn: boolean,
): Promise<string[]> {
  if (multiTenantOn)
    throw new Error(
      'tenant-disable: multi-tenancy is on; disable tenants on the tenant management page instead',
    )
  const wanted = [...new Set(codes.map((c) => c.trim().toLowerCase()).filter(Boolean))]
  if (!wanted.length) throw new Error('usage: tenant-disable.js <tenant code…>')
  const found = new Set(
    (
      await ds.query<{ code: string }[]>(
        'SELECT code FROM iam_tenant WHERE code IN (?) AND id <> 1 AND deleted_at IS NULL',
        [wanted],
      )
    ).map((r) => r.code),
  )
  const refused = wanted.filter((c) => !found.has(c))
  if (refused.length)
    throw new Error(
      `tenant-disable: not a tenant other than the default one: ${refused.join(' ')}; nothing changed`,
    )
  await ds.query(
    'UPDATE iam_tenant SET enabled = 0 WHERE code IN (?) AND id <> 1 AND deleted_at IS NULL',
    [wanted],
  )
  return wanted
}

async function main(): Promise<void> {
  assertProductionSecrets(process.env)
  const ds = new DataSource(dataSourceOptions())
  await ds.initialize()
  try {
    const done = await disableTenants(ds, process.argv.slice(2), multiTenant())
    console.log(`tenant-disable: ${done.join(' ')} disabled`)
  } finally {
    await ds.destroy()
  }
}

// runs as the command only: specs import the function
if (process.argv[1]?.endsWith('tenant-disable.js'))
  main().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
