import { SetMetadata } from '@nestjs/common'

export const IS_PUBLIC = 'qw:auth:public'
export const OAUTH_SCOPE = 'qw:auth:oauth-scope'
export const REQUIRE_PERM = 'qw:auth:perm'
export const REQUIRE_ROLE = 'qw:auth:role'

/** No session needed (AuthGuard is global: every other route requires one). */
export const Public = () => SetMetadata(IS_PUBLIC, true)

/**
 * Opens the route to third-party OAuth2 sessions carrying `scope` (token isolation; v1 only
 * `/api/oauth2/userinfo`; see docs/design-notes.md#auth-sessions). Console sessions pass as on any route.
 */
export const OAuthScope = (scope: string) => SetMetadata(OAUTH_SCOPE, scope)

/** A route's `@RequirePerm` (and, in CLS `checkedPerm`, what the caller passed it with). */
export interface PermRequirement {
  perms: string[]
  all: boolean
}

const requirePerm = (perms: string[], all: boolean) => {
  if (!perms.length) throw new Error('@RequirePerm needs at least one permission')
  return SetMetadata(REQUIRE_PERM, { perms, all } satisfies PermRequirement)
}

/**
 * `@RequirePerm('iam.user.modify')` (see docs/design-notes.md#permissions): several = any of them; `@RequirePerm.all(a, b)` = every
 * one. Root passes. CLS `checkedPerm` tells data scope which perms were checked (PermGuard).
 */
export const RequirePerm = Object.assign((...perms: string[]) => requirePerm(perms, false), {
  all: (...perms: string[]) => requirePerm(perms, true),
})

/** Any of the role codes (root passes; `root` itself only matches the builtin root role). */
export const RequireRole = (...codes: string[]) => {
  if (!codes.length) throw new Error('@RequireRole needs at least one role code')
  return SetMetadata(REQUIRE_ROLE, codes)
}
