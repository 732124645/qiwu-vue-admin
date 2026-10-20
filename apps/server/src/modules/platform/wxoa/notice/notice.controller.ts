import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common'
import {
  type WxoaNoticeAdd,
  type WxoaNoticeLibraryQuery,
  type WxoaNoticeQuery,
  type WxoaNoticeSend,
  wxoaNoticeAdd,
  wxoaNoticeLibraryQuery,
  wxoaNoticeLibraryVo,
  wxoaNoticeQuery,
  wxoaNoticeSend,
  wxoaPerms,
} from '@qiwu/shared'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { clsGet } from '../../../../core/context/cls.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { ApiWxoa } from '../core/wxoa-swagger.js'
import { WxoaNoticeService } from './notice.service.js'

@ApiWxoa()
@Controller('wxoa/notice-templates')
export class WxoaNoticeController {
  constructor(private readonly service: WxoaNoticeService) {}
  @Get() @RequirePerm(wxoaPerms.notice.browse) @ApiEnvelope() list(
    @Query({ schema: wxoaNoticeQuery }) q: WxoaNoticeQuery,
  ) {
    return this.service.list(q)
  }
  @Get('library') @RequirePerm(wxoaPerms.notice.browse) @ApiEnvelope(wxoaNoticeLibraryVo) library(
    @Query({ schema: wxoaNoticeLibraryQuery }) q: WxoaNoticeLibraryQuery,
  ) {
    return this.service.library(q)
  }
  @Post()
  @RequirePerm(wxoaPerms.notice.modify)
  @Idempotent()
  @ActionLog({ domain: 'wxoa.notice', verb: 'create' })
  @ApiEnvelope()
  add(@Body({ schema: wxoaNoticeAdd }) dto: WxoaNoticeAdd) {
    return this.service.add(dto)
  }
  @Delete(':priTmplId')
  @RequirePerm(wxoaPerms.notice.modify)
  @ActionLog({ domain: 'wxoa.notice', verb: 'remove' })
  @ApiEnvelope()
  remove(@Query('accountId', ParseIntPipe) accountId: number, @Param('priTmplId') id: string) {
    return this.service.remove(Number(accountId), id)
  }
  @Post(':priTmplId/send')
  @RequirePerm(wxoaPerms.notice.send)
  @Idempotent()
  @ActionLog({ domain: 'wxoa.notice', verb: 'send' })
  @ApiEnvelope()
  send(@Param('priTmplId') id: string, @Body({ schema: wxoaNoticeSend }) dto: WxoaNoticeSend) {
    return this.service.send(id, dto, clsGet('principal')?.userId ?? 0)
  }
}
