import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 安全标记只定位到测试通道，不保存数据库凭据或 SQL。 */
export function migrationSafetyFile(env: NodeJS.ProcessEnv = process.env): string {
  if (!env.DB_NAME?.endsWith('_test')) throw new Error('migration safety requires a _test database')
  const channel = [env.DB_HOST ?? '127.0.0.1', env.DB_PORT ?? '3306', env.DB_NAME]
  const key = createHash('sha256').update(JSON.stringify(channel)).digest('hex')
  return join(tmpdir(), `qw-migration-unsafe-${key}`)
}

/** 读不到标记时拒绝访问测试库；只有确定不存在才表示没有历史污染。 */
export function migrationRunUnsafe(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    readFileSync(migrationSafetyFile(env))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new Error('cannot read migration safety marker; refusing test database access', {
      cause: error,
    })
  }
}

/** 必须先写标记再开始迁移：写失败时尚未改库，不能把未落盘的污染状态交给后续文件。 */
export function markMigrationRunUnsafe(env: NodeJS.ProcessEnv = process.env): void {
  writeFileSync(migrationSafetyFile(env), 'migration operation in progress\n', { mode: 0o600 })
}

/** 只在原用例已停止或完整重建成功后清除；失败则保留，下一次运行不能复用旧库。 */
export function clearMigrationRunUnsafe(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(migrationSafetyFile(env), { force: true })
}

/** worker 崩溃后 Vitest 仍可能派发下一个文件，必须在其 import/beforeAll 前拒绝。 */
export function assertMigrationRunSafe(env: NodeJS.ProcessEnv = process.env): void {
  if (migrationRunUnsafe(env))
    throw new Error(
      'test database may contain unfinished migrations; refusing this file; rerun tests to rebuild it',
    )
}

/** 恢复开始前保持不安全，只有恢复 Promise 成功才清理；恢复失败不能伪装成干净状态。 */
export async function recoverMigrationRun<T>(
  restore: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  markMigrationRunUnsafe(env)
  const result = await restore()
  clearMigrationRunUnsafe(env)
  return result
}
