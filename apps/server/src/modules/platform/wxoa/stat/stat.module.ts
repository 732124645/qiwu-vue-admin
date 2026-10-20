import { Module } from '@nestjs/common'
import { WxoaCoreModule } from '../core/wxoa-core.module.js'
import { WxoaStatController } from './stat.controller.js'
import { WxoaStatService } from './stat.service.js'
@Module({
  imports: [WxoaCoreModule],
  controllers: [WxoaStatController],
  providers: [WxoaStatService],
})
export class WxoaStatModule {}
