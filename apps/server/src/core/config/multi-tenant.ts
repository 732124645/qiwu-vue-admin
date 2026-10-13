import { z } from 'zod'

/**
 * `APP_MULTI_TENANT` for the seeds and the command line, parsed like EnvSchema; unset or invalid means
 * off. The server itself reads it from the config.
 */
export const multiTenant = () =>
  z.stringbool().safeParse(process.env.APP_MULTI_TENANT).data === true

/**
 * Startup check (see docs/design-notes.md#tenancy): a production start with multi-tenancy on is refused
 * while a tenant column still has its default (`defaults` lists them): an insert that leaves out
 * `tenant_id` would land in the default tenant instead of failing. Off, or outside production, it
 * passes without asking.
 */
export async function assertTenancyAllowed(
  env: { NODE_ENV?: string; APP_MULTI_TENANT?: boolean },
  defaults: () => Promise<string[]>,
): Promise<void> {
  if (env.NODE_ENV !== 'production' || !env.APP_MULTI_TENANT) return
  const left = await defaults()
  if (left.length)
    throw new Error(
      `APP_MULTI_TENANT: tenant columns still have a default (${left.join(' ')}); run db:migrate ` +
        '(with multi-tenancy on it drops them after migrating) or node dist/db/tenancy-harden.js first',
    )
}
