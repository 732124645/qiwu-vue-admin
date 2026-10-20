import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common'
import { ApiOperation } from '@nestjs/swagger'
import {
  pageVo,
  type WxoaConversationQuery,
  type WxoaFanMessagesQuery,
  type WxoaMessageQuery,
  type WxoaMessageSend,
  type WxoaMessageVo,
  wxoaConversationQuery,
  wxoaFanMessagesQuery,
  wxoaFanVo,
  wxoaMessageQuery,
  wxoaMessageSend,
  wxoaMessageVo,
  wxoaPerms,
  wxoaSendWindowVo,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import type { Principal } from '../../../../core/auth/principal.js'
import { clsGet } from '../../../../core/context/cls.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { ApiWxoa } from '../core/wxoa-swagger.js'
import { WxoaMessageService } from './message.service.js'

const perms = wxoaPerms.message
const me = (): Principal => clsGet('principal')!

/** The message log of an account; 404 for a missing or deleted account, `B6011` for a disabled one. */
@ApiWxoa()
@Controller('wxoa/messages')
export class WxoaMessageController {
  constructor(private readonly messages: WxoaMessageService) {}

  @Get()
  @RequirePerm(perms.browse)
  @ApiOperation({
    summary: "Page of an account's messages, in and out (by fan, direction, channel, kind, time)",
  })
  @ApiEnvelope(pageVo(wxoaMessageVo))
  page(@Query({ schema: wxoaMessageQuery }) query: WxoaMessageQuery) {
    return this.messages.list(query)
  }

  @Post()
  @RequirePerm(perms.send)
  @Idempotent()
  @ActionLog({
    domain: 'wxoa.message',
    verb: 'send',
    bizId: (_req, row) => (row as WxoaMessageVo | undefined)?.id,
  })
  @ApiOperation({
    summary:
      "Send a customer-service message to one of the account's fans (a fan, material or object not the account's → 404; both send windows closed or WeChat refusing the window → B6007)",
  })
  @ApiEnvelope(wxoaMessageVo, 201)
  send(@Body({ schema: wxoaMessageSend }) dto: WxoaMessageSend) {
    return this.messages.send(dto, me().userId)
  }
}

/**
 * Conversations: the fans of an account by their last message, one fan's messages and its send windows
 * (read with `wxoa.message.browse`, which the chat page's role also needs besides `wxoa.message.send`).
 */
@ApiWxoa()
@Controller('wxoa/conversations')
export class WxoaConversationController {
  constructor(private readonly messages: WxoaMessageService) {}

  @Get()
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: "Page of an account's fans by their last message, newest first" })
  @ApiEnvelope(pageVo(wxoaFanVo))
  page(@Query({ schema: wxoaConversationQuery }) query: WxoaConversationQuery) {
    return this.messages.conversations(query)
  }

  @Get(':fanId/messages')
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: "One fan's messages, newest first, before beforeId (at most 50)" })
  @ApiEnvelope(z.array(wxoaMessageVo))
  fanMessages(
    @Param('fanId', ParseIntPipe) fanId: number,
    @Query({ schema: wxoaFanMessagesQuery }) query: WxoaFanMessagesQuery,
  ) {
    return this.messages.fanMessages(fanId, query)
  }

  @Get(':fanId/window')
  @RequirePerm(perms.browse)
  @ApiOperation({
    summary:
      "One fan's customer-service windows: when each ends and the messages sent since it opened",
  })
  @ApiEnvelope(wxoaSendWindowVo)
  window(@Param('fanId', ParseIntPipe) fanId: number) {
    return this.messages.window(fanId)
  }
}
