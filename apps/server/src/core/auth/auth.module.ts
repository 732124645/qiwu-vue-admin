import { type DynamicModule, Global, Module, type Type } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { DemoModeGuard } from '../guard/demo-mode.guard.js'
import { TenancyOnGuard } from '../guard/tenancy-on.guard.js'
import { AuthController } from './auth.controller.js'
import { AuthGuard } from './auth.guard.js'
import { AuthParams } from './auth-params.js'
import { AuthService } from './auth.service.js'
import { LoginTenantResolver } from './login-tenant.js'
import { PermGuard } from './perm.guard.js'
import { PermVersion } from './perm-version.js'
import { PlatformOnlyGuard } from './platform-only.js'
import { SessionCurrent } from './session-current.js'
import { SessionRevoker } from './session-revoker.js'
import { TenantActing } from './tenant-acting.js'
import { FeatureGuard } from './tenant-scope.js'
import { TokenService } from './token.service.js'

/**
 * Sessions, tokens, the /api/auth endpoints and global TenancyOnGuard → DemoModeGuard → AuthGuard →
 * PermGuard → PlatformOnlyGuard → FeatureGuard (see docs/design-notes.md#auth-sessions, #permissions, #tenancy). Needs CoreConfigModule, CoreRedisModule, CoreContextModule, CoreDbModule and
 * CoreAuditModule (all global).
 */
@Global()
@Module({})
export class CoreAuthModule {
  /**
   * `userLookup`: the module exporting `USER_LOOKUP` and `TENANT_LOOKUP` (iam; single reverse dependency;
   * see docs/design-notes.md#layering).
   */
  static forRoot(userLookup: Type): DynamicModule {
    return {
      module: CoreAuthModule,
      imports: [userLookup],
      controllers: [AuthController],
      providers: [
        AuthParams,
        AuthService,
        TokenService,
        SessionRevoker,
        PermVersion,
        SessionCurrent,
        LoginTenantResolver,
        TenantActing,
        // order matters: a route of a switched-off feature is no route; demo blocks even public
        // writes; PermGuard, PlatformOnlyGuard and FeatureGuard read AuthGuard's principal
        { provide: APP_GUARD, useClass: TenancyOnGuard },
        { provide: APP_GUARD, useClass: DemoModeGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermGuard },
        { provide: APP_GUARD, useClass: PlatformOnlyGuard },
        { provide: APP_GUARD, useClass: FeatureGuard },
      ],
      exports: [
        AuthService,
        TokenService,
        SessionRevoker,
        PermVersion,
        AuthParams,
        SessionCurrent,
        LoginTenantResolver,
        TenantActing,
      ],
    }
  }
}
