import { Body, Controller, Post, Req } from '@nestjs/common'
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger'
import { DEFAULT_PASSWORD_POLICY, Err, signupBody } from '@qiwu/shared'
import type { Request } from 'express'
import { z } from 'zod'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { plainIp } from '../../../../core/auth/auth-params.js'
import { AuthParams } from '../../../../core/auth/auth-params.js'
import { Public } from '../../../../core/auth/decorators.js'
import { CaptchaTicketVerifier } from '../../../../core/captcha/captcha-ticket.js'
import { CaptchaService } from '../../../../core/captcha/captcha.service.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { RateLimit } from '../../../../core/guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { requestLocale } from '../../../../core/i18n/locale.js'
import { SignupService } from './signup.service.js'

/**
 * Self sign-up `POST /api/auth/signup` (see docs/design-notes.md#auth-sessions): public, off unless `auth.signup.enabled`; the
 * body is checked against the current password policy, then a `signup` captcha ticket bound to the
 * caller's IP is required unless `captcha.mode` is off. Role and dept come only from the
 * `auth.signup.*` params (SignupService). Lives in iam: core never imports modules.
 */
@ApiTags('auth')
@Controller('auth')
export class SignupController {
  constructor(
    private readonly signupService: SignupService,
    private readonly authParams: AuthParams,
    private readonly captcha: CaptchaService,
    private readonly tickets: CaptchaTicketVerifier,
  ) {}

  @Public()
  @RateLimit(20, 60_000)
  @Idempotent()
  @ActionLog({ domain: 'iam.user', verb: 'signup' })
  @Post('signup')
  @ApiOperation({
    summary: 'Register with the current password policy and configured default role',
  })
  @ApiBody({
    schema: z.toJSONSchema(signupBody(DEFAULT_PASSWORD_POLICY), {
      target: 'openapi-3.0',
      unrepresentable: 'any',
    }) as object,
  })
  @ApiEnvelope(undefined, 201)
  async signup(@Body() body: unknown, @Req() req: Request): Promise<null> {
    if (!(await this.authParams.signup()).enabled) throw new BizError(Err.AUTH_SIGNUP_DISABLED)
    // the body first: a typo in the form must not spend the single-use captcha ticket
    const dto = await this.signupService.parse(body)
    if (
      (await this.captcha.mode()) !== 'off' &&
      !(await this.tickets.verify('signup', plainIp(req.ip), dto.captchaTicket))
    )
      throw new BizError(Err.AUTH_CAPTCHA_REQUIRED)
    await this.signupService.signup(dto, requestLocale(req))
    return null
  }
}
