import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { DEFAULT_TENANT_ID } from '@qiwu/shared'
import { AppConfigService } from '../config/config.module.js'
import { clsGet } from '../context/cls.js'

export const PLATFORM_ONLY = 'qw:auth:platform-only'

/** Who passes `@PlatformOnly()`: any user of the default tenant, or (`'root'`) only root. */
export type PlatformOnlyWho = 'platform' | 'root'

/**
 * The route of a platform page (a menu of `PLATFORM_ONLY_ROUTES` carries its perm; see
 * docs/design-notes.md#tenancy): while multi-tenancy is on, only a user of the default tenant calls it
 * (403 otherwise), `'root'` only root (pages holding every tenant's data: the API access and error logs,
 * the cache monitor). While it is off everyone is in the default tenant and both pass. Every route with
 * such a perm carries it and no other route does (the tenant-platform-only spec walks them all).
 */
export const PlatformOnly = (who?: 'root') =>
  SetMetadata(PLATFORM_ONLY, (who ?? 'platform') satisfies PlatformOnlyWho)

/** Global, after PermGuard: `@PlatformOnly()` against the CLS principal (its own tenant, from the user row). */
@Injectable()
export class PlatformOnlyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cfg: AppConfigService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const who = this.reflector.getAllAndOverride<PlatformOnlyWho | undefined>(PLATFORM_ONLY, [
      ctx.getHandler(),
      ctx.getClass(),
    ])
    if (!who || !this.cfg.get('APP_MULTI_TENANT')) return true
    const p = clsGet('principal')
    // a session without a recorded tenant passes nothing here
    if (p?.tenantId !== DEFAULT_TENANT_ID || (who === 'root' && p.root !== true))
      throw new ForbiddenException()
    return true
  }
}
