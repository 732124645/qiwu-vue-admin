import { Module } from '@nestjs/common'
import { WxoaCoreModule } from '../core/wxoa-core.module.js'
import { WxoaNoticeController } from './notice.controller.js'
import { WxoaNoticeService } from './notice.service.js'
@Module({
  imports: [WxoaCoreModule],
  controllers: [WxoaNoticeController],
  providers: [WxoaNoticeService],
})
export class WxoaNoticeModule {}
