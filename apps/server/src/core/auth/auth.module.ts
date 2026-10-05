import { type DynamicModule, Global, Module, type Type } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { DemoModeGuard } from '../guard/demo-mode.guard.js'
import { AuthController } from './auth.controller.js'
import { AuthGuard } from './auth.guard.js'
import { AuthParams } from './auth-params.js'
import { AuthService } from './auth.service.js'
import { PermGuard } from './perm.guard.js'
import { PermVersion } from './perm-version.js'
import { SessionRevoker } from './session-revoker.js'
import { TokenService } from './token.service.js'

/**
 * Sessions, tokens, the /api/auth endpoints and global DemoModeGuard → AuthGuard → PermGuard (see docs/design-notes.md#auth-sessions, #permissions). Needs CoreConfigModule, CoreRedisModule, CoreContextModule, CoreDbModule and
 * CoreAuditModule (all global).
 */
@Global()
@Module({})
export class CoreAuthModule {
  /** `userLookup`: the module exporting `USER_LOOKUP` (iam; single reverse dependency; see docs/design-notes.md#layering). */
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
        // order matters: demo blocks even public writes; PermGuard reads AuthGuard's principal
        { provide: APP_GUARD, useClass: DemoModeGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermGuard },
      ],
      exports: [AuthService, TokenService, SessionRevoker, PermVersion, AuthParams],
    }
  }
}
