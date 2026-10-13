import type { Locale } from '@qiwu/shared'

/**
 * Code of the super admin role; only the default tenant's builtin role with it, held by a user of the
 * default tenant, is root (see docs/design-notes.md#auth-sessions, #tenancy).
 */
export const ROOT_ROLE = 'root'

/**
 * Code of a tenant's administrator role; only the builtin role with it is one: perms = every menu open
 * to tenants, not root (see docs/design-notes.md#tenancy).
 */
export { TENANT_ADMIN_ROLE } from '@qiwu/shared'

/** Role data scope codes (see docs/design-notes.md#data-scope). */
export type DataScope = 'all' | 'picked_depts' | 'own_dept' | 'own_dept_tree' | 'own_rows'

/** One enabled role of the caller, as the session carries it. */
export interface PrincipalRole {
  /** `iam_role.code` */
  code: string
  dataScope: DataScope
  /** `picked_depts` only (iam_role_depts). */
  deptIds?: number[]
  /** Permission codes of this role; `['*']` only for the builtin root role. */
  perms: string[]
}

/** The authenticated caller, built by AuthGuard from the session (see docs/design-notes.md#auth-sessions) and kept in CLS. */
export interface Principal {
  userId: number
  /** Login name and dept name (i18n key or text) as the session loaded them; the action log's actor. */
  username?: string
  deptName?: string | null
  /** Session id; absent for callers without a session (jobs, specs). */
  sid?: string
  /** `iam_user.user_type` and the session's client (`console`, `mobile` or an OAuth2 client); for the API access log */
  userType?: string
  clientId?: string
  deptId: number | null
  /** `tree_path` of the user's dept (`/1/5/`, always ends with `/`); needed by `own_dept_tree`. */
  deptTreePath: string | null
  /** Enabled roles only. */
  roles: PrincipalRole[]
  /** Union of the roles' perms; `['*']` for root. */
  perms: string[]
  /**
   * Holds the builtin root role (code `root`, `is_builtin = 1`): passes every perm/role check and data
   * scope. The only super admin test; `perms` containing `*` is not one.
   */
  root?: boolean
  /**
   * Holds the builtin `tenant_admin` role of the user's tenant: the tenant's own root for the data-scope
   * grant rules, and may manage other holders (see docs/design-notes.md#tenancy).
   */
  tenantAdmin?: boolean
  /**
   * The user's own tenant (`iam_user.tenant_id`): the operator's tenant `@PlatformOnly()` checks. AuthGuard
   * always sets it (a session signed before it was recorded is reloaded first); absent only where a
   * principal is built by hand.
   */
  tenantId?: number
  /**
   * The tenant a platform user entered (the session's `actingTenantId`): the data tenant of this request
   * unless the route runs in the user's own (`@HomeTenant()`, `@PlatformOnly()`). Absent = not entered.
   */
  actingTenantId?: number
  /** The session's feature set (`SessionUser.features`): absent = unrestricted. */
  features?: string[]
  /** `iam_user.locale`: the language after `?lang` and `Accept-Language` (see docs/design-notes.md#api-envelope). */
  locale?: Locale | null
}
