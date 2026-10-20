// Which test database / Redis db pairs a server test run may reset: the same rule as
// scripts/gen-check-golden.mjs (the default pair, plus the parallel lanes of the optional private
// lane file). A half-configured checkout (its own database, another run's Redis db) is refused before
// globalSetup drops anything or a spec flushes another run's sessions. A second run on the same pair is
// refused too (`holdTestRun`): its reset and its migration specs would change the schema under this one.
import type { DataSource, QueryRunner } from 'typeorm'

type Refusal = (env: Record<string, string | undefined>, pairs?: string[][]) => string | null

const SCRIPT = new URL('../../../../scripts/gen-check-golden.mjs', import.meta.url).href

/** 只允许登记过的测试库与 Redis 库组合；否则抛错并说明允许的组合与如何配置。 */
export async function assertTestChannel(
  env: Record<string, string | undefined>,
  pairs?: string[][],
): Promise<void> {
  const { refusal } = (await import(SCRIPT)) as { refusal: Refusal }
  const why = refusal(env, pairs)
  if (why)
    throw new Error(
      `server tests ${why}. Point DB_NAME / REDIS_DB at one registered pair (apps/server/.env.test, or a lane's apps/server/.env.test.local)`,
    )
}

/**
 * 整个测试运行期间占住本测试库的 MySQL 命名锁（专用连接，关掉连接即释放）：另一份检出或另一次运行
 * 指向同一库时直接拒绝，而不是在本次运行中途重建库、回退迁移，让别的用例看到被改过的表结构。
 * 返回释放锁的函数。
 */
export async function holdTestRun(
  ds: DataSource,
  db = process.env.DB_NAME ?? '',
): Promise<() => Promise<void>> {
  const name = `qw:test-run:${db}`
  const runner: QueryRunner = ds.createQueryRunner()
  await runner.connect()
  const [{ held }] = (await runner.query('SELECT GET_LOCK(?, 0) AS held', [name])) as {
    held: number | null
  }[]
  if (Number(held) !== 1) {
    await runner.release()
    throw new Error(
      `server tests: another run is using the database '${db}' (its lock is held); wait for it, or give this checkout its own pair in apps/server/.env.test.local`,
    )
  }
  // 连接回到连接池时锁仍在它身上：先显式释放。长时间运行后 MySQL 可能已断开这条空闲连接（锁随之
  // 释放），此时释放失败不算本次运行失败：命名锁只属于连接，连接没了锁也就不在了
  return async () => {
    try {
      await runner.query('DO RELEASE_LOCK(?)', [name])
    } catch {
      // 连接已断开，锁已由服务器释放
    }
    await runner.release().catch(() => undefined)
  }
}
