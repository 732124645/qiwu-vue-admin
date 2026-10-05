import { Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { bulletinFeedDetailVo, bulletinFeedVo, bulletinUnreadVo, Err } from '@qiwu/shared'
import { SkipActionLog } from '../../../../core/audit/action-log.js'
import { SkipHttpTrace } from '../../../../core/audit/http-trace.js'
import { clsGet } from '../../../../core/context/cls.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { BulletinFeedService } from './bulletin-feed.service.js'

/** The signed-in caller's id: receipts are only ever the caller's own. */
function myId(): number {
  const p = clsGet('principal')
  if (!p) throw new BizError(Err.UNAUTHENTICATED)
  return p.userId
}

/**
 * Bulletins for readers (the header bell, 通知公告): any signed-in user, no `@RequirePerm`.
 * Registered before BulletinController, so `/feed` is never taken for its `/:id`. Marking read changes
 * only the caller's own receipts: not action-logged (`@SkipActionLog`), like reading itself. The GETs are
 * the bell's polls and every open of a bulletin: `@SkipHttpTrace`, never in the access log (mode `all`).
 */
@ApiTags('messaging')
@Controller('messaging/bulletins/feed')
export class BulletinFeedController {
  constructor(private readonly feed: BulletinFeedService) {}

  @Get()
  @SkipHttpTrace()
  @ApiOperation({ summary: 'Latest published bulletins and the unread count' })
  @ApiEnvelope(bulletinFeedVo)
  list() {
    return this.feed.feed(myId())
  }

  @Post('read-all')
  @HttpCode(200)
  @SkipActionLog()
  @ApiOperation({ summary: 'Mark every published bulletin read' })
  @ApiEnvelope(bulletinUnreadVo)
  async readAll() {
    return { unread: await this.feed.readAll(myId()) }
  }

  @Get(':id')
  @SkipHttpTrace()
  @ApiOperation({ summary: 'One published bulletin with its body' })
  @ApiEnvelope(bulletinFeedDetailVo)
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.feed.detail(id, myId())
  }

  @Post(':id/read')
  @HttpCode(200)
  @SkipActionLog()
  @ApiOperation({ summary: 'Mark one published bulletin read' })
  @ApiEnvelope(bulletinUnreadVo)
  async read(@Param('id', ParseIntPipe) id: number) {
    return { unread: await this.feed.read(id, myId()) }
  }
}
