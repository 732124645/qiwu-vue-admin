import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  imCallAction,
  imCallCreate,
  type ImCallCreate,
  imCallGrantVo,
  imCallVo,
  imPathId,
} from '@qiwu/shared'
import { z } from 'zod'
import { SkipActionLog } from '../../../core/audit/action-log.js'
import { SkipHttpTrace } from '../../../core/audit/http-trace.js'
import { HomeTenant, RequireFeature } from '../../../core/auth/tenant-scope.js'
import { clsGet } from '../../../core/context/cls.js'
import { Idempotent } from '../../../core/guard/idempotent.js'
import { RateLimit } from '../../../core/guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { Sensitive } from '../../../core/redact.js'
import { ImCallsService } from './im-calls.service.js'
import { ImStaffGuard } from './im-staff.guard.js'

const actor = () => clsGet('principal')!

/** 员工自己的房间通话；没有媒体管理端口，票据和状态正文均不进入访问追踪。 */
@ApiTags('im')
@Controller('im')
@HomeTenant()
@RequireFeature('im')
@UseGuards(ImStaffGuard)
@Sensitive('token', 'url')
export class ImCallsController {
  constructor(private readonly calls: ImCallsService) {}

  @Get('calls/active')
  @SkipHttpTrace()
  @RateLimit(120, 60_000, 'user')
  @ApiOperation({
    summary: 'Own current invited or joined calls, within the original room membership period',
  })
  @ApiEnvelope(z.array(imCallVo))
  active() {
    return this.calls.active(actor())
  }

  @Get('calls/:id')
  @SkipHttpTrace()
  @RateLimit(120, 60_000, 'user')
  @ApiOperation({ summary: 'Read an invited call and the current session action capabilities' })
  @ApiEnvelope(imCallVo)
  get(@Param('id', { schema: imPathId }) id: number) {
    return this.calls.get(id, actor())
  }

  @Post('rooms/:id/calls')
  @Idempotent()
  @SkipActionLog()
  @SkipHttpTrace()
  @RateLimit(10, 60_000, 'user')
  @ApiOperation({
    summary: 'Create one foreground call in the current room; an unresolved call keeps its slot',
  })
  @ApiEnvelope(imCallVo, 201)
  create(
    @Param('id', { schema: imPathId }) id: number,
    @Body({ schema: imCallCreate }) body: ImCallCreate,
  ) {
    return this.calls.create(id, body, actor())
  }

  @Post('calls/:id/accept')
  @HttpCode(200)
  @Idempotent()
  @SkipActionLog()
  @SkipHttpTrace()
  @RateLimit(30, 60_000, 'user')
  @ApiOperation({
    summary:
      'Accept an invitation with the first live session, or rejoin with the original group session',
  })
  @ApiEnvelope(imCallVo)
  accept(
    @Param('id', { schema: imPathId }) id: number,
    @Body({ schema: imCallAction }) _body: object,
  ) {
    return this.calls.act(id, 'accept', actor())
  }

  @Post('calls/:id/decline')
  @HttpCode(200)
  @SkipActionLog()
  @SkipHttpTrace()
  @RateLimit(30, 60_000, 'user')
  @ApiOperation({ summary: 'Decline only an invitation that has not been accepted' })
  @ApiEnvelope(imCallVo)
  decline(
    @Param('id', { schema: imPathId }) id: number,
    @Body({ schema: imCallAction }) _body: object,
  ) {
    return this.calls.act(id, 'decline', actor())
  }

  @Post('calls/:id/join')
  @HttpCode(200)
  @SkipActionLog()
  @SkipHttpTrace()
  @RateLimit(30, 60_000, 'user')
  @ApiOperation({
    summary: 'Issue a 60-second scoped microphone/camera grant to the accepted bound session',
  })
  @ApiEnvelope(imCallGrantVo)
  join(
    @Param('id', { schema: imPathId }) id: number,
    @Body({ schema: imCallAction }) _body: object,
  ) {
    return this.calls.join(id, actor())
  }

  @Post('calls/:id/leave')
  @HttpCode(200)
  @SkipActionLog()
  @SkipHttpTrace()
  @RateLimit(30, 60_000, 'user')
  @ApiOperation({
    summary: 'Leave with the bound session; caller or direct-call leave ends the whole call',
  })
  @ApiEnvelope(imCallVo)
  leave(
    @Param('id', { schema: imPathId }) id: number,
    @Body({ schema: imCallAction }) _body: object,
  ) {
    return this.calls.act(id, 'leave', actor())
  }

  @Post('calls/:id/end')
  @HttpCode(200)
  @SkipActionLog()
  @SkipHttpTrace()
  @RateLimit(30, 60_000, 'user')
  @ApiOperation({ summary: 'End a call using only the caller bound session' })
  @ApiEnvelope(imCallVo)
  end(
    @Param('id', { schema: imPathId }) id: number,
    @Body({ schema: imCallAction }) _body: object,
  ) {
    return this.calls.act(id, 'end', actor())
  }

  @Post('calls/:id/heartbeat')
  @HttpCode(200)
  @SkipActionLog()
  @SkipHttpTrace()
  @RateLimit(120, 60_000, 'user')
  @ApiOperation({
    summary: 'Keep an accepted original session alive without implicitly accepting or rejoining',
  })
  @ApiEnvelope(imCallVo)
  heartbeat(
    @Param('id', { schema: imPathId }) id: number,
    @Body({ schema: imCallAction }) _body: object,
  ) {
    return this.calls.act(id, 'heartbeat', actor())
  }
}
