// Playwright with multi-tenancy on (`pnpm --filter @qiwu/web e2e:tenant`): the specs of e2e-tenant/ only,
// against the built server on the tenant channel (e2e/env.ts TENANT_CHANNEL: qiwu_tenant_e2e, Redis db 1,
// ports 3203 / 4176; a git-ignored apps/server/.env.e2e-tenant.local overrides them). The default
// configuration never runs these specs (its testDir is e2e/).
import { e2eServerEnv } from './e2e/env.ts'
import { e2eConfig } from './playwright.config.ts'

export default e2eConfig(
  e2eServerEnv(undefined, true),
  './e2e-tenant',
  './e2e-tenant/global-setup.ts',
)
