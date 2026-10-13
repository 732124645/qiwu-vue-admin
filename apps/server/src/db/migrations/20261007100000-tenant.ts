import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Multi-tenancy, data layer (see docs/design-notes.md#tenancy): one database, every row of a tenant table
 * carries `tenant_id`.
 * - Platform tables: `iam_tenant` (with the default tenant 1, `default`, which owns every existing row),
 *   `iam_tenant_domain` (the host names bound to a tenant), `iam_tenant_package` and its menus;
 *   `iam_menu.platform_only`; a plain nullable `tenant_id` on `aud_http_trace` / `aud_http_fault`, only to
 *   filter by tenant in the platform's views.
 * - Every tenant table (`TENANT_TABLES`) gets `tenant_id ... DEFAULT 1` as its last column (nullable on
 *   `aud_signin_log`: an attempt for an unknown tenant code), `aud_action_log` also `actor_tenant_id`.
 *   The default stays: old code keeps working while it is deployed and after a rollback. Each table that
 *   is no join table gets an index led by `tenant_id` (a per-tenant unique key, else
 *   `idx_<table>_tenant`); the per-tenant unique keys become `(tenant_id, …, alive)`.
 * MySQL DDL commits implicitly, so a failed up is not rolled back: every step looks at
 * information_schema first and a rerun finishes the rest. Columns are added `ALGORITHM=INSTANT`, keys
 * `ALGORITHM=INPLACE, LOCK=NONE` (MySQL refuses instead of copying the table), and an ALTER waits at most
 * a few seconds for a busy table's metadata lock, a few times, then fails: run again off-peak.
 * down refuses once a second tenant exists (their rows would merge into one).
 */
export class Tenancy20261007100000 implements MigrationInterface {
  name = 'Tenancy20261007100000'
  /** How long an ALTER waits for a metadata lock (seconds), how many times it tries, the pause between. */
  lockWait = { seconds: 5, attempts: 3, pauseMs: 3000 }

  async up(q: QueryRunner): Promise<void> {
    await this.withLockWait(q, async (alter) => {
      // arch-allow: sql-concat this file's CREATE TABLE constants; tenant: a migration runs once over every tenant's rows
      for (const ddl of NEW_TABLES) await q.query(ddl)
      await q.query(`INSERT INTO iam_tenant (id, code, name)
        SELECT 1, 'default', 'seed.tenant.default' FROM DUAL
        WHERE NOT EXISTS (SELECT 1 FROM iam_tenant WHERE id = 1)`)
      for (const [table, column, ddl] of COLUMNS)
        if (!(await hasColumn(q, table, column)))
          // arch-allow: sql-concat table/column identifiers and definitions are this file's constants; tenant: a migration runs once over every tenant's rows
          await alter(`ALTER TABLE ${table} ADD COLUMN ${ddl}, ALGORITHM=INSTANT`)
      for (const table of INDEXED)
        if ((await keyColumns(q, table, `idx_${table}_tenant`)) === null)
          await alter(
            // arch-allow: sql-concat table/key identifiers are this file's constants; tenant: a migration runs once over every tenant's rows
            `ALTER TABLE ${table} ADD KEY idx_${table}_tenant (tenant_id), ${ONLINE}`,
          )
      for (const [table, key, columns] of PER_TENANT_KEYS)
        await rebuildKey(q, alter, table, key, `tenant_id,${columns}`)
    })
  }

  async down(q: QueryRunner): Promise<void> {
    if (await hasTable(q, 'iam_tenant')) {
      const [{ n }] = await q.query('SELECT COUNT(*) AS n FROM iam_tenant WHERE id <> 1')
      if (Number(n) > 0)
        throw new Error(
          'Tenancy down refused: iam_tenant holds tenants besides the default one, their rows would merge',
        )
    }
    await this.withLockWait(q, async (alter) => {
      for (const [table, key, columns] of PER_TENANT_KEYS)
        await rebuildKey(q, alter, table, key, columns)
      // a dropped column leaves every index it was in; idx_<table>_tenant goes with it
      for (const [table, column] of COLUMNS)
        if (await hasColumn(q, table, column))
          // arch-allow: sql-concat table/column identifiers are this file's constants; tenant: a migration runs once over every tenant's rows
          await alter(`ALTER TABLE ${table} DROP COLUMN ${column}`)
      await q.query(
        'DROP TABLE IF EXISTS iam_tenant_package_menus, iam_tenant_package, iam_tenant_domain, iam_tenant',
      )
    })
  }

  /**
   * Runs `body` with this session's metadata lock wait bounded (restored afterwards); `alter` retries a
   * statement that timed out waiting for it.
   */
  private async withLockWait(
    q: QueryRunner,
    body: (alter: (sql: string) => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const { seconds, attempts, pauseMs } = this.lockWait
    const alter = async (sql: string) => {
      for (let attempt = 1; ; attempt++) {
        try {
          // arch-allow: sql-concat DDL assembled from this file's constants; tenant: a migration runs once over every tenant's rows
          await q.query(sql)
          return
        } catch (err) {
          const code = (err as { driverError?: { code?: string } }).driverError?.code
          if (code !== 'ER_LOCK_WAIT_TIMEOUT' || attempt >= attempts) throw err
          await new Promise((resolve) => setTimeout(resolve, pauseMs))
        }
      }
    }
    await q.query('SET SESSION lock_wait_timeout = ?', [seconds])
    try {
      await body(alter)
    } finally {
      await q.query('SET SESSION lock_wait_timeout = DEFAULT')
    }
  }
}

const ONLINE = 'ALGORITHM=INPLACE, LOCK=NONE'

/** Tables whose rows belong to a tenant: every table but the platform ones (core/db/tenant-tables.ts). */
const TENANT_TABLES = [
  'iam_user',
  'iam_role',
  'iam_dept',
  'iam_position',
  'iam_user_social',
  'iam_user_roles',
  'iam_role_menus',
  'iam_role_depts',
  'iam_user_positions',
  'iam_user_pref',
  'msg_bulletin',
  'msg_bulletin_receipt',
  'msg_inbox',
  'msg_mail_record',
  'msg_sms_record',
  'msg_sms_otp',
  'aud_signin_log',
  'aud_action_log',
  'fs_object',
  'oauth_consent',
  'wf_form',
  'wf_model',
  'wf_version',
  'wf_instance',
  'wf_task',
  'wf_cc',
  'wf_event',
  'biz_leave_request',
  'demo_book',
  'demo_topic',
  'demo_invoice',
  'demo_invoice_line',
]

/** Join tables: a composite primary key of global ids, never colliding across tenants; no tenant index. */
const JOIN_TABLES = new Set([
  'iam_user_roles',
  'iam_role_menus',
  'iam_role_depts',
  'iam_user_positions',
  'iam_user_pref',
  'msg_bulletin_receipt',
  'oauth_consent',
])

/** Unique keys that become per tenant: [table, key, its columns after `tenant_id`]. */
const PER_TENANT_KEYS: [table: string, key: string, columns: string][] = [
  ['iam_user', 'uk_iam_user_username', 'username,alive'],
  ['iam_user', 'uk_iam_user_mobile', 'mobile,alive'],
  ['iam_user', 'uk_iam_user_email', 'email,alive'],
  ['iam_role', 'uk_iam_role_code', 'code,alive'],
  ['iam_role', 'uk_iam_role_name', 'name,alive'],
  // a top-level dept has parent_id 0: without the tenant two tenants could not name theirs alike
  ['iam_dept', 'uk_iam_dept_name', 'parent_id,name,alive'],
  ['iam_position', 'uk_iam_position_code', 'code,alive'],
  ['iam_position', 'uk_iam_position_name', 'name,alive'],
  ['wf_model', 'uk_wf_model_key', 'model_key,alive'],
  ['wf_version', 'uk_wf_version_model_version', 'model_key,version,alive'],
  ['wf_form', 'uk_wf_form_name', 'name,alive'],
  ['demo_book', 'uk_demo_book_isbn', 'isbn,alive'],
  ['demo_invoice', 'uk_demo_invoice_invoice_no', 'invoice_no,alive'],
]

const TENANT_ID = "tenant_id bigint unsigned NOT NULL DEFAULT 1 COMMENT '租户 ID'"
const PLATFORM_TENANT_ID =
  "tenant_id bigint unsigned NULL COMMENT '租户 ID（只供平台按租户筛选，匿名或未解析出租户时为空）'"

/** Columns added: [table, column, definition]. */
const COLUMNS: [table: string, column: string, ddl: string][] = [
  ...TENANT_TABLES.map((table): [string, string, string] => [
    table,
    'tenant_id',
    table === 'aud_signin_log'
      ? "tenant_id bigint unsigned NULL DEFAULT 1 COMMENT '租户 ID（租户编码不存在的登录尝试为空）'"
      : TENANT_ID,
  ]),
  [
    'aud_action_log',
    'actor_tenant_id',
    "actor_tenant_id bigint unsigned NOT NULL DEFAULT 1 COMMENT '操作者本人所属租户 ID'",
  ],
  ['aud_http_trace', 'tenant_id', PLATFORM_TENANT_ID],
  ['aud_http_fault', 'tenant_id', PLATFORM_TENANT_ID],
  [
    'iam_menu',
    'platform_only',
    "platform_only tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否只对平台开放（不进租户套餐）'",
  ],
]

/** Tables that get `idx_<table>_tenant (tenant_id)`: no join table, no per-tenant unique key. */
const INDEXED = [
  ...TENANT_TABLES.filter(
    (t) => !JOIN_TABLES.has(t) && !PER_TENANT_KEYS.some(([table]) => table === t),
  ),
  'aud_http_trace',
  'aud_http_fault',
]

const AUDIT = `created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）'`
const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci'

// Tenants are never deleted (only disabled or expired, their data kept), so a code is never reused.
const NEW_TABLES = [
  `CREATE TABLE IF NOT EXISTS iam_tenant (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '租户 ID',
      code varchar(32) CHARACTER SET ascii NOT NULL COMMENT '租户编码（小写字母开头，小写字母、数字与连字符）',
      name varchar(64) NOT NULL COMMENT '租户名称（默认租户存 i18n 键）',
      brand_name varchar(64) NULL COMMENT '品牌名称',
      logo_object_id bigint unsigned NULL COMMENT '品牌 logo 的文件对象 ID',
      package_id bigint unsigned NULL COMMENT '租户套餐 ID（默认租户为空即不受限，其他租户为空即无功能）',
      user_quota int unsigned NULL COMMENT '用户数上限（空为不限）',
      expires_at datetime(3) NULL COMMENT '到期时间（UTC，空为永久）',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      owner_user_id bigint unsigned NULL COMMENT '开通时创建的管理员用户 ID',
      initial_password_enc varchar(512) CHARACTER SET ascii NULL COMMENT '本租户新建用户的初始密码密文',
      note varchar(500) NULL COMMENT '备注',
      ${AUDIT},
      PRIMARY KEY (id),
      UNIQUE KEY uk_iam_tenant_code (code, alive)
    ) ${TABLE_OPTIONS} COMMENT='租户'`,
  `CREATE TABLE IF NOT EXISTS iam_tenant_domain (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '绑定 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '所属租户 ID',
      domain varchar(253) CHARACTER SET ascii NOT NULL COMMENT '绑定的主机名（小写，不含端口与通配符）',
      ${AUDIT},
      PRIMARY KEY (id),
      UNIQUE KEY uk_iam_tenant_domain_domain (domain, alive),
      KEY idx_iam_tenant_domain_tenant (tenant_id)
    ) ${TABLE_OPTIONS} COMMENT='租户绑定域名'`,
  `CREATE TABLE IF NOT EXISTS iam_tenant_package (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '套餐 ID',
      name varchar(64) NOT NULL COMMENT '套餐名称',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      note varchar(500) NULL COMMENT '备注',
      ${AUDIT},
      PRIMARY KEY (id),
      UNIQUE KEY uk_iam_tenant_package_name (name, alive)
    ) ${TABLE_OPTIONS} COMMENT='租户套餐'`,
  `CREATE TABLE IF NOT EXISTS iam_tenant_package_menus (
      package_id bigint unsigned NOT NULL COMMENT '套餐 ID',
      menu_id bigint unsigned NOT NULL COMMENT '菜单 ID',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      PRIMARY KEY (package_id, menu_id),
      KEY idx_iam_tenant_package_menus_menu (menu_id)
    ) ${TABLE_OPTIONS} COMMENT='租户套餐菜单关联'`,
]

const hasTable = async (q: QueryRunner, table: string) =>
  (
    await q.query(
      'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
      [table],
    )
  ).length > 0

const hasColumn = async (q: QueryRunner, table: string, column: string) =>
  (
    await q.query(
      'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
      [table, column],
    )
  ).length > 0

/** The key's columns in order (`a,b,alive`), null when the table has no such key. */
const keyColumns = async (q: QueryRunner, table: string, key: string): Promise<string | null> => {
  const [{ cols }] = await q.query(
    `SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, key],
  )
  return cols
}

/**
 * Makes unique key `key` of `table` exactly `columns`. One statement drops the old definition and adds
 * the new one: InnoDB builds the new key under a temporary name first and drops the old one only when the
 * statement commits, so the old key holds until the new one is in place, and a failure keeps it.
 */
async function rebuildKey(
  q: QueryRunner,
  alter: (sql: string) => Promise<void>,
  table: string,
  key: string,
  columns: string,
): Promise<void> {
  const now = await keyColumns(q, table, key)
  if (now === columns) return
  const drop = now === null ? '' : `DROP INDEX ${key}, `
  // arch-allow: sql-concat table/key/column identifiers are this file's constants; tenant: a migration runs once over every tenant's rows
  await alter(`ALTER TABLE ${table} ${drop}ADD UNIQUE KEY ${key} (${columns}), ${ONLINE}`)
}
