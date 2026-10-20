import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common'
import {
  pageVo,
  type WxoaDraftCreate,
  type WxoaDraftQuery,
  type WxoaDraftUpdate,
  wxoaDraftCreate,
  wxoaDraftQuery,
  wxoaDraftUpdate,
  wxoaDraftVo,
  wxoaPerms,
} from '@qiwu/shared'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { Sensitive } from '../../../../core/redact.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { ApiWxoa } from '../core/wxoa-swagger.js'
import { WxoaDraftService } from './draft.service.js'
import { z } from 'zod'

const zAccount = z.object({ accountId: z.coerce.number().int().positive() })

// 草稿正文与留言内容不进操作日志和接口日志
@Sensitive('content')
@ApiWxoa()
@Controller('wxoa/drafts')
export class WxoaDraftController {
  constructor(private readonly service: WxoaDraftService) {}
  @Get() @RequirePerm(wxoaPerms.draft.browse) @ApiEnvelope(pageVo(wxoaDraftVo)) page(
    @Query({ schema: wxoaDraftQuery }) q: WxoaDraftQuery,
  ) {
    return this.service.list(q)
  }
  @Get(':id') @RequirePerm(wxoaPerms.draft.browse) @ApiEnvelope(wxoaDraftVo) get(
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.one(id)
  }
  @Post()
  @RequirePerm(wxoaPerms.draft.create)
  @Idempotent()
  @ActionLog({ domain: 'wxoa.draft', verb: 'create' })
  @ApiEnvelope(wxoaDraftVo, 201)
  create(@Body({ schema: wxoaDraftCreate }) dto: WxoaDraftCreate) {
    return this.service.add(dto)
  }
  @Put(':id')
  @RequirePerm(wxoaPerms.draft.modify)
  @ActionLog({ domain: 'wxoa.draft', verb: 'modify' })
  @ApiEnvelope(wxoaDraftVo)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wxoaDraftUpdate }) dto: WxoaDraftUpdate,
  ) {
    return this.service.change(id, dto)
  }
  @Delete(':id')
  @RequirePerm(wxoaPerms.draft.remove)
  @ActionLog({ domain: 'wxoa.draft', verb: 'remove' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.drop(id)
  }
  @Post(':id/sync')
  @RequirePerm(wxoaPerms.draft.sync)
  @Idempotent()
  @ActionLog({ domain: 'wxoa.draft', verb: 'sync' })
  @ApiEnvelope()
  sync(@Param('id', ParseIntPipe) id: number) {
    return this.service.sync(id)
  }
  @Post('pull')
  @RequirePerm(wxoaPerms.draft.sync)
  @ActionLog({ domain: 'wxoa.draft', verb: 'sync' })
  @ApiEnvelope()
  pull(@Body({ schema: zAccount }) dto: { accountId: number }) {
    return this.service.pull(dto.accountId)
  }
}
