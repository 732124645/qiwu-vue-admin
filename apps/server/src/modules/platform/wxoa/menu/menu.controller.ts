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
  type WxoaMenuCreate,
  type WxoaMenuTryMatchBody,
  type WxoaMenuUpdate,
  type WxoaMenuVo,
  wxoaAccountRef,
  wxoaAccountScope,
  wxoaMenuCreate,
  wxoaMenuPullResult,
  wxoaMenuTryMatchBody,
  wxoaMenuTryMatchVo,
  wxoaMenuUpdate,
  wxoaMenuVo,
  wxoaPerms,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog, SkipActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { ApiWxoa } from '../core/wxoa-swagger.js'
import { WxoaMenuService } from './menu.service.js'

const perms = wxoaPerms.menu
const domain = 'wxoa.menu'

/** Custom menus of an account; 404 for a missing or deleted account, `B6011` for a disabled one. */
@ApiWxoa()
@Controller('wxoa/menus')
export class WxoaMenuController {
  constructor(private readonly menus: WxoaMenuService) {}

  @Get()
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: "An account's menus, the default one first" })
  @ApiEnvelope(z.array(wxoaMenuVo))
  list(@Query({ schema: wxoaAccountScope }) { accountId }: WxoaAccountScope) {
    return this.menus.list(accountId)
  }

  @Post('pull')
  @HttpCode(200)
  @RequirePerm(perms.modify)
  @ActionLog({ domain, verb: 'sync' })
  @ApiOperation({
    summary:
      "Overwrite the account's local menus with the ones on WeChat (conditional ones it cannot keep are listed)",
  })
  @ApiEnvelope(wxoaMenuPullResult)
  pull(@Body({ schema: wxoaAccountRef }) { accountId }: WxoaAccountRef) {
    return this.menus.pull(accountId)
  }

  @Post('clear')
  @HttpCode(200)
  @RequirePerm(perms.publish)
  @ActionLog({ domain, verb: 'clean' })
  @ApiOperation({
    summary: "Remove the account's menus on WeChat, conditional ones included (drafts stay)",
  })
  @ApiEnvelope()
  clear(@Body({ schema: wxoaAccountRef }) { accountId }: WxoaAccountRef) {
    return this.menus.clear(accountId)
  }

  @Post('try-match')
  @HttpCode(200)
  @RequirePerm(perms.browse)
  @SkipActionLog()
  @ApiOperation({ summary: 'The menu WeChat shows a fan (openid or WeChat ID)' })
  @ApiEnvelope(wxoaMenuTryMatchVo)
  tryMatch(@Body({ schema: wxoaMenuTryMatchBody }) dto: WxoaMenuTryMatchBody) {
    return this.menus.tryMatch(dto)
  }

  @Get(':id')
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: 'One menu' })
  @ApiEnvelope(wxoaMenuVo)
  get(@Param('id', ParseIntPipe) id: number) {
    return this.menus.one(id)
  }

  @Post()
  @RequirePerm(perms.modify)
  @Idempotent()
  @ActionLog({ domain, verb: 'create', bizId: (_req, row) => (row as WxoaMenuVo | undefined)?.id })
  @ApiOperation({
    summary: 'Add a menu draft (a second default menu of the account → 409)',
  })
  @ApiEnvelope(wxoaMenuVo, 201)
  create(@Body({ schema: wxoaMenuCreate }) dto: WxoaMenuCreate) {
    return this.menus.add(dto)
  }

  @Put(':id')
  @RequirePerm(perms.modify)
  @ActionLog({ domain, verb: 'modify' })
  @ApiOperation({
    summary:
      'Change a menu draft as a whole (match conditions by its kind; retired buttons kept or dropped only)',
  })
  @ApiEnvelope()
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wxoaMenuUpdate }) dto: WxoaMenuUpdate,
  ) {
    return this.menus.change(id, dto)
  }

  @Delete(':id')
  @RequirePerm(perms.modify)
  @ActionLog({ domain, verb: 'remove' })
  @ApiOperation({
    summary:
      'Delete a menu (a published conditional one on WeChat too, which needs the publish permission as well)',
  })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.menus.drop(id)
  }

  @Post(':id/publish')
  @HttpCode(200)
  @RequirePerm(perms.publish)
  @ActionLog({ domain, verb: 'publish' })
  @ApiOperation({
    summary:
      'Publish a menu to WeChat (a conditional one needs the default menu published → else B6009)',
  })
  @ApiEnvelope(wxoaMenuVo)
  publish(@Param('id', ParseIntPipe) id: number) {
    return this.menus.publish(id)
  }
}
