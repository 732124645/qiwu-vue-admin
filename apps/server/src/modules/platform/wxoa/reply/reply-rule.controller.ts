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
  type WxoaReplyRuleCreate,
  wxoaPerms,
  type WxoaReplyRuleQuery,
  type WxoaReplyRuleUpdate,
  wxoaReplyRuleCreate,
  wxoaReplyRuleQuery,
  wxoaReplyRuleUpdate,
  wxoaReplyRuleVo,
} from '@qiwu/shared'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import type { WxoaReplyRule } from '../core/wxoa.entity.js'
import { ApiWxoa } from '../core/wxoa-swagger.js'
import { WxoaReplyRuleService } from './reply-rule.service.js'

const perms = wxoaPerms.reply
const domain = 'wxoa.reply'

/** Auto-reply rules of an account; 404 for a missing or deleted account, `B6011` for a disabled one. */
@ApiWxoa()
@Controller('wxoa/reply-rules')
export class WxoaReplyRuleController {
  constructor(private readonly rules: WxoaReplyRuleService) {}

  @Get()
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: "Page of an account's auto-reply rules" })
  @ApiEnvelope(pageVo(wxoaReplyRuleVo))
  page(@Query({ schema: wxoaReplyRuleQuery }) query: WxoaReplyRuleQuery) {
    return this.rules.list(query)
  }

  @Get(':id')
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: 'One auto-reply rule' })
  @ApiEnvelope(wxoaReplyRuleVo)
  get(@Param('id', ParseIntPipe) id: number) {
    return this.rules.one(id)
  }

  @Post()
  @RequirePerm(perms.create)
  @Idempotent()
  @ActionLog({ domain, verb: 'create', bizId: (_req, row) => (row as WxoaReplyRule)?.id })
  @ApiOperation({
    summary:
      'Add an auto-reply rule (500 per account, else 422; a second enabled subscribe or default rule, click key or scan scene → 409)',
  })
  @ApiEnvelope(wxoaReplyRuleVo, 201)
  create(@Body({ schema: wxoaReplyRuleCreate }) dto: WxoaReplyRuleCreate) {
    return this.rules.add(dto)
  }

  @Put(':id')
  @RequirePerm(perms.modify)
  @ActionLog({ domain, verb: 'modify' })
  @ApiOperation({ summary: 'Change an auto-reply rule as a whole (enabling it included)' })
  @ApiEnvelope()
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wxoaReplyRuleUpdate }) dto: WxoaReplyRuleUpdate,
  ) {
    return this.rules.change(id, dto)
  }

  @Delete(':id')
  @RequirePerm(perms.remove)
  @ActionLog({ domain, verb: 'remove' })
  @ApiOperation({ summary: 'Delete an auto-reply rule' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.rules.drop(id)
  }
}
