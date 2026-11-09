import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
} from '@nestjs/common'
import { ApiBody, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger'
import {
  IM_INT_PARAMS,
  imParams,
  imPathId,
  type ImStickerFileQuery,
  imStickerFileQuery,
  type ImStickerFromEntry,
  imStickerFromEntry,
  type ImStickerOrder,
  imStickerOrder,
  imStickerVo,
} from '@qiwu/shared'
import type { Response } from 'express'
import { z } from 'zod'
import { SkipActionLog } from '../../../core/audit/action-log.js'
import { SkipHttpTrace } from '../../../core/audit/http-trace.js'
import { HomeTenant, RequireFeature } from '../../../core/auth/tenant-scope.js'
import { clsGet } from '../../../core/context/cls.js'
import { Idempotent } from '../../../core/guard/idempotent.js'
import { RateLimit } from '../../../core/guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { UploadFile, type UploadedFileData } from '../../../core/http/upload.js'
import { Sensitive } from '../../../core/redact.js'
import { ImStaffGuard } from './im-staff.guard.js'
import { sendImFile } from './im-objects.service.js'
import { StickersService } from './stickers.service.js'

const me = () => clsGet('principal')!.userId

/** 本人自定义表情（员工本人、本人租户；see docs/im.md）。静态段（order、from-entry）先于 `:id`。 */
@ApiTags('im')
@Controller('im/stickers')
@HomeTenant()
@RequireFeature('im')
@UseGuards(ImStaffGuard)
@Sensitive('filename', 'originalName')
export class StickersController {
  constructor(private readonly stickers: StickersService) {}

  @Get()
  @Header('Cache-Control', 'private, no-cache')
  @ApiOperation({ summary: 'Own stickers in their order' })
  @ApiEnvelope(z.array(imStickerVo))
  list() {
    return this.stickers.list(me())
  }

  @Post()
  @RateLimit(30, 60_000, 'user')
  @Idempotent()
  @UploadFile('file', imParams.fileMaxMb, IM_INT_PARAMS.fileMaxMb.fallback)
  @SkipActionLog()
  @SkipHttpTrace()
  @ApiOperation({ summary: 'Add an image as an own sticker (normalized to a small webp)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiEnvelope(imStickerVo, 201)
  create(@UploadedFile() file: UploadedFileData | undefined) {
    return this.stickers.create(file, me())
  }

  @Post('from-entry')
  @RateLimit(30, 60_000, 'user')
  @Idempotent()
  @SkipActionLog()
  @ApiOperation({ summary: 'Keep a received image or sticker as an own sticker' })
  @ApiEnvelope(imStickerVo, 201)
  fromEntry(@Body({ schema: imStickerFromEntry }) body: ImStickerFromEntry) {
    return this.stickers.fromEntry(body, me())
  }

  @Put('order')
  @SkipActionLog()
  @ApiOperation({ summary: 'Reorder the own stickers' })
  @ApiEnvelope()
  reorder(@Body({ schema: imStickerOrder }) body: ImStickerOrder) {
    return this.stickers.reorder(body, me())
  }

  @Get(':id/file')
  @RateLimit(300, 60_000, 'user')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @ApiOperation({ summary: 'The image of an own sticker (proxy=1 same-origin)' })
  @ApiProduces('image/webp')
  @ApiResponse({ status: 302, description: 'S3 storage without proxy: presigned GET, valid 60 s' })
  async file(
    @Param('id', { schema: imPathId }) id: number,
    @Query({ schema: imStickerFileQuery }) { proxy }: ImStickerFileQuery,
    @Res() res: Response,
  ): Promise<void> {
    sendImFile(res, await this.stickers.file(id, me(), { proxy: proxy === true }))
  }

  @Delete(':id')
  @SkipActionLog()
  @ApiOperation({ summary: 'Delete an own sticker (sent messages keep their copies)' })
  @ApiEnvelope()
  remove(@Param('id', { schema: imPathId }) id: number) {
    return this.stickers.remove(id, me())
  }
}
