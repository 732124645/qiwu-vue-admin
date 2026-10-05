import mysql, { type PoolOptions } from 'mysql2'
import type { DataSourceOptions } from 'typeorm'
import { AuditSubscriber } from '../core/db/audit.subscriber.js'
import { migrationsGlob } from '../core/paths.js'

/**
 * mysql2 with every pooled connection pinned to `time_zone = '+00:00'`. `timezone: 'Z'` only makes
 * mysql2 read/write JS Dates as UTC; `CURRENT_TIMESTAMP(3)` defaults and `ON UPDATE` use the session
 * time zone, which is the server's (e.g. `SYSTEM` = CST on a dev Mac). The pool emits `connection`
 * before handing a new connection out, so the SET runs before any other query on it.
 */
const utcMysql = {
  ...mysql,
  createPool(options: PoolOptions) {
    const pool = mysql.createPool(options)
    pool.on('connection', (conn) => {
      conn.query("SET time_zone = '+00:00'", (err) => err && conn.destroy())
    })
    return pool
  },
}

/**
 * The single MySQL DataSource config (see docs/adr/002-orm.md), read from env at call time: Nest (`CoreDbModule`), the
 * `db:*` scripts and tests all build from it. Schema changes only ever come from migrations.
 * Migrations are the compiled `dist/db/migrations/*.js` (`core/paths.ts`).
 */
export function dataSourceOptions(
  env: NodeJS.ProcessEnv = process.env,
): Extract<DataSourceOptions, { type: 'mysql' | 'mariadb' }> {
  return {
    type: 'mysql',
    driver: utcMysql,
    host: env.DB_HOST ?? '127.0.0.1',
    port: Number(env.DB_PORT ?? 3306),
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    synchronize: false,
    migrationsTableName: 'meta_migrations',
    migrations: [migrationsGlob()],
    subscribers: [AuditSubscriber],
  }
}
