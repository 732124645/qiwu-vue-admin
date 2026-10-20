import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common'
import {
  type WxoaMassCreate,
  type WxoaMassDelete,
  wxoaMassDelete,
  type WxoaMassPreview,
  type WxoaMassQuery,
  wxoaMassCreate,
  wxoaMassPreview,
  wxoaMassQuery,
  wxoaMassVo,
  wxoaPerms,
  pageVo,
} from '@qiwu/shared'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { clsGet } from '../../../../core/context/cls.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { ApiWxoa } from '../core/wxoa-swagger.js'
import { WxoaMassService } from './mass.service.js'

@ApiWxoa()
@Controller('wxoa/mass-jobs')
export class WxoaMassController {
  constructor(private readonly service: WxoaMassService) {}
  @Get() @RequirePerm(wxoaPerms.mass.browse) @ApiEnvelope(pageVo(wxoaMassVo)) page(
    @Query({ schema: wxoaMassQuery }) q: WxoaMassQuery,
  ) {
    return this.service.list(q)
  }
  @Get(':id') @RequirePerm(wxoaPerms.mass.browse) @ApiEnvelope(wxoaMassVo) get(
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.one(id)
  }
  @Post()
  @RequirePerm(wxoaPerms.mass.send)
  @Idempotent()
  @ActionLog({ domain: 'wxoa.mass', verb: 'send' })
  @ApiEnvelope(wxoaMassVo, 201)
  send(@Body({ schema: wxoaMassCreate }) dto: WxoaMassCreate) {
    return this.service.send(dto, clsGet('principal')?.userId ?? 0)
  }
  @Post('preview')
  @RequirePerm(wxoaPerms.mass.send)
  @Idempotent()
  @ActionLog({ domain: 'wxoa.mass', verb: 'send' })
  @ApiEnvelope()
  preview(@Body({ schema: wxoaMassPreview }) dto: WxoaMassPreview) {
    return this.service.preview(dto, clsGet('principal')?.userId ?? 0)
  }
  /** 结果未知（如超时）的任务用原 clientmsgid 重发，微信按它防重，不会群发两次。 */
  @Post(':id/retry')
  @RequirePerm(wxoaPerms.mass.send)
  @Idempotent()
  @ActionLog({ domain: 'wxoa.mass', verb: 'send' })
  @ApiEnvelope(wxoaMassVo, 201)
  retry(@Param('id', ParseIntPipe) id: number) {
    return this.service.retry(id)
  }
  @Delete(':id')
  @RequirePerm(wxoaPerms.mass.remove)
  @ActionLog({ domain: 'wxoa.mass', verb: 'remove' })
  @ApiEnvelope()
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Query({ schema: wxoaMassDelete }) q: WxoaMassDelete,
  ) {
    return this.service.drop(id, q.index)
  }
}
