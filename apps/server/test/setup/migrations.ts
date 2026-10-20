// What the migration specs know about the migrations, read from src/db/migrations instead of a hand-kept
// list, so a project that adds its own migrations and tables edits no template spec: the migration
// classes in run order and the tables their `CREATE TABLE` statements name. Plus the runner of the
// compiled `dist/db/*.js` scripts with a configurable timeout that fails loudly when it kills one.
/// <reference types="vite/client" />
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import type { MigrationInterface } from 'typeorm'

type Migration = new () => MigrationInterface

/** 迁移名（TypeORM 记入 meta_migrations 的名字）：类上的 `name`，没有时取类名。 */
export const migrationName = (M: Migration): string => new M().name ?? M.name

/** 迁移名末尾的 14 位时间戳；没有时直接报错，免得它悄悄排到别处。 */
const stamp = (name: string): string => {
  const at = /(\d{14})$/.exec(name)
  if (!at) throw new Error(`migration without a 14-digit timestamp: ${name}`)
  return at[1]
}

/** 源码里的全部迁移类，按时间戳排序，时间戳相同再按完整名字排序（与运行顺序一致，结果稳定）。 */
export const SOURCE_MIGRATIONS: Migration[] = Object.values(
  import.meta.glob<Record<string, Migration>>('../../src/db/migrations/*.ts', { eager: true }),
)
  .flatMap((mod) => Object.values(mod))
  .map((M) => ({ M, name: migrationName(M) }))
  .sort((a, b) => stamp(a.name).localeCompare(stamp(b.name)) || (a.name < b.name ? -1 : 1))
  .map(({ M }) => M)

/** 按运行顺序排列的迁移名。 */
export const MIGRATION_NAMES: string[] = SOURCE_MIGRATIONS.map(migrationName)

const MIGRATIONS_DIR = new URL('../../src/db/migrations/', import.meta.url)

/**
 * 迁移源码里 `CREATE TABLE` 点名的表（注释行不算），与 `pnpm arch:check` 的 tenant-sql 检查同一个来源。
 * 文本扫描看不到拼出来的表名：迁移往返用例在重置后核对库里的表一张不多，漏掉的表在那里失败。
 */
export const MIGRATION_TABLES: string[] = [
  ...new Set(
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) =>
        readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
          .flatMap((line) => [
            ...line.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?`?([a-z][a-z0-9_]*)/g),
          ])
          .map((m) => m[1]),
      ),
  ),
].sort()

/** 每个 dist 脚本最多运行多久（毫秒）：慢机器或容器里的 MySQL 用 QW_TEST_SCRIPT_TIMEOUT_MS 放宽。 */
export const SCRIPT_TIMEOUT_MS = Number(process.env.QW_TEST_SCRIPT_TIMEOUT_MS) || 300_000

/** 本文件里被超时杀掉的脚本（空串表示没有）：之后库可能停在半途，不能再接着做后续步骤。 */
export const killed = { script: '' }

/**
 * 运行 `node <script> …`（cwd apps/server）。子进程被超时杀掉（status 为 null 或带 signal）时立即抛错并
 * 写明超时，同时记进 `killed`：被杀的迁移可能只做了一半，后续步骤在这样的库上只会报出不相干的错误。
 */
export function runScript(
  script: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: SCRIPT_TIMEOUT_MS,
  })
  if (r.status === null || r.signal) {
    killed.script = script
    throw new Error(
      `script ${script} killed after ${SCRIPT_TIMEOUT_MS} ms (timeout${r.signal ? `, ${r.signal}` : ''}); raise QW_TEST_SCRIPT_TIMEOUT_MS on a slow database`,
    )
  }
  return r
}
