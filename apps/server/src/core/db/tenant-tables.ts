import { PROJECT_GLOBAL_UNIQUE, PROJECT_PLATFORM_TABLES } from '../../db/project-tables.js'

/** How a taken value of a global unique key is freed again (see `GLOBAL_UNIQUE`). */
export type GlobalUnique = { table: string; release: 'none' | 'row-delete' | 'takeover' }

/**
 * Which tables belong to a tenant (see docs/design-notes.md#tenancy). Every table is a tenant table — its
 * rows carry `tenant_id` and are filtered by tenant — unless it is a platform table: run by the default
 * tenant (the platform operator) for every tenant, no automatic filter. A new table is a tenant table by
 * default; making it a platform table means registering it in the same change — the template's own here,
 * a project's in `db/project-tables.ts` (the db-migrations spec fails on a table that is neither). Keep
 * the lists plain literals: checks read them as text.
 */
const TEMPLATE_PLATFORM_TABLES: readonly string[] = [
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
  'cfg_mcp_tool',
  'agent_provider',
  'agent_search_provider',
  'agent_mcp_server',
  'agent_mcp_tool',
  'agent_platform_skill',
]

/** Every platform table: the template's and the project's (`db/project-tables.ts`). */
export const PLATFORM_TABLES: readonly string[] = [
  ...TEMPLATE_PLATFORM_TABLES,
  ...PROJECT_PLATFORM_TABLES,
]

/**
 * Unique keys of tenant tables that stay global (every other one starts with `tenant_id`): index name →
 * its table and how a taken value is freed again, since tenants are never deleted (only disabled or
 * expired, their rows kept): `none` — the key holds a global id or a server-made globally unique value,
 * so no other tenant ever collides; `row-delete` — only deleting that row frees it; `takeover` — the
 * writer takes the old row over across tenants. A new global key is registered with its release in the
 * same change: the template's here, a project's in `db/project-tables.ts`.
 */
const TEMPLATE_GLOBAL_UNIQUE: Readonly<Record<string, GlobalUnique>> = {
  uk_iam_user_social_openid: { table: 'iam_user_social', release: 'row-delete' },
  uk_iam_user_social_user: { table: 'iam_user_social', release: 'none' },
  uk_fs_object_key: { table: 'fs_object', release: 'none' },
  uk_wxoa_account_app_id: { table: 'wxoa_account', release: 'row-delete' },
  uk_wxoa_account_callback_key: { table: 'wxoa_account', release: 'none' },
  uk_wxoa_fan_open_id: { table: 'wxoa_fan', release: 'none' },
  uk_wxoa_tag_tag_id: { table: 'wxoa_tag', release: 'none' },
  uk_wxoa_message_dedup: { table: 'wxoa_message', release: 'none' },
  uk_wxoa_reply_rule_sole: { table: 'wxoa_reply_rule', release: 'none' },
  uk_wxoa_reply_rule_event_key: { table: 'wxoa_reply_rule', release: 'none' },
  uk_wxoa_menu_default: { table: 'wxoa_menu', release: 'none' },
  uk_wxoa_material_media_id: { table: 'wxoa_material', release: 'none' },
  uk_wxoa_qrcode_scene: { table: 'wxoa_qrcode', release: 'none' },
  uk_wxoa_draft_media_id: { table: 'wxoa_draft', release: 'none' },
  uk_wxoa_publish_publish_id: { table: 'wxoa_publish', release: 'none' },
  uk_wxoa_publish_article_id: { table: 'wxoa_publish', release: 'none' },
  uk_wxoa_mass_client_msg_id: { table: 'wxoa_mass_job', release: 'none' },
  uk_wxoa_inline_image_object: { table: 'wxoa_inline_image', release: 'none' },
  uk_iam_access_token_digest: { table: 'iam_access_token', release: 'none' },
}

/** Every global unique key: the template's and the project's (`db/project-tables.ts`). */
export const GLOBAL_UNIQUE: Readonly<Record<string, GlobalUnique>> = {
  ...TEMPLATE_GLOBAL_UNIQUE,
  ...PROJECT_GLOBAL_UNIQUE,
}

/**
 * Whether `table` is filtered by tenant: it has the `tenant_id` column and is no platform table (the
 * platform tables `aud_http_trace`, `aud_http_fault` and `iam_tenant_domain` carry a plain `tenant_id`
 * that is never filtered).
 */
export const isTenantTable = (table: string, hasTenantColumn: boolean): boolean =>
  hasTenantColumn && !PLATFORM_TABLES.includes(table)
