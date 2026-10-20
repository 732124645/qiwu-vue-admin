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
import { ApiOperation } from '@nestjs/swagger'
import {
  pageVo,
  type WxoaQrcodeCreate,
  type WxoaQrcodeQuery,
  type WxoaQrcodeStatsQuery,
  type WxoaQrcodeUpdate,
  wxoaPerms,
  wxoaQrcodeCreate,
  wxoaQrcodeQuery,
  wxoaQrcodeStatsQuery,
  wxoaQrcodeStatsVo,
  wxoaQrcodeUpdate,
  wxoaQrcodeVo,
} from '@qiwu/shared'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import type { WxoaQrcode } from '../core/wxoa.entity.js'
import { ApiWxoa } from '../core/wxoa-swagger.js'
import { WxoaQrcodeService } from './qrcode.service.js'

const perms = wxoaPerms.qrcode
const domain = 'wxoa.qrcode'

/**
 * Channel QR codes of an account; 404 for a missing or deleted account, `B6011` for a disabled one, 404
 * for a tag not the account's.
 */
@ApiWxoa()
@Controller('wxoa/qrcodes')
export class WxoaQrcodeController {
  constructor(private readonly qrcodes: WxoaQrcodeService) {}

  @Get()
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: "Page of an account's channel QR codes" })
  @ApiEnvelope(pageVo(wxoaQrcodeVo))
  page(@Query({ schema: wxoaQrcodeQuery }) query: WxoaQrcodeQuery) {
    return this.qrcodes.list(query)
  }

  @Post()
  @RequirePerm(perms.create)
  @Idempotent()
  @ActionLog({ domain, verb: 'create', bizId: (_req, row) => (row as WxoaQrcode)?.id })
  @ApiOperation({
    summary:
      'Create a QR code on WeChat (string scene, temporary or permanent, optional auto tag) and copy its image; a scene the account uses → 409',
  })
  @ApiEnvelope(wxoaQrcodeVo, 201)
  create(@Body({ schema: wxoaQrcodeCreate }) dto: WxoaQrcodeCreate) {
    return this.qrcodes.add(dto)
  }

  @Put(':id')
  @RequirePerm(perms.modify)
  @ActionLog({ domain, verb: 'modify' })
  @ApiOperation({ summary: 'Change the name and the auto tag of a QR code' })
  @ApiEnvelope()
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wxoaQrcodeUpdate }) dto: WxoaQrcodeUpdate,
  ) {
    return this.qrcodes.change(id, dto)
  }

  @Delete(':id')
  @RequirePerm(perms.remove)
  @ActionLog({ domain, verb: 'remove' })
  @ApiOperation({
    summary: 'Delete a QR code here only (a permanent one keeps working on WeChat)',
  })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.qrcodes.drop(id)
  }

  @Get(':id/stats')
  @RequirePerm(perms.browse)
  @ApiOperation({
    summary: "Scans and subscribes through a QR code per day (the request's time zone, ≤ 90 days)",
  })
  @ApiEnvelope(wxoaQrcodeStatsVo)
  stats(
    @Param('id', ParseIntPipe) id: number,
    @Query({ schema: wxoaQrcodeStatsQuery }) { days }: WxoaQrcodeStatsQuery,
  ) {
    return this.qrcodes.stats(id, days)
  }
}
