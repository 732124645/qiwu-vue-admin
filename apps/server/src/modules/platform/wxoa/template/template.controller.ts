import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common'
import { ApiOperation } from '@nestjs/swagger'
import {
  type WxoaAccountScope,
  type WxoaTemplateListQuery,
  type WxoaTemplateSendBody,
  wxoaAccountScope,
  wxoaIndustryVo,
  wxoaMessageVo,
  wxoaPerms,
  wxoaTemplateListQuery,
  wxoaTemplateSendBody,
  wxoaTemplateVo,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import type { Principal } from '../../../../core/auth/principal.js'
import { clsGet } from '../../../../core/context/cls.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { ApiWxoa } from '../core/wxoa-swagger.js'
import { WxoaTemplateService } from './template.service.js'

const perms = wxoaPerms.template
const domain = 'wxoa.template'
const me = (): Principal => clsGet('principal')!

/**
 * Template messages of an account (templates live on WeChat; the send records are
 * `GET /messages?channel=template`); 404 for a missing or deleted account, `B6011` for a disabled one.
 */
@ApiWxoa()
@Controller('wxoa/templates')
export class WxoaTemplateController {
  constructor(private readonly templates: WxoaTemplateService) {}

  @Get()
  @RequirePerm(perms.browse)
  @ApiOperation({
    summary: "The account's templates from WeChat (cached 10 minutes; refresh=true asks again)",
  })
  @ApiEnvelope(z.array(wxoaTemplateVo))
  list(@Query({ schema: wxoaTemplateListQuery }) query: WxoaTemplateListQuery) {
    return this.templates.list(query.accountId, query.refresh)
  }

  @Get('industry')
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: "The account's industries on WeChat (read only)" })
  @ApiEnvelope(wxoaIndustryVo)
  industry(@Query({ schema: wxoaAccountScope }) { accountId }: WxoaAccountScope) {
    return this.templates.industry(accountId)
  }

  @Delete(':templateId')
  @RequirePerm(perms.remove)
  @ActionLog({ domain, verb: 'remove', bizId: (req) => req.params.templateId })
  @ApiOperation({ summary: "Delete one of the account's templates on WeChat (not its own → 404)" })
  @ApiEnvelope()
  remove(
    @Param('templateId') templateId: string,
    @Query({ schema: wxoaAccountScope }) { accountId }: WxoaAccountScope,
  ) {
    return this.templates.drop(accountId, templateId)
  }

  @Post(':templateId/send')
  @RequirePerm(perms.send)
  @Idempotent()
  @ActionLog({ domain, verb: 'send', bizId: (req) => req.params.templateId })
  @ApiOperation({
    summary:
      "Send a template message to at most 100 of the account's fans: one pending row each, sent after the response (a template or fan not the account's → 404; a data key the template lacks → 400)",
  })
  @ApiEnvelope(z.array(wxoaMessageVo), 201)
  send(
    @Param('templateId') templateId: string,
    @Body({ schema: wxoaTemplateSendBody }) dto: WxoaTemplateSendBody,
  ) {
    return this.templates.send(templateId, dto, me().userId)
  }
}
