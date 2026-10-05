import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { DeptModule } from '../dept/dept.module.js'
import { SmsOtpModule } from '../../messaging/sms-otp/sms-otp.module.js'
import { RoleModule } from '../role/role.module.js'
import { UserController } from './user.controller.js'
import { User } from './user.entity.js'
import { UserService } from './user.service.js'

@Module({
  imports: [TypeOrmModule.forFeature([User]), DeptModule, RoleModule, SmsOtpModule],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
