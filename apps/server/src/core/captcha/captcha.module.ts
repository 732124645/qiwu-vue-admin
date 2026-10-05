import { Global, Module } from '@nestjs/common'
import { CaptchaController } from './captcha.controller.js'
import { CaptchaService } from './captcha.service.js'
import { CaptchaTicketVerifier } from './captcha-ticket.js'

@Global()
@Module({
  controllers: [CaptchaController],
  providers: [CaptchaTicketVerifier, CaptchaService],
  exports: [CaptchaTicketVerifier, CaptchaService],
})
export class CoreCaptchaModule {}
