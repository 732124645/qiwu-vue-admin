import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  StreamableFile,
} from '@nestjs/common'
import { ok } from '@qiwu/shared'
import { map } from 'rxjs'

/**
 * Success envelope (see docs/design-notes.md#api-envelope): handlers return the bare `data`, clients get `{ code: 0, msg: 'ok', data }`
 * (`undefined` → `null`). Files (`StreamableFile`) and non-HTTP contexts (WebSocket acks) pass through.
 */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    if (ctx.getType() !== 'http') return next.handle()
    return next
      .handle()
      .pipe(map((data: unknown) => (data instanceof StreamableFile ? data : ok(data ?? null))))
  }
}
