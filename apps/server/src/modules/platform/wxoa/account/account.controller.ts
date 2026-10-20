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
  pageVo,
  WXOA_BROWSE_PERMS,
  type WxoaAccountCreate,
  type WxoaAccountDetailVo,
  type WxoaAccountQuery,
  type WxoaAccountUpdate,
  wxoaAccountCreate,
  wxoaAccountDetailVo,
  wxoaAccountOptionVo,
  wxoaAccountQuery,
  wxoaAccountTestVo,
  wxoaAccountUpdate,
  wxoaAccountVo,
  wxoaPerms,
  wxoaQuotaVo,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { Sensitive } from '../../../../core/redact.js'
import { ApiWxoa } from '../core/wxoa-swagger.js'
import { WxoaAccountService } from './account.service.js'

const perms = wxoaPerms.account
const domain = 'wxoa.account'
/** the write-only secrets of a create or update body */
const SECRETS = ['appSecret', 'token', 'aesKey']

/**
 * Official Accounts: the secrets are write-only (`has*` flags only), the AppID fixed once added; the
 * routes calling WeChat (test, quota) need the account enabled (`B6011`).
 */
@ApiWxoa()
@Controller('wxoa/accounts')
export class WxoaAccountController {
  constructor(private readonly accounts: WxoaAccountService) {}

  @Get()
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: 'Page of Official Accounts' })
  @ApiEnvelope(pageVo(wxoaAccountVo))
  page(@Query({ schema: wxoaAccountQuery }) query: WxoaAccountQuery) {
    return this.accounts.list(query)
  }

  @Get('options')
  @RequirePerm(...WXOA_BROWSE_PERMS)
  @ApiOperation({
    summary:
      'Live accounts for the account switch (any wxoa browse permission; disabled ones marked)',
  })
  @ApiEnvelope(z.array(wxoaAccountOptionVo))
  options() {
    return this.accounts.options()
  }

  @Get(':id')
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: 'One account: its callback path and which secrets are set' })
  @ApiEnvelope(wxoaAccountDetailVo)
  get(@Param('id', ParseIntPipe) id: number) {
    return this.accounts.detail(id)
  }

  @Post()
  @RequirePerm(perms.create)
  @Idempotent()
  @Sensitive(...SECRETS)
  @ActionLog({
    domain,
    verb: 'create',
    bizId: (_req, row) => (row as WxoaAccountDetailVo | undefined)?.id,
  })
  @ApiOperation({
    summary:
      'Add an account (AppID taken → 409; compat or secure mode without an EncodingAESKey → B6008)',
  })
  @ApiEnvelope(wxoaAccountDetailVo, 201)
  create(@Body({ schema: wxoaAccountCreate }) dto: WxoaAccountCreate) {
    return this.accounts.add(dto)
  }

  @Put(':id')
  @RequirePerm(perms.modify)
  @Sensitive(...SECRETS)
  @ActionLog({ domain, verb: 'modify' })
  @ApiOperation({
    summary:
      'Change an account: fields sent are changed, an empty or absent secret is kept, an appId → 400',
  })
  @ApiEnvelope()
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wxoaAccountUpdate }) dto: WxoaAccountUpdate,
  ) {
    return this.accounts.change(id, dto)
  }

  @Delete(':id')
  @RequirePerm(perms.remove)
  @ActionLog({ domain, verb: 'remove' })
  @ApiOperation({ summary: 'Delete an account (its fans and messages are kept)' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.accounts.drop(id)
  }

  @Post(':id/test')
  @HttpCode(200)
  @RequirePerm(perms.modify)
  @ActionLog({ domain, verb: 'test' })
  @ApiOperation({
    summary: 'Test the connection: a fresh access token, then an API call; failures are reported',
  })
  @ApiEnvelope(wxoaAccountTestVo)
  test(@Param('id', ParseIntPipe) id: number) {
    return this.accounts.test(id)
  }

  @Get(':id/quota')
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: "Today's quota of the APIs this module calls" })
  @ApiEnvelope(wxoaQuotaVo)
  quota(@Param('id', ParseIntPipe) id: number) {
    return this.accounts.quota(id)
  }

  @Post(':id/quota/clear')
  @HttpCode(200)
  @RequirePerm(perms['clear-quota'])
  @ActionLog({ domain, verb: 'clean' })
  @ApiOperation({
    summary: "Reset the account's API call counts (10 a month with the console's reset)",
  })
  @ApiEnvelope()
  clearQuota(@Param('id', ParseIntPipe) id: number) {
    return this.accounts.clearQuota(id)
  }
}
