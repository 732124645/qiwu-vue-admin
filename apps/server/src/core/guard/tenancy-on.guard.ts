import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AppConfigService } from '../config/config.module.js'

export const TENANCY_ON = 'qw:tenancy-on'

/**
 * A route that exists only while multi-tenancy is on (tenant management, see
 * docs/design-notes.md#tenancy): 404 while `APP_MULTI_TENANT` is off, before authentication, so it looks
 * like no route at all.
 */
export const TenancyOn = () => SetMetadata(TENANCY_ON, true)

/** Global, first: `@TenancyOn()` routes answer 404 while multi-tenancy is off. */
@Injectable()
export class TenancyOnGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cfg: AppConfigService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (
      !this.cfg.get('APP_MULTI_TENANT') &&
      this.reflector.getAllAndOverride<boolean>(TENANCY_ON, [ctx.getHandler(), ctx.getClass()])
    )
      throw new NotFoundException()
    return true
  }
}
