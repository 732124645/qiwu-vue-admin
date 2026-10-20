import { Module } from '@nestjs/common'
import { StorageModule } from '../../storage/storage.module.js'
import { WxoaCoreModule } from '../core/wxoa-core.module.js'
import { WxoaFanModule } from '../fan/fan.module.js'
import { WxoaMaterialModule } from '../material/material.module.js'
import { WxoaConversationController, WxoaMessageController } from './message.controller.js'
import { WxoaMessageService } from './message.service.js'

@Module({
  imports: [WxoaCoreModule, StorageModule, WxoaFanModule, WxoaMaterialModule],
  controllers: [WxoaMessageController, WxoaConversationController],
  providers: [WxoaMessageService],
})
export class WxoaMessageModule {}
