import { Controller, Get, Param } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { type DictPayload, dictPayloadVo, Err, type PublicParam, publicParamVo } from '@qiwu/shared'
import { Public } from '../../../core/auth/decorators.js'
import { RateLimit } from '../../../core/guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { BizError } from '../../../core/http/biz-error.js'
import { DictService } from '../../../core/settings/dict.service.js'
import { ParamService } from '../../../core/settings/param.service.js'

/** Settings reads every client needs (see docs/design-notes.md#i18n); admin CRUD: ./dict, ./dict-entry, ./param. */
@ApiTags('settings')
@Controller('settings')
export class SettingsReadController {
  constructor(
    private readonly dicts: DictService,
    private readonly params: ParamService,
  ) {}

  /** Any signed-in user: dict labels render on every page, so no permission is checked. */
  @Get('dicts/:code/entries')
  @ApiOperation({ summary: 'Enabled entries of an enabled dict, with its cache version' })
  @ApiEnvelope(dictPayloadVo)
  async dictEntries(@Param('code') code: string): Promise<DictPayload> {
    const payload = await this.dicts.entries(code)
    if (!payload) throw new BizError(Err.NOT_FOUND)
    return payload
  }

  /** Before sign-in (e.g. the default time zone); unknown and non-public keys are the same 404. */
  @Public()
  @RateLimit(60, 60_000)
  @Get('params/public/:key')
  @ApiOperation({ summary: 'A parameter flagged is_public' })
  @ApiEnvelope(publicParamVo)
  async publicParam(@Param('key') key: string): Promise<PublicParam> {
    const value = await this.params.getPublic(key)
    if (value === null) throw new BizError(Err.NOT_FOUND)
    return { key, value }
  }
}
