import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { WxoaCoreModule } from '../core/wxoa-core.module.js'
import { WxoaDraft, WxoaFan, WxoaMassJob, WxoaTag } from '../core/wxoa.entity.js'
import { WxoaMassController } from './mass.controller.js'
import { WxoaMassService } from './mass.service.js'
@Module({
  imports: [WxoaCoreModule, TypeOrmModule.forFeature([WxoaDraft, WxoaFan, WxoaMassJob, WxoaTag])],
  controllers: [WxoaMassController],
  providers: [WxoaMassService],
})
export class WxoaMassModule {}
