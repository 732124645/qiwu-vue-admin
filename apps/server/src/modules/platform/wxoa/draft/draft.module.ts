import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { StorageModule } from '../../storage/storage.module.js'
import { WxoaCoreModule } from '../core/wxoa-core.module.js'
import { WxoaAccount, WxoaDraft, WxoaInlineImage, WxoaMaterial } from '../core/wxoa.entity.js'
import { WxoaDraftController } from './draft.controller.js'
import { WxoaDraftService } from './draft.service.js'
@Module({
  imports: [
    WxoaCoreModule,
    StorageModule,
    TypeOrmModule.forFeature([WxoaAccount, WxoaDraft, WxoaInlineImage, WxoaMaterial]),
  ],
  controllers: [WxoaDraftController],
  providers: [WxoaDraftService],
  exports: [WxoaDraftService],
})
export class WxoaDraftModule {}
