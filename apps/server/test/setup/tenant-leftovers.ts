// Vitest setupFiles (after load-env.ts): once a spec file's own afterAll hooks ran, the tenant tables hold
// what the seeds left, the default tenant alone (soft-deleted rows counted too) and no domains or
// packages: a file that left a tenant of its own behind (test/setup/tenants.ts) fails here, not the
// unrelated file that would trip over it later.
import { createConnection } from 'mysql2/promise'

// read now: a spec may change process.env while it runs
const db = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
}

afterAll(async () => {
  const conn = await createConnection(db)
  try {
    const [rows] = await conn.query(
      `SELECT 'iam_tenant' AS t, COUNT(*) AS n FROM iam_tenant WHERE id <> 1
       UNION ALL SELECT 'iam_tenant_domain', COUNT(*) FROM iam_tenant_domain
       UNION ALL SELECT 'iam_tenant_package', COUNT(*) FROM iam_tenant_package
       UNION ALL SELECT 'iam_tenant_package_menus', COUNT(*) FROM iam_tenant_package_menus
       UNION ALL SELECT 'default tenant missing', 1 - COUNT(*) FROM iam_tenant WHERE id = 1`,
    )
    const left = (rows as { t: string; n: number | string }[]).filter((r) => Number(r.n) !== 0)
    if (left.length)
      throw new Error(`tenant rows left behind: ${left.map((r) => `${r.t} ${r.n}`).join(', ')}`)
  } finally {
    await conn.end()
  }
})
