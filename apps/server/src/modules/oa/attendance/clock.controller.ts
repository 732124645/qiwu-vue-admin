import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  clockPunch,
  clockMyQuery,
  clockRecordVo,
  clockTodayVo,
  pageVo,
  type ClockPunch,
  type ClockMyQuery,
} from '@qiwu/shared'
import { ActionLog } from '../../../core/audit/action-log.js'
import { RequireFeature } from '../../../core/auth/tenant-scope.js'
import { Idempotent } from '../../../core/guard/idempotent.js'
import { RateLimit } from '../../../core/guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { Sensitive } from '../../../core/redact.js'
import { ClockService } from './clock.service.js'

@ApiTags('oa')
@RequireFeature('oa')
@Sensitive('position', 'latitude', 'longitude')
@Controller('oa/clock-records')
export class ClockController {
  constructor(private readonly clocks: ClockService) {}

  /** 登录员工只能记录本人动作，位置只用于当前校验，审计与 HTTP 日志均掩码。 */
  @Post('punch')
  @Idempotent()
  @RateLimit(20, 60_000, 'user')
  @ActionLog({
    domain: 'oa.clock',
    verb: 'punch',
    bizId: (_req, result) => (result as { id?: number })?.id,
  })
  @ApiOperation({ summary: 'Punch the signed-in employee using server time' })
  @ApiEnvelope(clockRecordVo, 201)
  punch(@Body({ schema: clockPunch }) dto: ClockPunch) {
    return this.clocks.punch(dto)
  }

  @Get('today')
  @ApiOperation({ summary: 'Server time, attendance policy summary and my punches today' })
  @ApiEnvelope(clockTodayVo)
  today() {
    return this.clocks.today()
  }

  @Get('requests/:requestId')
  @ApiOperation({ summary: 'My durable punch result by request identifier' })
  @ApiEnvelope(clockRecordVo)
  request(@Param('requestId') requestId: string) {
    return this.clocks.request(requestId)
  }

  @Get('mine')
  @ApiOperation({ summary: 'Page of my punches, filtered by work date and action' })
  @ApiEnvelope(pageVo(clockRecordVo))
  mine(@Query({ schema: clockMyQuery }) query: ClockMyQuery) {
    return this.clocks.mine(query)
  }
}
