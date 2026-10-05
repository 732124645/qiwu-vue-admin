import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  captchaChallengeVo,
  captchaCheckBody,
  captchaQuery,
  captchaTicketVo,
  type CaptchaCheckBody,
  type CaptchaChallengeVo,
  type CaptchaQuery,
  type CaptchaTicketVo,
} from '@qiwu/shared'
import type { Request } from 'express'
import { SkipActionLog } from '../audit/action-log.js'
import { clientOf } from '../auth/auth.controller.js'
import { Public } from '../auth/decorators.js'
import { RateLimit } from '../guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../http/api-envelope.decorator.js'
import { CaptchaService } from './captcha.service.js'

/** Public challenge and GETDEL check endpoints; tickets are single-use, scene/IP-bound and valid for 120 s. */
@ApiTags('auth')
@Controller('auth')
export class CaptchaController {
  constructor(private readonly captcha: CaptchaService) {}

  @Public()
  @RateLimit(30, 60_000)
  @Get('captcha')
  @ApiOperation({
    summary: 'Get a single-use captcha challenge for a scene (image kind: format=png for a PNG)',
  })
  @ApiEnvelope(captchaChallengeVo)
  challenge(@Query({ schema: captchaQuery }) query: CaptchaQuery): Promise<CaptchaChallengeVo> {
    return this.captcha.challenge(query.scene, query.format)
  }

  @Public()
  @SkipActionLog()
  @RateLimit(30, 60_000)
  @Post('captcha/check')
  @HttpCode(200)
  @ApiOperation({ summary: 'Consume a captcha challenge and issue a single-use ticket' })
  @ApiEnvelope(captchaTicketVo)
  check(
    @Body({ schema: captchaCheckBody }) body: CaptchaCheckBody,
    @Req() req: Request,
  ): Promise<CaptchaTicketVo> {
    return this.captcha.check(body, clientOf(req).ip)
  }
}
