import mysql, { type PoolOptions } from 'mysql2'
import type { DataSourceOptions } from 'typeorm'
import { z } from 'zod'
import { DbPoolEnvShape } from '../core/config/env.schema.js'
import { withAcquireTimeout } from '../core/db/pool-acquire.js'
import { AuditSubscriber } from '../core/db/audit.subscriber.js'
import { installTenantFilter } from '../core/db/tenant-filter.js'
import { TenantSubscriber } from '../core/db/tenant.subscriber.js'
import { migrationsGlob } from '../core/paths.js'

// every DataSource of the process gets the tenant condition (see docs/design-notes.md#tenancy)
installTenantFilter()

/**
 * mysql2 with every pooled connection pinned to `time_zone = '+00:00'`. `timezone: 'Z'` only makes
 * mysql2 read/write JS Dates as UTC; `CURRENT_TIMESTAMP(3)` defaults and `ON UPDATE` use the session
 * time zone, which is the server's (e.g. `SYSTEM` = CST on a dev Mac). The pool emits `connection`
 * before handing a new connection out, so the SET runs before any other query on it. A positive
 * `acquireTimeoutMs` bounds the wait for a free connection (`core/db/pool-acquire.ts`).
 */
const utcMysql = (acquireTimeoutMs: number) => ({
  ...mysql,
  createPool(options: PoolOptions) {
    const pool = mysql.createPool(options)
    pool.on('connection', (conn) => {
      conn.query("SET time_zone = '+00:00'", (err) => err && conn.destroy())
    })
    return withAcquireTimeout(pool, acquireTimeoutMs)
  },
})

const DbPoolEnv = z.object(DbPoolEnvShape)

/** 读取连接池配置；`KEY=`（空值）按未设置处理，与 EnvSchema 一致，非法值直接报错。 */
export function dbPoolEnv(env: NodeJS.ProcessEnv = process.env): z.output<typeof DbPoolEnv> {
  return DbPoolEnv.parse(
    Object.fromEntries(
      Object.keys(DbPoolEnvShape).map((k) => [k, env[k] === '' ? undefined : env[k]]),
    ),
  )
}

/**
 * The single MySQL DataSource config (see docs/adr/002-orm.md), read from env at call time: Nest (`CoreDbModule`), the
 * `db:*` scripts and tests all build from it. Schema changes only ever come from migrations.
 * Migrations are the compiled `dist/db/migrations/*.js` (`core/paths.ts`).
 */
export function dataSourceOptions(
  env: NodeJS.ProcessEnv = process.env,
): Extract<DataSourceOptions, { type: 'mysql' | 'mariadb' }> {
  const pool = dbPoolEnv(env)
  return {
    type: 'mysql',
    driver: utcMysql(pool.DB_POOL_ACQUIRE_TIMEOUT_MS),
    poolSize: pool.DB_POOL_SIZE,
    extra: { queueLimit: pool.DB_POOL_QUEUE_LIMIT },
    host: env.DB_HOST ?? '127.0.0.1',
    port: Number(env.DB_PORT ?? 3306),
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    timezone: 'Z',
    // a DATE is a calendar day, not an instant: as its 'YYYY-MM-DD' text (as a JS Date at UTC midnight
    // TypeORM would read it back with local getters, a day early where the process runs west of UTC)
    dateStrings: ['DATE'],
    supportBigNumbers: true,
    bigNumberStrings: false,
    synchronize: false,
    migrationsTableName: 'meta_migrations',
    migrations: [migrationsGlob()],
    subscribers: [AuditSubscriber, TenantSubscriber],
  }
}
