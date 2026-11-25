import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
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
  imEntriesQuery,
  type ImEntriesQuery,
  imEntriesVo,
  type ImEntryEdit,
  imEntryEdit,
  type ImEntrySend,
  imEntrySend,
  imEntryVo,
  type ImFileQuery,
  imFileQuery,
  imParams,
  IM_INT_PARAMS,
  IM_VOICE_LIMITS,
  imPathId,
  imUploadVo,
} from '@qiwu/shared'
import type { Response } from 'express'
import { SkipActionLog } from '../../../core/audit/action-log.js'
import { SkipHttpTrace } from '../../../core/audit/http-trace.js'
import { HomeTenant, RequireFeature } from '../../../core/auth/tenant-scope.js'
import { clsGet } from '../../../core/context/cls.js'
import { Idempotent } from '../../../core/guard/idempotent.js'
import { RateLimit } from '../../../core/guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { UploadFile, type UploadedFileData } from '../../../core/http/upload.js'
import { Sensitive } from '../../../core/redact.js'
import { EntriesService } from './entries.service.js'
import { ImStaffGuard } from './im-staff.guard.js'
import { sendImFile } from './im-objects.service.js'

const me = () => clsGet('principal')!.userId

/**
 * 消息、上传与消息附件（员工本人、本人租户；see docs/im.md）。正文、文件名不进访问日志；写接口不记操作日志。
 */
@ApiTags('im')
@Controller('im/rooms/:id')
@HomeTenant()
@RequireFeature('im')
@UseGuards(ImStaffGuard)
@Sensitive('text', 'name', 'filename', 'originalName')
export class EntriesController {
  constructor(private readonly entries: EntriesService) {}

  @Get('entries')
  @SkipHttpTrace()
  @ApiOperation({
    summary:
      'Entries after / before a seq, listed seqs or the newest page, within the own visible range',
  })
  @ApiEnvelope(imEntriesVo)
  list(
    @Param('id', { schema: imPathId }) id: number,
    @Query({ schema: imEntriesQuery }) query: ImEntriesQuery,
  ) {
    return this.entries.list(id, query, me())
  }

  @Post('uploads')
  @RateLimit(30, 60_000, 'user')
  // 在 @UploadFile 之上：它的拦截器先运行，幂等键覆盖解析后的文件（双击重复提交）
  @Idempotent()
  @UploadFile('file', imParams.fileMaxMb, IM_INT_PARAMS.fileMaxMb.fallback)
  @SkipActionLog()
  @SkipHttpTrace()
  @ApiOperation({ summary: 'Upload an image or file to send; 413 over the chat or storage limit' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiEnvelope(imUploadVo, 201)
  upload(
    @Param('id', { schema: imPathId }) id: number,
    @UploadedFile() file: UploadedFileData | undefined,
  ) {
    return this.entries.upload(id, file, me())
  }

  @Post('voice-uploads')
  @RateLimit(30, 60_000, 'user')
  @Idempotent()
  @UploadFile('file', imParams.voiceMaxMb, IM_INT_PARAMS.voiceMaxMb.fallback, IM_VOICE_LIMITS.maxMb)
  @SkipActionLog()
  @SkipHttpTrace()
  @ApiOperation({
    summary:
      'Upload a validated PCM WAV voice message; authoritative duration is read from its bytes',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiEnvelope(imUploadVo, 201)
  uploadVoice(
    @Param('id', { schema: imPathId }) id: number,
    @UploadedFile() file: UploadedFileData | undefined,
  ) {
    return this.entries.uploadVoice(id, file, me())
  }

  @Post('entries')
  @RateLimit(20, 10_000, 'user')
  @Idempotent()
  @SkipActionLog()
  @SkipHttpTrace()
  @ApiOperation({
    summary: 'Send a message; the same clientEntryId with the same content returns it again',
  })
  @ApiEnvelope(imEntryVo, 201)
  send(
    @Param('id', { schema: imPathId }) id: number,
    @Body({ schema: imEntrySend }) body: ImEntrySend,
  ) {
    return this.entries.send(id, body, me())
  }

  @Put('entries/:seq')
  @RateLimit(20, 10_000, 'user')
  @SkipActionLog()
  @SkipHttpTrace()
  @ApiOperation({ summary: 'Edit an own text message within the edit window' })
  @ApiEnvelope(imEntryVo)
  edit(
    @Param('id', { schema: imPathId }) id: number,
    @Param('seq', { schema: imPathId }) seq: number,
    @Body({ schema: imEntryEdit }) body: ImEntryEdit,
  ) {
    return this.entries.edit(id, seq, body, me())
  }

  @Post('entries/:seq/recall')
  @HttpCode(200)
  @RateLimit(20, 10_000, 'user')
  @SkipActionLog()
  @ApiOperation({ summary: 'Recall a message (own window, or by group role)' })
  @ApiEnvelope(imEntryVo)
  recall(
    @Param('id', { schema: imPathId }) id: number,
    @Param('seq', { schema: imPathId }) seq: number,
  ) {
    return this.entries.recall(id, seq, me())
  }

  @Get('entries/:seq/file')
  @RateLimit(300, 60_000, 'user')
  @SkipHttpTrace()
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @ApiOperation({
    summary: 'A message attachment (thumb=1 the thumbnail; proxy=1 same-origin, at most 20 MiB)',
  })
  @ApiProduces('application/octet-stream')
  @ApiResponse({ status: 302, description: 'S3 storage without proxy: presigned GET, valid 60 s' })
  async file(
    @Param('id', { schema: imPathId }) id: number,
    @Param('seq', { schema: imPathId }) seq: number,
    @Query({ schema: imFileQuery }) query: ImFileQuery,
    // 手写响应：文件流或跳转，不经过 JSON 包络
    @Res() res: Response,
  ): Promise<void> {
    sendImFile(res, await this.entries.file(id, seq, query, me()))
  }
}
