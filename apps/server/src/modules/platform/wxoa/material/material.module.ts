import { Module } from '@nestjs/common'
import { RedisLock } from '../../../../core/guard/redis-lock.js'
import { StorageModule } from '../../storage/storage.module.js'
import { WxoaCoreModule } from '../core/wxoa-core.module.js'
import { WxoaMaterialController } from './material.controller.js'
import { WxoaMaterialService } from './material.service.js'

/** Exports the service: customer service messages take temporary media_ids from it. */
@Module({
  imports: [WxoaCoreModule, StorageModule],
  controllers: [WxoaMaterialController],
  providers: [WxoaMaterialService, RedisLock],
  exports: [WxoaMaterialService],
})
export class WxoaMaterialModule {}
