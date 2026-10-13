import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { DEFAULT_TENANT_ID } from '@qiwu/shared'
import { clsGet } from '../context/cls.js'

export const HOME_TENANT = 'qw:auth:home-tenant'
export const REQUIRE_FEATURE = 'qw:auth:feature'

/**
 * A personal route (the caller's own profile, preferences, messages, to-dos; see
 * docs/design-notes.md#tenancy): it runs in the caller's own tenant even while a platform user works inside
 * another one. AuthGuard reads it; `@PlatformOnly()` routes run so as well.
 */
export const HomeTenant = () => SetMetadata(HOME_TENANT, true)

/**
 * A route that needs only a session but belongs to the feature of a top-level menu group (`group` = its
 * route name, e.g. `workflow`): available when the session's tenant package holds that group. Not a perm:
 * the users of the default tenant who use it today without one keep doing so (see
 * docs/design-notes.md#tenancy).
 */
export const RequireFeature = (group: string) => SetMetadata(REQUIRE_FEATURE, group)

/**
 * Global, after PermGuard: `@RequireFeature` against the session's feature set (CLS principal
 * `features`, the groups its tenant's package reaches). None recorded on a session of the default tenant
 * = unrestricted: every group passes; on a session of another tenant = none (a tenant without a package
 * uses nothing). A platform user working inside another tenant passes whatever that tenant's package
 * holds. A group outside the set is no route at all (404).
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const group = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_FEATURE, [
      ctx.getHandler(),
      ctx.getClass(),
    ])
    if (group === undefined) return true
    const p = clsGet('principal')
    // inside another tenant: never narrowed to its package
    if (p?.actingTenantId !== undefined) return true
    const features = p?.features ?? (p && p.tenantId !== DEFAULT_TENANT_ID ? [] : undefined)
    if (features === undefined || features.includes(group)) return true
    throw new NotFoundException()
  }
}
