import { Module } from '@nestjs/common'
import { WxoaCoreModule } from '../core/wxoa-core.module.js'
import { WxoaReplyRuleController } from './reply-rule.controller.js'
import { WxoaReplyRuleService } from './reply-rule.service.js'

@Module({
  imports: [WxoaCoreModule],
  controllers: [WxoaReplyRuleController],
  providers: [WxoaReplyRuleService],
})
export class WxoaReplyModule {}
