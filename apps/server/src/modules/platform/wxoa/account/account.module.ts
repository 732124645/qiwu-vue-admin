import { Module } from '@nestjs/common'
import { WxoaCoreModule } from '../core/wxoa-core.module.js'
import { WxoaAccountController } from './account.controller.js'
import { WxoaAccountService } from './account.service.js'

@Module({
  imports: [WxoaCoreModule],
  controllers: [WxoaAccountController],
  providers: [WxoaAccountService],
})
export class WxoaAccountModule {}
