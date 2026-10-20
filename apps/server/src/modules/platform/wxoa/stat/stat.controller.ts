import { Controller, Get, Query } from '@nestjs/common'
import { type WxoaStatQuery, wxoaPerms, wxoaStatQuery, wxoaStatVo } from '@qiwu/shared'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { ApiWxoa } from '../core/wxoa-swagger.js'
import { WxoaStatService } from './stat.service.js'

@ApiWxoa()
@Controller('wxoa/stats')
export class WxoaStatController {
  constructor(private readonly service: WxoaStatService) {}
  @Get('users') @RequirePerm(wxoaPerms.stat.browse) @ApiEnvelope(wxoaStatVo) users(
    @Query({ schema: wxoaStatQuery }) q: WxoaStatQuery,
  ) {
    return this.service.users(q)
  }
  @Get('messages') @RequirePerm(wxoaPerms.stat.browse) @ApiEnvelope(wxoaStatVo) messages(
    @Query({ schema: wxoaStatQuery }) q: WxoaStatQuery,
  ) {
    return this.service.messages(q)
  }
  @Get('interfaces') @RequirePerm(wxoaPerms.stat.browse) @ApiEnvelope(wxoaStatVo) interfaces(
    @Query({ schema: wxoaStatQuery }) q: WxoaStatQuery,
  ) {
    return this.service.interfaces(q)
  }
  @Get('articles') @RequirePerm(wxoaPerms.stat.browse) @ApiEnvelope(wxoaStatVo) articles(
    @Query({ schema: wxoaStatQuery }) q: WxoaStatQuery,
  ) {
    return this.service.articles(q)
  }
}
