import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UploadedFile,
} from '@nestjs/common'
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  avatarVo,
  changePasswordBody,
  DEFAULT_PASSWORD_POLICY,
  Err,
  type LocaleBody,
  localeBody,
  type PrefBody,
  prefBody,
  prefKey,
  type PrefVo,
  prefVo,
  type ProfileUpdate,
  type ProfileMobileCodeBody,
  profileMobileCodeBody,
  profileUpdate,
  profileVo,
  smsCodeVo,
  STORAGE_MAX_SIZE_DEFAULT,
  storageParams,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog, SkipActionLog } from '../../../../core/audit/action-log.js'
import { plainIp } from '../../../../core/auth/auth-params.js'
import { clientOf } from '../../../../core/auth/auth.controller.js'
import { clsGet } from '../../../../core/context/cls.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { RateLimit } from '../../../../core/guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { UploadFile, type UploadedFileData } from '../../../../core/http/upload.js'
import { Sensitive } from '../../../../core/redact.js'
import type { Request } from 'express'
import { OtpService } from '../../messaging/sms-otp/sms-otp.service.js'
import { ProfileService } from './profile.service.js'

/** The signed-in caller's id: profile routes act on the own user only, never on an id from the request. */
export function myId(): number {
  const p = clsGet('principal')
  if (!p) throw new BizError(Err.UNAUTHENTICATED)
  return p.userId
}

@ApiTags('iam')
@Controller('iam/profile')
export class ProfileController {
  constructor(
    private readonly profile: ProfileService,
    private readonly otp: OtpService,
  ) {}

  // personal center (`/profile`; see docs/design-notes.md#layering): no permission, always the caller's own row

  @Get()
  @ApiOperation({ summary: 'Own profile with read-only dept, role and position names' })
  @ApiEnvelope(profileVo)
  get() {
    return this.profile.get(myId())
  }

  @Put()
  @RateLimit(30, 60_000)
  @ActionLog({ domain: 'iam.profile', verb: 'modify' })
  @Sensitive('mobileCode')
  @ApiOperation({
    summary:
      'Update own profile; a new mobile requires configured SMS, current password and a bound code; clearing requires current password',
  })
  @ApiEnvelope(profileVo)
  update(@Body({ schema: profileUpdate }) body: ProfileUpdate, @Req() req: Request) {
    const p = clsGet('principal')
    if (!p) throw new BizError(Err.UNAUTHENTICATED)
    return this.profile.update(p, body, clientOf(req))
  }

  @Post('mobile/code')
  @HttpCode(200)
  @RateLimit(10, 60_000)
  // OTP limits and SMS records are the trail; the request contains a code destination.
  @SkipActionLog()
  @ApiOperation({ summary: 'Request a user-bound code for a new mobile number' })
  @ApiEnvelope(smsCodeVo)
  mobileCode(
    @Body({ schema: profileMobileCodeBody }) body: ProfileMobileCodeBody,
    @Req() req: Request,
  ) {
    return this.otp.issueBind(myId(), body.mobile, plainIp(req.ip))
  }

  @Put('locale')
  @RateLimit(30, 60_000)
  // a UI preference, not an auditable business change
  @SkipActionLog()
  @ApiOperation({ summary: 'Own language (server messages when a request names none)' })
  @ApiEnvelope()
  async setLocale(@Body({ schema: localeBody }) { locale }: LocaleBody): Promise<null> {
    await this.profile.setLocale(myId(), locale)
    return null
  }

  @Post('avatar')
  @RateLimit(10, 60_000)
  // above @UploadFile: its interceptors run first, so the key covers the parsed file (a double submit)
  @Idempotent()
  @UploadFile('file', storageParams.maxSizeMb, STORAGE_MAX_SIZE_DEFAULT / 1024 / 1024)
  @ActionLog({ domain: 'iam.profile', verb: 'change-avatar' })
  @ApiOperation({
    summary: 'Upload own avatar (multipart `file`: png/jpeg/gif/webp → 256×256 webp, public)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiEnvelope(avatarVo, 201)
  setAvatar(@UploadedFile() file: UploadedFileData | undefined) {
    return this.profile.setAvatar(myId(), file)
  }

  /**
   * Allowed while the session must change its password (AuthGuard allowlist). The body schema
   * depends on the runtime policy, so the service validates it (documented with the default policy).
   */
  @Put('password')
  @HttpCode(200)
  @ActionLog({ domain: 'iam.profile', verb: 'change-password' })
  // a stolen access token must not become an old-password oracle
  @RateLimit(10, 60_000)
  @ApiOperation({ summary: 'Change own password; ends every other session' })
  @ApiBody({
    schema: z.toJSONSchema(changePasswordBody(DEFAULT_PASSWORD_POLICY), {
      target: 'openapi-3.0',
      unrepresentable: 'any',
    }) as object,
  })
  @ApiEnvelope()
  async changePassword(@Body() body: unknown, @Req() req: Request): Promise<null> {
    const p = clsGet('principal')
    if (!p) throw new BizError(Err.UNAUTHENTICATED)
    await this.profile.changePassword(p, body, clientOf(req))
    return null
  }

  // UI preferences: no permission, own user only; generous limit, a page reads each key once

  @Get('prefs/:key')
  @RateLimit(120, 60_000)
  @ApiOperation({ summary: 'Own UI preference (`value: null` while unset)' })
  @ApiEnvelope(prefVo)
  async getPref(@Param('key', { schema: prefKey }) key: string): Promise<PrefVo> {
    return { value: await this.profile.getPref(myId(), key) }
  }

  @Put('prefs/:key')
  @RateLimit(120, 60_000)
  // a UI preference, not an auditable business change
  @SkipActionLog()
  @ApiOperation({ summary: 'Save own UI preference (upsert; > 8 KB → 413)' })
  @ApiEnvelope()
  async setPref(
    @Param('key', { schema: prefKey }) key: string,
    @Body({ schema: prefBody }) { value }: PrefBody,
  ): Promise<null> {
    await this.profile.setPref(myId(), key, value)
    return null
  }

  @Delete('prefs/:key')
  @RateLimit(120, 60_000)
  // a UI preference, not an auditable business change
  @SkipActionLog()
  @ApiOperation({ summary: 'Reset own UI preference to the page defaults' })
  @ApiEnvelope()
  async deletePref(@Param('key', { schema: prefKey }) key: string): Promise<null> {
    await this.profile.deletePref(myId(), key)
    return null
  }
}
