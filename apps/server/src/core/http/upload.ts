import {
  applyDecorators,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
  UseInterceptors,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { FileInterceptor } from '@nestjs/platform-express'
import { ApiConsumes } from '@nestjs/swagger'
import { ParamService } from '../settings/param.service.js'

/** What `@UploadedFile()` gives (multer memory storage); @types/multer is not a dependency. */
export interface UploadedFileData {
  /** the client's file name, decoded as UTF-8; display only */
  originalname: string
  /** the client's claim; never trusted (magic numbers decide) */
  mimetype: string
  size: number
  buffer: Buffer
}

const UPLOAD_LIMIT = 'qw:http:upload-limit'
const MB = 1024 * 1024

interface UploadLimit {
  paramKey: string
  fallbackMb: number
}

type LimitedRequest = { uploadMaxBytes?: number }

/** Reads the route's MB param per request (admins change it at runtime) for multer's `limits` below. */
@Injectable()
class UploadLimitInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly params: ParamService,
  ) {}

  async intercept(ctx: ExecutionContext, next: CallHandler) {
    const { paramKey, fallbackMb } = this.reflector.get<UploadLimit>(UPLOAD_LIMIT, ctx.getHandler())
    const mb = await this.params.int(paramKey, 1, 2048, fallbackMb)
    ctx.switchToHttp().getRequest<LimitedRequest>().uploadMaxBytes = mb * MB
    return next.handle()
  }
}

/**
 * `@UploadFile('file', 'storage.max_size_mb', 20)`: a multipart route with exactly one file in `field`,
 * buffered in memory by multer and cut off beyond the MB param (`fallbackMb` when unset/invalid) with
 * 413 `payload_too_large`; a few short text fields besides. The handler reads it with `@UploadedFile()`.
 */
export const UploadFile = (field: string, paramKey: string, fallbackMb: number) =>
  applyDecorators(
    SetMetadata(UPLOAD_LIMIT, { paramKey, fallbackMb } satisfies UploadLimit),
    UseInterceptors(
      UploadLimitInterceptor,
      FileInterceptor(field, {
        // multer ≥ 2.4 evaluates a limits function per request; its types still say object
        limits: ((req: LimitedRequest) => ({
          fileSize: req.uploadMaxBytes ?? fallbackMb * MB,
          files: 1,
          fields: 8,
          fieldSize: 4096,
          parts: 10,
        })) as unknown as object,
        // non-ASCII file names arrive as UTF-8 (multer's default decodes them as latin1)
        defParamCharset: 'utf8',
      } as object),
    ),
    ApiConsumes('multipart/form-data'),
  )
