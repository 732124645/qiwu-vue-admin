import { Module } from '@nestjs/common'
import { WxoaCoreModule } from '../core/wxoa-core.module.js'
import { WxoaCallbackController } from './callback.controller.js'
import { WxoaCallbackService } from './callback.service.js'
import { WxoaReplyMatcher } from './reply-matcher.js'

@Module({
  imports: [WxoaCoreModule],
  controllers: [WxoaCallbackController],
  providers: [WxoaCallbackService, WxoaReplyMatcher],
})
export class WxoaCallbackModule {}
