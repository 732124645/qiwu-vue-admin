import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common'
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  DEFAULT_PASSWORD_POLICY,
  type SmsCodeBody,
  smsCodeBody,
  type SmsCodeVo,
  smsCodeVo,
  type SmsLoginBody,
  smsLoginBody,
  smsResetPasswordBody,
  type TokenPayload,
} from '@qiwu/shared'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { ActionLog, SkipActionLog } from '../../../../core/audit/action-log.js'
import { answerWithTokens, clientOf, tokenPayload } from '../../../../core/auth/auth.controller.js'
import { plainIp } from '../../../../core/auth/auth-params.js'
import { Public } from '../../../../core/auth/decorators.js'
import { AppConfigService } from '../../../../core/config/config.module.js'
import { RateLimit } from '../../../../core/guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { timezoneOf } from '../../../../core/i18n/locale.js'
import { SmsAuthService } from './sms-auth.service.js'
import { OtpService } from './sms-otp.service.js'

@ApiTags('auth')
@Controller('auth')
export class SmsOtpController {
  constructor(
    private readonly otp: OtpService,
    private readonly smsAuth: SmsAuthService,
    private readonly cfg: AppConfigService,
  ) {}

  @Public()
  // Anonymous requests have no actor for an action log; OTP limits and SMS records provide the trail.
  @SkipActionLog()
  @RateLimit(10, 60_000)
  @Post('sms/code')
  @HttpCode(200)
  @ApiOperation({ summary: 'Request a single-use SMS verification code' })
  @ApiEnvelope(smsCodeVo)
  code(@Body({ schema: smsCodeBody }) body: SmsCodeBody, @Req() req: Request): Promise<SmsCodeVo> {
    return this.otp.issue(body, plainIp(req.ip))
  }

  @Public()
  @SkipActionLog()
  @RateLimit(20, 60_000)
  @Post('sms/login')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Sign in with a single-use SMS code and set the refresh cookie (clientId mobile: returns the refresh token instead)',
  })
  @ApiEnvelope(tokenPayload)
  async login(
    @Body({ schema: smsLoginBody }) body: SmsLoginBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenPayload> {
    const tokens = await this.smsAuth.login(body, clientOf(req), timezoneOf(req.get('x-timezone')))
    return answerWithTokens(res, this.cfg, tokens, body.keepSignedIn ?? false, body.clientId)
  }

  @Public()
  @ActionLog({ domain: 'iam.user', verb: 'reset-password-sms' })
  @RateLimit(10, 60_000)
  @Post('password/reset-by-sms')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reset password with a single-use SMS code and revoke old sessions' })
  @ApiBody({
    schema: z.toJSONSchema(smsResetPasswordBody(DEFAULT_PASSWORD_POLICY), {
      target: 'openapi-3.0',
      unrepresentable: 'any',
    }) as object,
  })
  @ApiEnvelope()
  async resetPassword(@Body() body: unknown, @Req() req: Request): Promise<null> {
    await this.smsAuth.resetPassword(body, plainIp(req.ip))
    return null
  }
}
