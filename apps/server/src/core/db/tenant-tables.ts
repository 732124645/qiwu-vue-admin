/**
 * Which tables belong to a tenant (see docs/design-notes.md#tenancy). Every table is a tenant table — its
 * rows carry `tenant_id` and are filtered by tenant — unless it is listed in `PLATFORM_TABLES`: run by the
 * default tenant (the platform operator) for every tenant, no automatic filter. A new table is a tenant
 * table by default; making it a platform table means adding it here in the same change (the
 * db-migrations spec fails on a table that is neither). Keep both lists plain literals: checks read them
 * as text.
 */
export const PLATFORM_TABLES: readonly string[] = [
  'meta_migrations',
  'iam_menu',
  'iam_tenant',
  'iam_tenant_domain',
  'iam_tenant_package',
  'iam_tenant_package_menus',
  'cfg_dict',
  'cfg_dict_entry',
  'cfg_param',
  'cfg_app_version',
  'cg_table',
  'cg_column',
  'job_task',
  'job_run',
  'fs_storage',
  'oauth_client',
  'msg_inbox_template',
  'msg_mail_template',
  'msg_sms_template',
  'msg_mail_account',
  'msg_sms_channel',
  'aud_http_trace',
  'aud_http_fault',
]

/**
 * Unique keys of tenant tables that stay global (every other one starts with `tenant_id`): index name →
 * its table and how a taken value is freed again, since tenants are never deleted (only disabled or
 * expired, their rows kept): `none` — the key holds a global id or a server-made globally unique value,
 * so no other tenant ever collides; `row-delete` — only deleting that row frees it; `takeover` — the
 * writer takes the old row over across tenants. A new global key is added here with its release in the
 * same change.
 */
export const GLOBAL_UNIQUE: Readonly<
  Record<string, { table: string; release: 'none' | 'row-delete' | 'takeover' }>
> = {
  uk_iam_user_social_openid: { table: 'iam_user_social', release: 'row-delete' },
  uk_iam_user_social_user: { table: 'iam_user_social', release: 'none' },
  uk_fs_object_key: { table: 'fs_object', release: 'none' },
}

/**
 * Whether `table` is filtered by tenant: it has the `tenant_id` column and is no platform table (the
 * platform tables `aud_http_trace`, `aud_http_fault` and `iam_tenant_domain` carry a plain `tenant_id`
 * that is never filtered).
 */
export const isTenantTable = (table: string, hasTenantColumn: boolean): boolean =>
  hasTenantColumn && !PLATFORM_TABLES.includes(table)
