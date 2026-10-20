import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common'
import { ApiOperation } from '@nestjs/swagger'
import {
  type WxoaAccountRef,
  type WxoaAccountScope,
  type WxoaTagCreate,
  type WxoaTagUpdate,
  type WxoaTagVo,
  wxoaAccountRef,
  wxoaAccountScope,
  wxoaPerms,
  wxoaTagCreate,
  wxoaTagUpdate,
  wxoaTagVo,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { ApiWxoa } from '../core/wxoa-swagger.js'
import { WxoaTagService } from './tag.service.js'

const perms = wxoaPerms.tag
const domain = 'wxoa.tag'

/** Fan tags of an account; 404 for a missing or deleted account, `B6011` for a disabled one. */
@ApiWxoa()
@Controller('wxoa/tags')
export class WxoaTagController {
  constructor(private readonly tags: WxoaTagService) {}

  @Get()
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: "All of an account's tags" })
  @ApiEnvelope(z.array(wxoaTagVo))
  list(@Query({ schema: wxoaAccountScope }) { accountId }: WxoaAccountScope) {
    return this.tags.list(accountId)
  }

  @Post('sync')
  @HttpCode(200)
  // the fan page's sync permission covers the tags
  @RequirePerm(wxoaPerms.fan.sync)
  @ActionLog({ domain, verb: 'sync' })
  @ApiOperation({ summary: "Replace the account's tags with the ones on WeChat" })
  @ApiEnvelope(z.array(wxoaTagVo))
  sync(@Body({ schema: wxoaAccountRef }) { accountId }: WxoaAccountRef) {
    return this.tags.sync(accountId)
  }

  @Post()
  @RequirePerm(perms.create)
  @Idempotent()
  @ActionLog({ domain, verb: 'create', bizId: (_req, row) => (row as WxoaTagVo | undefined)?.id })
  @ApiOperation({ summary: 'Add a tag on WeChat and here (100 per account → 422)' })
  @ApiEnvelope(wxoaTagVo, 201)
  create(@Body({ schema: wxoaTagCreate }) dto: WxoaTagCreate) {
    return this.tags.add(dto)
  }

  @Put(':id')
  @RequirePerm(perms.modify)
  @ActionLog({ domain, verb: 'modify' })
  @ApiOperation({ summary: "Rename a tag on WeChat and here (WeChat's reserved tags → 422)" })
  @ApiEnvelope()
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wxoaTagUpdate }) dto: WxoaTagUpdate,
  ) {
    return this.tags.change(id, dto.name)
  }

  @Delete(':id')
  @RequirePerm(perms.remove)
  @ActionLog({ domain, verb: 'remove' })
  @ApiOperation({
    summary: "Delete a tag on WeChat and here, its fans losing it (WeChat's reserved tags → 422)",
  })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.tags.drop(id)
  }
}
