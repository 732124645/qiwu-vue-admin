import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { USER_LOOKUP } from '../../../core/auth/user-lookup.js'
import { referencedBy } from '../../../core/db/references.js'
import { StorageModule } from '../storage/storage.module.js'
import { InboxModule } from '../messaging/inbox/inbox.module.js'
import { SmsOtpModule } from '../messaging/sms-otp/sms-otp.module.js'
import { DeptModule } from './dept/dept.module.js'
import { IamUserLookup } from './iam-user-lookup.js'
import { MenuModule } from './menu/menu.module.js'
import { PositionModule } from './position/position.module.js'
import { ProfileController } from './profile/profile.controller.js'
import { ProfileService } from './profile/profile.service.js'
import { RoleModule } from './role/role.module.js'
import { SessionModule } from './session/session.module.js'
import { SignupController } from './signup/signup.controller.js'
import { SignupService } from './signup/signup.service.js'
import { UserSocial } from './social/user-social.entity.js'
import { ProfileSocialController, WxMpAuthController } from './social/wx-mp.controller.js'
import { WxMpGateway } from './social/wx-mp.gateway.js'
import { WxMpService } from './social/wx-mp.service.js'
import { WxSubscribeService } from './social/wx-subscribe.service.js'
import { UserModule } from './user/user.module.js'

// what the dropped foreign keys did: a user's UI preferences, roles, positions and sign-in bindings
// go with the user, a role's menu and dept grants with the role (an assigned position is in use:
// position.entity.ts, generated from its codegen config). A role users hold, a dept with users and a
// granted menu are refused by their services (409 with their own codes).
referencedBy(
  'iam_user',
  { table: 'iam_user_pref', column: 'user_id', cascade: true },
  { table: 'iam_user_roles', column: 'user_id', cascade: true },
  { table: 'iam_user_positions', column: 'user_id', cascade: true },
  { table: 'iam_user_social', column: 'user_id', cascade: true },
)
referencedBy(
  'iam_role',
  { table: 'iam_role_menus', column: 'role_id', cascade: true },
  { table: 'iam_role_depts', column: 'role_id', cascade: true },
)

/**
 * Identity & access: the `UserLookup` core/auth needs and the own-password change; positions; dept tree
 * and role options lookups, users, the personal center (avatar through storage); depts/roles/menus CRUD;
 * online sessions and kicks; WeChat mini program sign-in and binding (social/); WeChat subscribe-message
 * reminders after inbox delivery.
 */
@Module({
  imports: [
    PositionModule,
    DeptModule,
    RoleModule,
    MenuModule,
    UserModule,
    SessionModule,
    StorageModule,
    SmsOtpModule,
    InboxModule,
    TypeOrmModule.forFeature([UserSocial]),
  ],
  controllers: [ProfileController, SignupController, WxMpAuthController, ProfileSocialController],
  providers: [
    { provide: USER_LOOKUP, useClass: IamUserLookup },
    ProfileService,
    SignupService,
    WxMpGateway,
    WxMpService,
    WxSubscribeService,
  ],
  exports: [USER_LOOKUP],
})
export class IamModule {}
