import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { WxoaCoreModule } from '../core/wxoa-core.module.js'
import { WxoaDraft, WxoaPublish } from '../core/wxoa.entity.js'
import { WxoaPublishController } from './publish.controller.js'
import { WxoaPublishService } from './publish.service.js'
@Module({
  imports: [WxoaCoreModule, TypeOrmModule.forFeature([WxoaDraft, WxoaPublish])],
  controllers: [WxoaPublishController],
  providers: [WxoaPublishService],
})
export class WxoaPublishModule {}
