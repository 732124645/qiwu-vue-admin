import type { MigrationInterface, QueryRunner } from 'typeorm'

/** Adds the tenant column to restored Official Account tables after the published tenant migration. */
export class WxoaTenant20261018100000 implements MigrationInterface {
  name = 'WxoaTenant20261018100000'

  async up(q: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      if (!(await hasColumn(q, table, 'tenant_id')))
        await q.query(
          // arch-allow: sql-concat wxoa table constants; tenant: current tenant augmentation migration
          `ALTER TABLE ${table} ADD COLUMN tenant_id bigint unsigned NOT NULL DEFAULT 1 COMMENT '租户 ID', ALGORITHM=INSTANT`,
        )
      if (!(await hasIndex(q, table, `idx_${table}_tenant`)))
        await q.query(
          // arch-allow: sql-concat wxoa table and index constants; tenant: current tenant augmentation migration
          `ALTER TABLE ${table} ADD KEY idx_${table}_tenant (tenant_id), ALGORITHM=INPLACE, LOCK=NONE`,
        )
    }
  }

  /**
   * 回退前先拒绝：任一表里还有默认租户以外的行时，去掉 tenant_id 会把各租户的数据混在一起（与 Tenancy 的
   * 回退同样拒绝，什么都不改）。
   */
  async down(q: QueryRunner): Promise<void> {
    for (const table of TABLES)
      if (await hasColumn(q, table, 'tenant_id')) {
        const rows = await q.query(
          // arch-allow: sql-concat wxoa table constants; qw:cross-tenant the refusal looks at every tenant's rows
          `SELECT 1 FROM ${table} WHERE tenant_id <> 1 LIMIT 1`,
        )
        if (rows.length)
          throw new Error(
            `WxoaTenant down refused: ${table} holds rows of tenants besides the default one, they would merge`,
          )
      }
    for (const table of [...TABLES].reverse()) {
      if (await hasIndex(q, table, `idx_${table}_tenant`))
        // arch-allow: sql-concat wxoa table and index constants; tenant: current tenant augmentation migration
        await q.query(`ALTER TABLE ${table} DROP INDEX idx_${table}_tenant`)
      if (await hasColumn(q, table, 'tenant_id'))
        // arch-allow: sql-concat wxoa table constants; tenant: current tenant augmentation migration
        await q.query(`ALTER TABLE ${table} DROP COLUMN tenant_id`)
    }
  }
}

const TABLES = [
  'wxoa_account',
  'wxoa_fan',
  'wxoa_tag',
  'wxoa_message',
  'wxoa_reply_rule',
  'wxoa_menu',
  'wxoa_material',
  'wxoa_qrcode',
] as const

async function hasColumn(q: QueryRunner, table: string, column: string): Promise<boolean> {
  const rows = await q.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function hasIndex(q: QueryRunner, table: string, key: string): Promise<boolean> {
  const rows = await q.query(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, key],
  )
  return rows.length > 0
}
