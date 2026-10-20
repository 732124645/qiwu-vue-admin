import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { WXOA_ENTITIES } from './wxoa.entity.js'
import { WxoaGateway } from './wxoa-gateway.js'
import { WxoaInboundHub } from './wxoa-inbound-hub.js'
import { WxoaTokenService } from './wxoa-token.js'

/** What every wxoa feature module shares: the tables, the WeChat gateway, the tokens and the inbound hub. */
@Module({
  imports: [TypeOrmModule.forFeature(WXOA_ENTITIES)],
  providers: [WxoaGateway, WxoaTokenService, WxoaInboundHub],
  exports: [TypeOrmModule, WxoaGateway, WxoaTokenService, WxoaInboundHub],
})
export class WxoaCoreModule {}
