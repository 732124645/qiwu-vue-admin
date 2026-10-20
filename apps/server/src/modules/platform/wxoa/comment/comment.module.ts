import { Module } from '@nestjs/common'
import { WxoaCoreModule } from '../core/wxoa-core.module.js'
import { WxoaCommentController } from './comment.controller.js'
import { WxoaCommentService } from './comment.service.js'
@Module({
  imports: [WxoaCoreModule],
  controllers: [WxoaCommentController],
  providers: [WxoaCommentService],
})
export class WxoaCommentModule {}
