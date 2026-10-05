import type { MenuNode, MeUser } from '@qiwu/shared'
import type { SessionUser } from './token.service.js'

/**
 * DI token of the `UserLookup` port: the one place core depends on a module (see docs/design-notes.md#layering). iam provides
 * it and AppModule passes that module to `CoreAuthModule.forRoot`.
 */
export const USER_LOOKUP = Symbol('USER_LOOKUP')

/** A signed-in user's facts as the user store knows them (the session adds `permVer`). */
export type AuthUser = Omit<SessionUser, 'permVer' | 'userId' | 'username' | 'deptName'> & {
  userId: number
  username: string
  deptName: string | null
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
   * are well-formed `<domain>.<resource>.<verb>` codes (never `*`); the builtin root role alone gets
   * `*`, data scope `all` and `root: true`. null when the user is missing, deleted or disabled.
   */
  load(userId: number): Promise<AuthUser | null>
  /** A live user by username (the column's case-insensitive collation) or id; null = none or deleted. */
  findCredentials(by: { username: string } | { userId: number }): Promise<Credentials | null>
  /** `last_login_ip`/`last_login_at` and, when known, `timezone` after a successful sign-in. */
  recordSignIn(userId: number, rec: SignInRecord): Promise<void>
  /** The signed-in user's profile for GET /api/auth/me; null = gone. */
  profile(userId: number): Promise<MeUser | null>
  /**
   * GET /api/auth/menus: the group/page tree the user's enabled roles grant, ancestors included;
   * `all` (root) = every enabled menu.
   */
  menus(userId: number, all: boolean): Promise<MenuNode[]>
  /** Ids of the users holding the role (`PermVersion.bumpUsersOfRole`). */
  userIdsOfRole(roleId: number): Promise<number[]>
}
