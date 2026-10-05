import { Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  Err,
  inboxUnreadVo,
  myInboxItemVo,
  type MyInboxQuery,
  myInboxQuery,
  pageVo,
} from '@qiwu/shared'
import { SkipActionLog } from '../../../../core/audit/action-log.js'
import { clsGet } from '../../../../core/context/cls.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { MyInboxService } from './my-inbox.service.js'

function myId(): number {
  const principal = clsGet('principal')
  if (!principal) throw new BizError(Err.UNAUTHENTICATED)
  return principal.userId
}

@ApiTags('messaging')
@Controller('messaging/inboxes/mine')
export class MyInboxController {
  constructor(private readonly inbox: MyInboxService) {}

  @Get()
  @ApiOperation({ summary: 'My inbox, newest first' })
  @ApiEnvelope(pageVo(myInboxItemVo))
  page(@Query({ schema: myInboxQuery }) query: MyInboxQuery) {
    return this.inbox.page(myId(), query)
  }

  @Get('unread')
  @ApiOperation({ summary: 'My unread message count' })
  @ApiEnvelope(inboxUnreadVo)
  unread() {
    return this.inbox.unread(myId())
  }

  @Post('read-all')
  @HttpCode(200)
  @SkipActionLog()
  @ApiOperation({ summary: 'Mark all my messages read' })
  @ApiEnvelope(inboxUnreadVo)
  readAll() {
    return this.inbox.readAll(myId())
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of my messages without marking it read' })
  @ApiEnvelope(myInboxItemVo)
  get(@Param('id', ParseIntPipe) id: number) {
    return this.inbox.get(myId(), id)
  }

  @Post(':id/read')
  @HttpCode(200)
  @SkipActionLog()
  @ApiOperation({ summary: 'Mark one of my messages read' })
  @ApiEnvelope(inboxUnreadVo)
  read(@Param('id', ParseIntPipe) id: number) {
    return this.inbox.read(myId(), id)
  }
}
