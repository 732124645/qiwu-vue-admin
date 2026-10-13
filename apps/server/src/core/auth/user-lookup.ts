import type { MenuNode, MeUser } from '@qiwu/shared'
import type { SessionUser } from './token.service.js'

/**
 * DI token of the `UserLookup` port: the one place core depends on a module (see docs/design-notes.md#layering). iam provides
 * it and AppModule passes that module to `CoreAuthModule.forRoot`.
 */
export const USER_LOOKUP = Symbol('USER_LOOKUP')

/** A signed-in user's facts as the user store knows them (the session adds `permVer`). */
export type AuthUser = Omit<
  SessionUser,
  'permVer' | 'userId' | 'username' | 'deptName' | 'tenantId'
> & {
  userId: number
  username: string
  deptName: string | null
  tenantId: number
}

/** What sign-in and password checks need about a live (not deleted) user. */
export interface Credentials {
  userType: string
  userId: number
  username: string
  /** bcrypt */
  passwordHash: string
  enabled: boolean
  /** null = never changed (seeded/initial password): the session must change it first */
  passwordChangedAt: Date | null
}

export interface SignInRecord {
  ip: string
  at: Date
  /** IANA zone from `X-Timezone`; null keeps the stored one */
  timezone: string | null
}

export interface UserLookup {
  /**
   * An enabled, live user with their enabled roles, each with the perms of its enabled menus that
   * are well-formed `<domain>.<resource>.<verb>` codes (never `*`); the default tenant's builtin root
   * role, held by a user of the default tenant, alone gets `*`, data scope `all` and `root: true`; the
   * builtin `tenant_admin` role gets the perms of every menu open to tenants and `tenantAdmin: true`. A
   * user of another tenant than the default one gets no perm that a platform-only menu carries, only those
   * of its tenant's package (the `tenant_admin` role all of these) and `features`, the top-level groups
   * the package reaches (none without an enabled package). The user is read by its global id, its roles and grants in its
   * own tenant, whatever the caller's context; `tenantExpAt` is that tenant's end. null when the user is
   * missing, deleted or disabled, or its tenant is not available (TenantLookup.active).
   */
  load(userId: number): Promise<AuthUser | null>
  /**
   * A live user by username in tenant `tenantId` (the column's case-insensitive collation; usernames are
   * unique within a tenant only) or by its global id; null = none or deleted.
   */
  findCredentials(
    by: { tenantId: number; username: string } | { userId: number },
  ): Promise<Credentials | null>
  /** `last_login_ip`/`last_login_at` and, when known, `timezone` after a successful sign-in. */
  recordSignIn(userId: number, rec: SignInRecord): Promise<void>
  /** The signed-in user's profile for GET /api/auth/me; null = gone. */
  profile(userId: number): Promise<MeUser | null>
  /**
   * GET /api/auth/menus: the group/page tree the user's enabled roles grant, ancestors included;
   * `all` (root) = every enabled menu; `tenantAdmin` adds every menu open to tenants. A user of another
   * tenant than the default one never gets a platform-only menu, whatever its roles were granted, nor
   * one outside its tenant's package; neither does one working inside another tenant (`tenantOnly`).
   */
  menus(
    userId: number,
    all: boolean,
    tenantAdmin?: boolean,
    tenantOnly?: boolean,
  ): Promise<MenuNode[]>
  /**
   * Every perm a platform-only menu carries (enabled or not): what a platform user working inside another
   * tenant does not hold there (see docs/design-notes.md#tenancy).
   */
  platformPerms(): Promise<string[]>
  /**
   * The route names of every live top-level menu group, by `sort_no`: the feature set of an unrestricted
   * session (`/me.features`; see docs/design-notes.md#tenancy).
   */
  featureGroups(): Promise<string[]>
  /** Ids of the users holding the role (`PermVersion.bumpUsersOfRole`). */
  userIdsOfRole(roleId: number): Promise<number[]>
}
