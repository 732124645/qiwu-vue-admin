import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Every table is soft-deleted and no table has a foreign key.
 * - `deleted_at` on every table that lacked it; `alive` (1 while live, NULL once deleted) on those with a
 *   unique key besides the primary key, and every such key becomes `(…, alive)`, so a deleted row's
 *   value can be used again. Join tables keep their composite primary key (a removed link is the same
 *   row, soft-deleted and revived: core/db/links.ts).
 * - Every foreign key is dropped; its index stays (demo_book's implicit one gets an idx_ name). What the
 *   keys did is application code now: RESTRICT → the reference registry (409 `in_use`), CASCADE → the
 *   referencing rows are soft-deleted with their parent (core/db/references.ts).
 * down: rows soft-deleted in tables that had no `deleted_at` are deleted for good (a deleted row of the
 * old schema is gone), so are rows a former CASCADE key would have taken with their parent; then keys,
 * columns and foreign keys are put back as they were (a live row naming a parent deleted for good fails
 * its RESTRICT key: data the old schema cannot hold). The four tables soft-deleted before this migration
 * (iam_user, iam_role, iam_dept, demo_book) keep theirs.
 */
export class SoftDeleteAll20260929100000 implements MigrationInterface {
  name = 'SoftDeleteAll20260929100000'

  async up(q: QueryRunner): Promise<void> {
    for (const [table, name] of FOREIGN_KEYS)
      // arch-allow: sql-concat table/key identifiers are this file's constants
      await q.query(`ALTER TABLE ${table} DROP FOREIGN KEY ${name}`)
    await q.query('ALTER TABLE demo_book RENAME INDEX fk_demo_book_dept TO idx_demo_book_dept')
    for (const [table, after, keys] of TABLES) {
      const place = after ? ` AFTER ${after}` : ''
      const alter = [`ADD COLUMN ${DELETED_AT}${place}`]
      if (keys.length) alter.push(`ADD COLUMN ${ALIVE} AFTER deleted_at`)
      for (const [name, columns] of keys)
        alter.push(`DROP INDEX ${name}`, `ADD UNIQUE KEY ${name} (${columns}, alive)`)
      // arch-allow: sql-concat table/key/column identifiers are this file's constants
      await q.query(`ALTER TABLE ${table} ${alter.join(', ')}`)
    }
  }

  async down(q: QueryRunner): Promise<void> {
    for (const [table] of TABLES)
      // arch-allow: sql-concat the table identifier is this file's constant
      await q.query(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL`)
    for (const [child, column, parent] of CASCADED)
      await q.query(
        // arch-allow: sql-concat table/column identifiers are this file's constants
        `DELETE c FROM ${child} c LEFT JOIN ${parent} p ON p.id = c.${column} WHERE p.id IS NULL`,
      )
    for (const [table, , keys] of TABLES) {
      const alter = keys.flatMap(([name, columns]) => [
        `DROP INDEX ${name}`,
        `ADD UNIQUE KEY ${name} (${columns})`,
      ])
      if (keys.length) alter.push('DROP COLUMN alive')
      alter.push('DROP COLUMN deleted_at')
      // arch-allow: sql-concat table/key/column identifiers are this file's constants
      await q.query(`ALTER TABLE ${table} ${alter.join(', ')}`)
    }
    await q.query('ALTER TABLE demo_book RENAME INDEX idx_demo_book_dept TO fk_demo_book_dept')
    for (const [table, name, ddl] of FOREIGN_KEYS)
      // arch-allow: sql-concat table/key identifiers and definitions are this file's constants
      await q.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${ddl}`)
  }
}

const DELETED_AT = "deleted_at datetime(3) NULL COMMENT '删除时间（UTC，软删）'"
const ALIVE =
  "alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）'"

/**
 * Tables that had no `deleted_at`: [table, column the new ones follow (null = last), unique keys besides
 * the primary key as [name, columns]].
 */
const TABLES: [table: string, after: string | null, keys: [name: string, columns: string][]][] = [
  ['iam_user_roles', null, []],
  ['iam_role_menus', null, []],
  ['iam_role_depts', null, []],
  ['iam_user_positions', null, []],
  ['iam_user_pref', 'updated_at', []],
  [
    'iam_menu',
    'updated_at',
    [
      ['uk_iam_menu_route_name', 'route_name'],
      ['uk_iam_menu_path', 'parent_id, path_key'],
    ],
  ],
  [
    'iam_position',
    'updated_at',
    [
      ['uk_iam_position_code', 'code'],
      ['uk_iam_position_name', 'name'],
    ],
  ],
  ['cfg_dict_entry', 'updated_at', [['uk_cfg_dict_entry_value', 'dict_code, value']]],
  ['cfg_dict', 'updated_at', [['uk_cfg_dict_code', 'code']]],
  ['cfg_param', 'updated_at', [['uk_cfg_param_key', 'param_key']]],
  ['aud_signin_log', null, []],
  ['aud_action_log', null, []],
  ['aud_http_trace', null, []],
  ['aud_http_fault', null, []],
  ['fs_object', 'updated_at', [['uk_fs_object_key', 'storage_id, object_key']]],
  [
    'fs_storage',
    'updated_at',
    [
      ['uk_fs_storage_name', 'name'],
      ['uk_fs_storage_primary', 'primary_one'],
    ],
  ],
  [
    'cg_column',
    'updated_at',
    [
      ['uk_cg_column_name', 'table_id, column_name'],
      ['uk_cg_column_field', 'table_id, field_name'],
    ],
  ],
  ['cg_table', 'updated_at', [['uk_cg_table_name', 'table_name']]],
  ['demo_topic', 'updated_at', []],
  ['demo_invoice_line', 'updated_at', []],
  ['demo_invoice', 'updated_at', [['uk_demo_invoice_invoice_no', 'invoice_no']]],
  ['msg_bulletin_receipt', null, []],
  ['msg_bulletin', 'updated_at', []],
  ['job_run', null, []],
  ['job_task', 'updated_at', [['uk_job_task_name', 'name']]],
  ['msg_inbox_template', 'updated_at', [['uk_msg_inbox_template_code_locale', 'code, locale']]],
  ['msg_inbox', null, []],
  ['msg_mail_template', 'updated_at', [['uk_msg_mail_template_code_locale', 'code, locale']]],
  ['msg_mail_account', 'updated_at', [['uk_msg_mail_account_name', 'name']]],
  ['msg_mail_record', null, []],
  ['msg_sms_template', 'updated_at', [['uk_msg_sms_template_code_locale', 'code, locale']]],
  ['msg_sms_channel', 'updated_at', [['uk_msg_sms_channel_name', 'name']]],
  ['msg_sms_record', null, []],
  ['msg_sms_otp', null, []],
]

/** Every foreign key there was: [table, name, definition]. */
const FOREIGN_KEYS: [table: string, name: string, ddl: string][] = [
  [
    'iam_user_positions',
    'fk_iam_user_positions_position',
    'FOREIGN KEY (position_id) REFERENCES iam_position (id) ON DELETE RESTRICT',
  ],
  [
    'iam_user_pref',
    'fk_iam_user_pref_user',
    'FOREIGN KEY (user_id) REFERENCES iam_user (id) ON DELETE CASCADE',
  ],
  [
    'fs_object',
    'fk_fs_object_storage',
    'FOREIGN KEY (storage_id) REFERENCES fs_storage (id) ON DELETE RESTRICT',
  ],
  [
    'cg_table',
    'fk_cg_table_master',
    'FOREIGN KEY (master_table_id) REFERENCES cg_table (id) ON DELETE RESTRICT',
  ],
  [
    'cg_column',
    'fk_cg_column_table',
    'FOREIGN KEY (table_id) REFERENCES cg_table (id) ON DELETE CASCADE',
  ],
  [
    'demo_book',
    'fk_demo_book_dept',
    'FOREIGN KEY (dept_id) REFERENCES iam_dept (id) ON DELETE RESTRICT',
  ],
  [
    'msg_bulletin_receipt',
    'fk_msg_bulletin_receipt_bulletin',
    'FOREIGN KEY (bulletin_id) REFERENCES msg_bulletin (id) ON DELETE CASCADE',
  ],
  [
    'demo_invoice_line',
    'fk_demo_invoice_line_invoice',
    'FOREIGN KEY (invoice_id) REFERENCES demo_invoice (id) ON DELETE CASCADE',
  ],
  [
    'msg_mail_template',
    'fk_msg_mail_template_account',
    'FOREIGN KEY (account_id) REFERENCES msg_mail_account (id) ON DELETE RESTRICT',
  ],
  [
    'msg_sms_template',
    'fk_msg_sms_template_channel',
    'FOREIGN KEY (channel_id) REFERENCES msg_sms_channel (id) ON DELETE RESTRICT',
  ],
]

/** The former CASCADE keys as [child, column, parent]: down deletes the children left without a parent. */
const CASCADED = FOREIGN_KEYS.filter(([, , ddl]) => ddl.endsWith('CASCADE')).map(
  ([table, , ddl]) => {
    const [, column, parent] = /\((\w+)\) REFERENCES (\w+)/.exec(ddl)!
    return [table, column!, parent!] as const
  },
)
