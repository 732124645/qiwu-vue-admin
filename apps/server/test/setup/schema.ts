// The test database's full state: every migration, the tenant columns without their defaults (so a test
// insert that leaves out `tenant_id` fails with 1364, as on a hardened production database) and the seed
// rows. globalSetup builds it; a spec that reverted migrations puts it back the same way in its finally.
// Each time it is reached, the fingerprint of the sources that shape it is recorded in the database, so
// the local fast mode (QW_TEST_REUSE_DB=1, see docs/getting-started.md) can tell whether the schema
// still matches without rebuilding it.
import { createHash } from 'node:crypto'
import { globSync, readFileSync } from 'node:fs'
import type { DataSource, Migration } from 'typeorm'
import { runSeeds } from '../../src/db/seeds/index.js'
import { hardenTenancy } from '../../src/db/tenancy-harden.js'

const FINGERPRINT_TABLE = 'test_schema_fingerprint'
/** 改变测试库结构或种子内容的环境开关。 */
const SCHEMA_SWITCHES = ['APP_MULTI_TENANT', 'APP_WXOA', 'APP_MCP', 'APP_DEMO_MODE']
const SERVER_DIR = new URL('../../', import.meta.url)

/** Runs `ds`'s pending migrations, hardens, seeds; returns the migrations it ran. */
export async function restoreTestSchema(ds: DataSource): Promise<Migration[]> {
  const ran = await ds.runMigrations({ transaction: 'each' })
  await hardenTenancy(ds)
  await runSeeds(ds)
  await recordFingerprint(ds)
  return ran
}

/**
 * 测试库结构的指纹：迁移、种子（db/seeds 与各模块的 *.seed.ts）、本文件与加固脚本的内容，加上改变结构
 * 或种子的环境开关。任何一项变化都让快速模式重建测试库。
 */
export function schemaFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  const hash = createHash('sha256')
  const files = globSync(
    [
      'src/db/migrations/*.ts',
      'src/db/seeds/**/*.ts',
      'src/**/*.seed.ts',
      'src/db/tenancy-harden.ts',
      'test/setup/schema.ts',
    ],
    { cwd: SERVER_DIR },
  )
  for (const file of [...new Set(files.map((f) => f.split('\\').join('/')))].sort())
    hash
      .update(`${file}\0`)
      .update(readFileSync(new URL(file, SERVER_DIR)))
      .update('\0')
  for (const key of SCHEMA_SWITCHES) hash.update(`${key}=${env[key] ?? ''}\0`)
  return hash.digest('hex')
}

/** 库里记录的指纹；表不存在（新库、刚被删库重建）时返回 null。 */
export async function storedFingerprint(ds: DataSource): Promise<string | null> {
  const [table] = await ds.query(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
    [FINGERPRINT_TABLE],
  )
  if (!table) return null
  const [row] = await ds.query(`SELECT fingerprint FROM ${FINGERPRINT_TABLE} LIMIT 1`)
  return (row as { fingerprint?: string } | undefined)?.fingerprint ?? null
}

/** 记下当前源码的指纹：只在库刚到达完整状态时调用（restoreTestSchema 的末尾）。 */
async function recordFingerprint(ds: DataSource): Promise<void> {
  await ds.query(
    `CREATE TABLE IF NOT EXISTS ${FINGERPRINT_TABLE} (fingerprint char(64) NOT NULL COMMENT 'schema fingerprint') COMMENT 'fast mode schema fingerprint (test databases only)'`,
  )
  await ds.query(`DELETE FROM ${FINGERPRINT_TABLE}`)
  await ds.query(`INSERT INTO ${FINGERPRINT_TABLE} (fingerprint) VALUES (?)`, [schemaFingerprint()])
}
