import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  type DemoRealtimeSendBody,
  demoRealtimePerms,
  demoRealtimeSendBody,
  demoRealtimeSendVo,
} from '@qiwu/shared'
import { ActionLog } from '../../../core/audit/action-log.js'
import { RequirePerm } from '../../../core/auth/decorators.js'
import { Idempotent } from '../../../core/guard/idempotent.js'
import { RateLimit } from '../../../core/guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { DemoRealtimeService } from './realtime.service.js'

@ApiTags('demo')
@Controller('demo/realtime')
export class DemoRealtimeController {
  constructor(private readonly demo: DemoRealtimeService) {}

  @Post('send')
  @HttpCode(200)
  @RequirePerm(demoRealtimePerms.send)
  @RateLimit(30, 60_000)
  @Idempotent()
  @ActionLog({ domain: 'demo.realtime', verb: 'send' })
  @ApiOperation({
    summary:
      'Push plain text as `demo:message` to users, roles (enabled users in scope) or everyone (`demo.realtime.broadcast`)',
  })
  @ApiEnvelope(demoRealtimeSendVo)
  send(@Body({ schema: demoRealtimeSendBody }) body: DemoRealtimeSendBody) {
    return this.demo.send(body)
  }
}
