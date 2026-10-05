import { pipeline } from 'node:stream'
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
  UploadedFile,
} from '@nestjs/common'
import { ApiBody, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger'
import {
  type FsConfirmBody,
  fsConfirmBody,
  type FsDownloadQuery,
  fsDownloadQuery,
  fsObjectDetailVo,
  type FsObjectQuery,
  fsObjectQuery,
  fsObjectRowVo,
  fsObjectVo,
  type FsPresignBody,
  fsPresignBody,
  fsPresignVo,
  type FsUploadBody,
  fsUploadBody,
  pageVo,
  STORAGE_BIZ_TAGS,
  STORAGE_MAX_SIZE_DEFAULT,
  storageObjectPerms,
  storageParams,
} from '@qiwu/shared'
import type { Response } from 'express'
import { ActionLog, SkipActionLog } from '../../../core/audit/action-log.js'
import { RequirePerm } from '../../../core/auth/decorators.js'
import type { Principal } from '../../../core/auth/principal.js'
import { clsGet } from '../../../core/context/cls.js'
import { Idempotent } from '../../../core/guard/idempotent.js'
import { RateLimit } from '../../../core/guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { ExcelService, XLSX_TYPE } from '../../../core/excel/excel.service.js'
import { UploadFile, type UploadedFileData } from '../../../core/http/upload.js'
import { objectColumns, StorageService } from './storage.service.js'

/** Signed-in caller (AuthGuard set it; every route here needs a session). */
const me = (): Principal => clsGet('principal')!

@ApiTags('storage')
@Controller('storage/objects')
export class StorageController {
  constructor(
    private readonly storage: StorageService,
    private readonly excel: ExcelService,
  ) {}

  /** The file list: every stored object (newest first by default). */
  @Get()
  @RequirePerm(storageObjectPerms.browse)
  @ApiOperation({ summary: 'Page of stored objects' })
  @ApiEnvelope(pageVo(fsObjectRowVo))
  list(@Query({ schema: fsObjectQuery }) query: FsObjectQuery) {
    return this.storage.list(query)
  }

  /** The list's rows (same filters and sort, no paging) as .xlsx. */
  @Get('export')
  @RequirePerm(storageObjectPerms.export)
  @ActionLog({ domain: 'storage.object', verb: 'export' })
  @ApiOperation({ summary: 'Export the filtered objects (.xlsx)' })
  @ApiProduces(XLSX_TYPE)
  export(@Query({ schema: fsObjectQuery }) query: FsObjectQuery) {
    return this.excel.export('files', objectColumns, this.storage.exportRows(query))
  }

  /** Any object's detail (key, hash, business reference). */
  @Get(':id')
  @RequirePerm(storageObjectPerms.view)
  @ApiOperation({ summary: 'One stored object' })
  @ApiEnvelope(fsObjectDetailVo)
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.storage.detail(id)
  }

  /** Any signed-in user; the business tag decides public (images only) or private. */
  @Post()
  @RateLimit(60, 60_000)
  // above @UploadFile: its interceptors run first, so the key covers the parsed file (a double submit)
  @Idempotent()
  @UploadFile('file', storageParams.maxSizeMb, STORAGE_MAX_SIZE_DEFAULT / 1024 / 1024)
  @ActionLog({
    domain: 'storage.object',
    verb: 'upload',
    bizId: (_req, row) => (row as { id?: number } | undefined)?.id,
  })
  @ApiOperation({
    summary: 'Upload a file (multipart: file + bizTag); 413 over storage.max_size_mb',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'bizTag'],
      properties: {
        file: { type: 'string', format: 'binary' },
        bizTag: { type: 'string', enum: [...STORAGE_BIZ_TAGS] },
      },
    },
  })
  @ApiEnvelope(fsObjectVo, 201)
  upload(
    @UploadedFile() file: UploadedFileData | undefined,
    @Body({ schema: fsUploadBody }) { bizTag }: FsUploadBody,
  ) {
    return this.storage.upload(file, bizTag, me().userId)
  }

  /**
   * Direct upload to the primary S3 storage, step 1: a PUT URL signed for this type and length, valid
   * 10 min, and a one-time confirm grant for the caller (the confirm is the logged upload).
   */
  @Post('presign')
  @HttpCode(200)
  @RateLimit(60, 60_000)
  @SkipActionLog()
  @ApiOperation({
    summary: 'Presign a direct upload to S3 (422 on a local primary storage, 413 over the limit)',
  })
  @ApiEnvelope(fsPresignVo)
  presign(@Body({ schema: fsPresignBody }) body: FsPresignBody) {
    return this.storage.presign(body, me().userId)
  }

  /**
   * Step 2, after the browser's PUT: only the caller who presigned the key, once (anyone else → 404,
   * the grant kept); the stored bytes are checked again (size, type) or deleted (422).
   */
  @Post('confirm')
  @RateLimit(60, 60_000)
  @ActionLog({
    domain: 'storage.object',
    verb: 'upload',
    bizId: (_req, row) => (row as { id?: number } | undefined)?.id,
  })
  @ApiOperation({ summary: 'Register a direct upload' })
  @ApiEnvelope(fsObjectVo, 201)
  confirm(@Body({ schema: fsConfirmBody }) { key }: FsConfirmBody) {
    return this.storage.confirm(key, me().userId)
  }

  /**
   * Private objects: the uploader, `storage.object.view` or the tag's access checker (else 403). Never
   * rendered by the browser as a page: attachment (inline only for images when asked), nosniff, sandbox.
   * An S3 object answers 302 to a 60 s presigned GET with the same type and disposition.
   */
  @Get(':id/download')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  @ApiOperation({ summary: 'Download an object (S3: 302 to a presigned URL)' })
  @ApiProduces('application/octet-stream')
  @ApiResponse({ status: 302, description: 'S3 storage: presigned GET, valid 60 s' })
  async download(
    @Param('id', ParseIntPipe) id: number,
    @Query({ schema: fsDownloadQuery }) { inline }: FsDownloadQuery,
    // the response by hand: a file or a redirect (the envelope never wraps either)
    @Res() res: Response,
  ): Promise<void> {
    const out = await this.storage.download(id, inline === true, me())
    if ('redirect' in out) return res.redirect(302, out.redirect)
    const { type, length, disposition } = out.getHeaders()
    res.set({
      'Content-Type': type,
      'Content-Disposition': disposition,
      ...(length == null ? {} : { 'Content-Length': String(length) }),
    })
    // pipeline destroys the file stream too when the client goes away or reading fails
    pipeline(out.getStream(), res, () => undefined)
  }

  @Delete(':id')
  @RequirePerm(storageObjectPerms.remove)
  @ActionLog({ domain: 'storage.object', verb: 'remove' })
  @ApiOperation({ summary: 'Delete an object (soft; its file goes with the retention purge)' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.storage.remove(id)
  }
}
