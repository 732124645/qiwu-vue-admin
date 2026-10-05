import { Body, Controller, Delete, Get, HttpCode, Post, Req, Res } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  socialBindingVo,
  type TokenPayload,
  type WxMpBindBody,
  wxMpBindBody,
  type WxMpLoginBody,
  wxMpLoginBody,
  type WxMpLoginVo,
  wxSubscribeVo,
  type WxSubscribeVo,
} from '@qiwu/shared'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { ActionLog, SkipActionLog } from '../../../../core/audit/action-log.js'
import { answerWithTokens, clientOf, tokenPayload } from '../../../../core/auth/auth.controller.js'
import { Public } from '../../../../core/auth/decorators.js'
import { MOBILE_CLIENT } from '../../../../core/auth/token.service.js'
import { AppConfigService } from '../../../../core/config/config.module.js'
import { clsGet } from '../../../../core/context/cls.js'
import { RateLimit } from '../../../../core/guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { timezoneOf } from '../../../../core/i18n/locale.js'
import { myId } from '../profile/profile.controller.js'
import { WxMpService } from './wx-mp.service.js'
import { WxSubscribeService } from './wx-subscribe.service.js'

const wxMpLoginVo = z.union([
  z.object({ tokens: tokenPayload }),
  z.object({ bindTicket: z.string().describe('single use, 5 minutes, this client IP only') }),
])

/**
 * WeChat mini program sign-in: always `mobile` sessions, refresh token in the body. Both
 * routes 404 while `auth.wx_mp.enabled` is off or no AppID/secret is configured (the own bindings below
 * do not: a user can see and remove one whatever the switch).
 */
@ApiTags('auth')
@Controller('auth/wx-mp')
export class WxMpAuthController {
  constructor(
    private readonly wxMp: WxMpService,
    private readonly cfg: AppConfigService,
  ) {}

  @Public()
  // sign-ins have their own log (aud_signin_log `wx-mp`)
  @SkipActionLog()
  @RateLimit(20, 60_000)
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Sign in with a uni.login code (single use): a bound user gets a mobile session, an unbound WeChat account a bind ticket',
  })
  @ApiEnvelope(wxMpLoginVo)
  async login(
    @Body({ schema: wxMpLoginBody }) body: WxMpLoginBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WxMpLoginVo> {
    const out = await this.wxMp.login(body.code, clientOf(req), timezoneOf(req.get('x-timezone')))
    return 'tokens' in out
      ? { tokens: answerWithTokens(res, this.cfg, out.tokens, true, MOBILE_CLIENT) }
      : out
  }

  @Public()
  // a sign-in: the sign-in log (`wx-mp`) is its trail
  @SkipActionLog()
  @RateLimit(20, 60_000)
  @Post('bind')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Bind the ticket’s WeChat account to a user proven by password (captcha and lockout as /login) or an SMS signin code, then sign in (mobile session)',
  })
  @ApiEnvelope(tokenPayload)
  async bind(
    @Body({ schema: wxMpBindBody }) body: WxMpBindBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenPayload> {
    const tokens = await this.wxMp.bind(body, clientOf(req), timezoneOf(req.get('x-timezone')))
    return answerWithTokens(res, this.cfg, tokens, true, MOBILE_CLIENT)
  }
}

@ApiTags('iam')
@Controller('iam/profile/socials')
export class ProfileSocialController {
  constructor(
    private readonly wxMp: WxMpService,
    private readonly wxSubscribe: WxSubscribeService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Own sign-in bindings (WeChat mini program)' })
  @ApiEnvelope(z.array(socialBindingVo))
  list() {
    return this.wxMp.list(myId())
  }

  @Get('wx-mp/subscribe')
  @ApiOperation({
    summary:
      'WeChat subscribe template ids the mini program may ask the caller for (empty unless notify.wx_subscribe.enabled, configured and bound)',
  })
  @ApiEnvelope(wxSubscribeVo)
  async subscribe(): Promise<WxSubscribeVo> {
    return { templateIds: await this.wxSubscribe.templateIds(myId()) }
  }

  @Delete('wx-mp')
  @RateLimit(10, 60_000)
  @ActionLog({ domain: 'iam.profile', verb: 'unbind' })
  @ApiOperation({
    summary: 'Unbind own WeChat (404 when none); ends the caller’s other mobile sessions',
  })
  @ApiEnvelope()
  async unbind(): Promise<null> {
    await this.wxMp.unbind(myId(), clsGet('principal')?.sid)
    return null
  }
}
