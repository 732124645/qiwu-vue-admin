import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
} from '@nestjs/common'
import { ApiBody, ApiOperation } from '@nestjs/swagger'
import {
  pageVo,
  STORAGE_MAX_SIZE_DEFAULT,
  storageParams,
  WXOA_MEDIA_KINDS,
  type WxoaAccountRef,
  type WxoaAccountScope,
  type WxoaMaterialCreate,
  type WxoaMaterialQuery,
  wxoaAccountRef,
  wxoaAccountScope,
  wxoaMaterialCountsVo,
  wxoaMaterialCreate,
  wxoaMaterialQuery,
  wxoaMaterialVo,
  wxoaPerms,
  wxoaSyncVo,
} from '@qiwu/shared'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import type { Principal } from '../../../../core/auth/principal.js'
import { clsGet } from '../../../../core/context/cls.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { UploadFile, type UploadedFileData } from '../../../../core/http/upload.js'
import type { WxoaMaterial } from '../core/wxoa.entity.js'
import { ApiWxoa } from '../core/wxoa-swagger.js'
import { WxoaMaterialService } from './material.service.js'

const perms = wxoaPerms.material
const domain = 'wxoa.material'
const me = (): Principal => clsGet('principal')!

/** Permanent materials of an account; 404 for a missing or deleted account, `B6011` for a disabled one. */
@ApiWxoa()
@Controller('wxoa/materials')
export class WxoaMaterialController {
  constructor(private readonly materials: WxoaMaterialService) {}

  @Get()
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: "Page of an account's permanent materials" })
  @ApiEnvelope(pageVo(wxoaMaterialVo))
  page(@Query({ schema: wxoaMaterialQuery }) query: WxoaMaterialQuery) {
    return this.materials.list(query)
  }

  @Get('counts')
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: "WeChat's material counts of an account" })
  @ApiEnvelope(wxoaMaterialCountsVo)
  counts(@Query({ schema: wxoaAccountScope }) { accountId }: WxoaAccountScope) {
    return this.materials.counts(accountId)
  }

  @Get('sync')
  @RequirePerm(perms.browse)
  @ApiOperation({ summary: "Progress of the account's last material sync" })
  @ApiEnvelope(wxoaSyncVo)
  syncProgress(@Query({ schema: wxoaAccountScope }) { accountId }: WxoaAccountScope) {
    return this.materials.syncProgress(accountId)
  }

  @Post('sync')
  @RequirePerm(perms.sync)
  @ActionLog({ domain, verb: 'sync' })
  @ApiOperation({
    summary: "Start a sync of the account's materials from WeChat (one running already → 409)",
  })
  @ApiEnvelope(wxoaSyncVo, 201)
  sync(@Body({ schema: wxoaAccountRef }) { accountId }: WxoaAccountRef) {
    return this.materials.startSync(accountId)
  }

  @Post()
  @RequirePerm(perms.create)
  // above @UploadFile: its interceptors run first, so the key covers the parsed file (a double submit)
  @Idempotent()
  @UploadFile('file', storageParams.maxSizeMb, STORAGE_MAX_SIZE_DEFAULT / 1024 / 1024)
  @ActionLog({ domain, verb: 'upload', bizId: (_req, row) => (row as WxoaMaterial)?.id })
  @ApiOperation({
    summary:
      'Upload a permanent material (multipart; a video with title and intro): stored locally, then on WeChat; a type or size WeChat does not take → 422 / 413',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'accountId', 'mediaKind'],
      properties: {
        file: { type: 'string', format: 'binary' },
        accountId: { type: 'integer' },
        mediaKind: { type: 'string', enum: [...WXOA_MEDIA_KINDS] },
        title: { type: 'string', maxLength: 64 },
        intro: { type: 'string', maxLength: 255 },
      },
    },
  })
  @ApiEnvelope(wxoaMaterialVo, 201)
  upload(
    @UploadedFile() file: UploadedFileData | undefined,
    @Body({ schema: wxoaMaterialCreate }) dto: WxoaMaterialCreate,
  ) {
    return this.materials.upload(dto, file, me().userId)
  }

  @Delete(':id')
  @RequirePerm(perms.remove)
  @ActionLog({ domain, verb: 'remove' })
  @ApiOperation({
    summary: 'Delete a material on WeChat and here (used by an auto-reply rule → 409)',
  })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.materials.drop(id)
  }
}
