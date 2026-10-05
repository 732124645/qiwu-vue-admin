import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { SmsTemplateModule } from '../sms-template/sms-template.module.js'
import { SmsAuthService } from './sms-auth.service.js'
import { SmsOtpController } from './sms-otp.controller.js'
import { SmsOtp } from './sms-otp.entity.js'
import { OtpService } from './sms-otp.service.js'

@Module({
  imports: [TypeOrmModule.forFeature([SmsOtp]), SmsTemplateModule],
  controllers: [SmsOtpController],
  providers: [OtpService, SmsAuthService],
  exports: [OtpService, SmsAuthService],
})
export class SmsOtpModule {}
