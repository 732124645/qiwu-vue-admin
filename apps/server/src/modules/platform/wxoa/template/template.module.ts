import { Module } from '@nestjs/common'
import { WxoaCoreModule } from '../core/wxoa-core.module.js'
import { WxoaTemplateController } from './template.controller.js'
import { WxoaTemplateService } from './template.service.js'

@Module({
  imports: [WxoaCoreModule],
  controllers: [WxoaTemplateController],
  providers: [WxoaTemplateService],
})
export class WxoaTemplateModule {}
