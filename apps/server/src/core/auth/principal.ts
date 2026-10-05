import type { Locale } from '@qiwu/shared'

/** Code of the super admin role; only the builtin role with it is root (see docs/design-notes.md#auth-sessions). */
export const ROOT_ROLE = 'root'

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
  /** `iam_user.locale`: the language after `?lang` and `Accept-Language` (see docs/design-notes.md#api-envelope). */
  locale?: Locale | null
}
