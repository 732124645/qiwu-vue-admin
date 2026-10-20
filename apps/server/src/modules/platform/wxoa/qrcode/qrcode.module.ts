import { Module } from '@nestjs/common'
import { StorageModule } from '../../storage/storage.module.js'
import { WxoaCoreModule } from '../core/wxoa-core.module.js'
import { WxoaFanModule } from '../fan/fan.module.js'
import { WxoaQrcodeController } from './qrcode.controller.js'
import { WxoaQrcodeService } from './qrcode.service.js'

@Module({
  imports: [WxoaCoreModule, StorageModule, WxoaFanModule],
  controllers: [WxoaQrcodeController],
  providers: [WxoaQrcodeService],
})
export class WxoaQrcodeModule {}
