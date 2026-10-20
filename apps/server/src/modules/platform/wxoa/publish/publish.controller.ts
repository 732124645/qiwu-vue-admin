import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common'
import {
  type WxoaPublishCreate,
  type WxoaPublishQuery,
  wxoaPerms,
  wxoaPublishCreate,
  wxoaPublishDetailVo,
  wxoaPublishQuery,
  wxoaPublishVo,
  pageVo,
} from '@qiwu/shared'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { ApiWxoa } from '../core/wxoa-swagger.js'
import { WxoaPublishService } from './publish.service.js'
import { z } from 'zod'

@ApiWxoa()
@Controller('wxoa/publishes')
export class WxoaPublishController {
  constructor(private readonly service: WxoaPublishService) {}
  @Get() @RequirePerm(wxoaPerms.publish.browse) @ApiEnvelope(pageVo(wxoaPublishVo)) page(
    @Query({ schema: wxoaPublishQuery }) q: WxoaPublishQuery,
  ) {
    return this.service.list(q)
  }
  @Get(':id') @RequirePerm(wxoaPerms.publish.browse) @ApiEnvelope(wxoaPublishDetailVo) get(
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.one(id)
  }
  @Post()
  @RequirePerm(wxoaPerms.publish.create)
  @Idempotent()
  @ActionLog({ domain: 'wxoa.publish', verb: 'publish' })
  @ApiEnvelope(wxoaPublishVo, 201)
  submit(@Body({ schema: wxoaPublishCreate }) dto: WxoaPublishCreate) {
    return this.service.submit(dto)
  }
  @Post('pull')
  @RequirePerm(wxoaPerms.publish.create)
  @ActionLog({ domain: 'wxoa.publish', verb: 'sync' })
  @ApiEnvelope()
  pull(
    @Body({ schema: z.object({ accountId: z.coerce.number().int().positive() }) })
    dto: {
      accountId: number
    },
  ) {
    return this.service.pull(dto.accountId)
  }
  @Delete(':id')
  @RequirePerm(wxoaPerms.publish.remove)
  @ActionLog({ domain: 'wxoa.publish', verb: 'remove' })
  @ApiEnvelope()
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: z.object({ index: z.number().int().min(0).optional() }) })
    body: { index?: number },
  ) {
    return this.service.drop(id, body.index)
  }
}
