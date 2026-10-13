// Runs after the web servers are up (the server command already reset the tenant channel's DB_NAME, as the
// default channel's): adds tenant B (env.ts TENANT_B) through the compiled seed helpers, as opening a tenant
// would (a package opening every menu open to tenants, its row, the tenant seeds, then its owner holding
// `tenant_admin` alone in its root dept, with the first sign-in forced to change the password), and drops
// the previous run's `qw:*` keys from the channel's REDIS_DB, in a child process with the server's env and
// cwd.
import { spawnSync } from 'node:child_process'
import type { FullConfig } from '@playwright/test'
import { e2eServerEnv, serverDir, TENANT_B } from '../e2e/env.ts'

const SCRIPT = `
import { createClient } from 'redis'
import { DataSource } from 'typeorm'
import { TENANT_ADMIN_ROLE } from './dist/core/auth/principal.js'
import { withTenant } from './dist/core/context/tenant.js'
import { keyPattern } from './dist/core/redis/cache-namespaces.js'
import { dataSourceOptions } from './dist/db/data-source.js'
import { seedLimitedUser } from './dist/db/seeds/iam/iam.seed.js'
import { runTenantSeeds } from './dist/db/seeds/index.js'
import { findId, insertRow } from './dist/db/seeds/upsert.js'
const { code, name, admin } = JSON.parse(process.env.E2E_TENANT)
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
  await ds.transaction(async (q) => {
    // its package: every menu open to tenants (a tenant without one may use nothing)
    const { insertId: pkg } = await q.query('INSERT INTO iam_tenant_package (name) VALUES (?)', [
      code + '-package',
    ])
    await q.query(
      'INSERT INTO iam_tenant_package_menus (package_id, menu_id) ' +
        'SELECT ?, id FROM iam_menu WHERE platform_only = 0 AND deleted_at IS NULL',
      [pkg],
    )
    const { insertId } = await q.query(
      'INSERT INTO iam_tenant (code, name, package_id) VALUES (?, ?, ?)',
      [code, name, pkg],
    )
    const tid = Number(insertId)
    await runTenantSeeds(q, tid)
    await withTenant(tid, async () => {
      const userId = await seedLimitedUser(q, admin.username, admin.password)
      await q.query('UPDATE iam_user SET dept_id = ?, password_changed_at = NULL WHERE id = ?', [
        await findId(q, 'iam_dept', { parent_id: 0 }), userId,
      ])
      // the builtin tenant_admin role alone, instead of demo
      await q.query('DELETE FROM iam_user_roles WHERE user_id = ?', [userId])
      await insertRow(q, 'iam_user_roles', {
        user_id: userId,
        role_id: await findId(q, 'iam_role', { code: TENANT_ADMIN_ROLE, is_builtin: 1 }),
      })
      await q.query('UPDATE iam_tenant SET owner_user_id = ? WHERE id = ?', [userId, tid])
      // a provisioned tenant has no demo role: drop the one seedLimitedUser added to B, and its grants
      await q.query(
        'DELETE rm FROM iam_role_menus rm JOIN iam_role r ON r.id = rm.role_id ' +
          "WHERE rm.tenant_id = ? AND r.tenant_id = ? AND r.code = 'demo'",
        [tid, tid],
      )
      await q.query("DELETE FROM iam_role WHERE tenant_id = ? AND code = 'demo'", [tid])
    })
  })
} finally {
  await ds.destroy()
}
const { REDIS_HOST, REDIS_PORT, REDIS_USERNAME, REDIS_PASSWORD, REDIS_DB } = process.env
const redis = createClient({
  socket: { host: REDIS_HOST, port: Number(REDIS_PORT) },
  username: REDIS_USERNAME,
  password: REDIS_PASSWORD,
  database: Number(REDIS_DB),
})
await redis.connect()
try {
  // the ACL user may not FLUSHDB/KEYS: SCAN + UNLINK
  for await (const keys of redis.scanIterator({ MATCH: keyPattern(), COUNT: 500 }))
    if (keys.length) await redis.unlink(keys)
} finally {
  await redis.close()
}
`

export default function globalSetup(config: FullConfig) {
  const channel = config.projects[0]?.use.channel
  console.log(`playwright browser: ${channel ? `channel ${channel}` : 'bundled chromium'}`)
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    cwd: serverDir,
    env: { ...process.env, ...e2eServerEnv(serverDir, true), E2E_TENANT: JSON.stringify(TENANT_B) },
    encoding: 'utf8',
  })
  if (r.status !== 0)
    throw new Error(`e2e tenant seeding failed (${r.status ?? r.signal}):\n${r.stderr}`)
}
