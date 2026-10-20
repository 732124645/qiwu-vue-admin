import { Module } from '@nestjs/common'
import { RedisLock } from '../../../../core/guard/redis-lock.js'
import { WxoaCoreModule } from '../core/wxoa-core.module.js'
import { WxoaFanController } from './fan.controller.js'
import { WxoaFanService } from './fan.service.js'
import { WxoaTagController } from './tag.controller.js'
import { WxoaTagService } from './tag.service.js'

/** Exports the fan service: QR code scans tag fans through it. */
@Module({
  imports: [WxoaCoreModule],
  controllers: [WxoaFanController, WxoaTagController],
  providers: [WxoaFanService, WxoaTagService, RedisLock],
  exports: [WxoaFanService],
})
export class WxoaFanModule {}
