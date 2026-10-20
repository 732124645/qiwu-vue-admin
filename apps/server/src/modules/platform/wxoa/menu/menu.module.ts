import { Module } from '@nestjs/common'
import { WxoaCoreModule } from '../core/wxoa-core.module.js'
import { WxoaMenuController } from './menu.controller.js'
import { WxoaMenuService } from './menu.service.js'

@Module({
  imports: [WxoaCoreModule],
  controllers: [WxoaMenuController],
  providers: [WxoaMenuService],
})
export class WxoaMenuModule {}
