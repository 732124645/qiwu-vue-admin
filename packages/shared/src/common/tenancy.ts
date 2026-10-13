/**
 * The column holding a row's tenant (see docs/design-notes.md#tenancy): a system column like the audit
 * ones, never in a generated list, form, query, DTO or Excel sheet.
 */
export const TENANT_COLUMN = 'tenant_id'

/** The default tenant: the platform operator, owner of every row while multi-tenancy is off. */
export const DEFAULT_TENANT_ID = 1

/**
 * The code of the builtin role a tenant is opened with: its own root for the data scope, holding every menu
 * open to the tenant's package. Like the root role it is never disabled and its grants are fixed.
 */
export const TENANT_ADMIN_ROLE = 'tenant_admin'

/**
 * The menus only the platform (the default tenant) uses, by `route_name` (see
 * docs/design-notes.md#tenancy): a menu is platform-only when it is listed here or any ancestor is.
 * The seeds and the menu service keep `iam_menu.platform_only` by this rule; sessions of other tenants
 * lose every perm such a menu carries and the controllers behind it carry `@PlatformOnly()`. Groups are
 * not listed (the demo group hangs under the dev tools one): their platform pages are. A generated page
 * of a platform table is added here by hand (the generator's registration lines say so).
 */
export const PLATFORM_ONLY_ROUTES: readonly string[] = [
  // system monitor (online sessions stay: filtered by tenant)
  'monitor-server',
  'monitor-mysql',
  'monitor-redis',
  'monitor-cache',
  'scheduler-task',
  'scheduler-run',
  // dev tools (the process form and model designers belong to the workflow)
  'codegen-table',
  'formkit-design',
  'devtools-api-docs',
  'devtools-ui-docs',
  // system management
  'iam-menu',
  'settings-dict',
  'settings-dict-entry',
  'settings-param',
  'settings-app-version',
  'storage-config',
  'oauth-client',
  'messaging-mail-account',
  'messaging-sms-channel',
  'messaging-inbox-template',
  'messaging-mail-template',
  'messaging-sms-template',
  'audit-http-trace',
  'audit-http-fault',
  // tenant management
  'iam-tenant',
  'iam-tenant-package',
]

/**
 * The platform pages holding every tenant's data (the API access and error logs, the cache monitor): while
 * multi-tenancy is on only root opens them, so the side menu leaves them out for everyone else, whatever
 * their roles were granted.
 */
export const ROOT_ONLY_ROUTES: readonly string[] = [
  'audit-http-trace',
  'audit-http-fault',
  'monitor-cache',
]
