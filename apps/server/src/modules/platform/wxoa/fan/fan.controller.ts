import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common'
import { ApiOperation, ApiProduces } from '@nestjs/swagger'
import {
  pageVo,
  type WxoaAccountRef,
  type WxoaAccountScope,
  type WxoaFanBlockingBody,
  type WxoaFanQuery,
  type WxoaFanRemarkBody,
  type WxoaFanTaggingBody,
  wxoaAccountRef,
  wxoaAccountScope,
  wxoaFanBlockingBody,
  wxoaFanQuery,
  wxoaFanRemarkBody,
  wxoaFanTaggingBody,
  wxoaFanVo,
  wxoaPerms,
  wxoaSyncVo,
} from '@qiwu/shared'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { ExcelService, XLSX_TYPE } from '../../../../core/excel/excel.service.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { ApiWxoa } from '../core/wxoa-swagger.js'
import { wxoaFanColumns, WxoaFanService } from './fan.service.js'

const perms = wxoaPerms.fan
const domain = 'wxoa.fan'

/** Fans of an account; 404 for a missing or deleted account, `B6011` for a disabled one. */
@ApiWxoa()
@Controller('wxoa/fans')
export class WxoaFanController {
  constructor(
    private readonly fans: WxoaFanService,
    private readonly excel: ExcelService,
  ) {}

  @Get()
  @RequirePerm(perms.browse)
  @ApiOperation({
    summary: "Page of an account's fans (by subscription, blacklist, tag, openid, remark)",
  })
  @ApiEnvelope(pageVo(wxoaFanVo))
  page(@Query({ schema: wxoaFanQuery }) query: WxoaFanQuery) {
    return this.fans.list(query)
  }

  /** The list's rows (same filters and sort, no paging) as .xlsx. */
  @Get('export')
  @RequirePerm(perms.export)
  @ActionLog({ domain, verb: 'export' })
  @ApiOperation({ summary: 'Export the filtered fans (.xlsx)' })
  @ApiProduces(XLSX_TYPE)
  export(@Query({ schema: wxoaFanQuery }) query: WxoaFanQuery) {
    return this.excel.export('fans', wxoaFanColumns, this.fans.exportFans(query))
  }

  @Get('sync')
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: "Progress of the account's last fan sync" })
  @ApiEnvelope(wxoaSyncVo)
  syncProgress(@Query({ schema: wxoaAccountScope }) { accountId }: WxoaAccountScope) {
    return this.fans.syncProgress(accountId)
  }

  @Post('sync')
  @RequirePerm(perms.sync)
  @ActionLog({ domain, verb: 'sync' })
  @ApiOperation({
    summary:
      "Start a full sync of the account's fans and blacklist from WeChat (one running already → 409)",
  })
  @ApiEnvelope(wxoaSyncVo, 201)
  sync(@Body({ schema: wxoaAccountRef }) { accountId }: WxoaAccountRef) {
    return this.fans.startSync(accountId)
  }

  @Post('tagging')
  @HttpCode(200)
  @RequirePerm(perms.modify)
  @ActionLog({ domain, verb: 'modify' })
  @ApiOperation({
    summary: 'Put a tag on (or take it off) fans of the account, on WeChat and here',
  })
  @ApiEnvelope()
  tagging(@Body({ schema: wxoaFanTaggingBody }) dto: WxoaFanTaggingBody) {
    return this.fans.tagging(dto)
  }

  @Post('blocking')
  @HttpCode(200)
  @RequirePerm(perms.modify)
  @ActionLog({ domain, verb: 'modify' })
  @ApiOperation({ summary: 'Blacklist fans of the account (or free them), on WeChat and here' })
  @ApiEnvelope()
  blocking(@Body({ schema: wxoaFanBlockingBody }) dto: WxoaFanBlockingBody) {
    return this.fans.blocking(dto)
  }

  @Get(':id')
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: 'One fan' })
  @ApiEnvelope(wxoaFanVo)
  get(@Param('id', ParseIntPipe) id: number) {
    return this.fans.one(id)
  }

  @Put(':id/remark')
  @RequirePerm(perms.modify)
  @ActionLog({ domain, verb: 'modify' })
  @ApiOperation({ summary: "Set the fan's remark on WeChat and here ('' clears it)" })
  @ApiEnvelope()
  remark(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wxoaFanRemarkBody }) { remark }: WxoaFanRemarkBody,
  ) {
    return this.fans.remark(id, remark)
  }
}
