import {
  applyDecorators,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
  SetMetadata,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { tap } from 'rxjs'
import { plainIp } from '../auth/auth-params.js'
import { classify } from '../http/http-error.filter.js'
import { sensitiveFields } from '../redact.js'
import { AuditWriter } from './audit-writer.js'

export interface ActionLogOptions {
  /** `<domain>.<resource>` of the permission codes, e.g. `iam.user` */
  domain: string
  /** `create`/`modify`/`remove`/`import`/… or a module verb (`reset-password`), kebab-case (see docs/design-notes.md#permissions) */
  verb: string
  /** the business id; default `req.params.id` (`result` is undefined when the handler failed) */
  bizId?: (req: Request, result: unknown) => unknown
}

const ACTION_LOG = 'qw:audit:action-log'
const SKIP_ACTION_LOG = 'qw:audit:skip-action-log'

const text = (v: unknown): string | null =>
  v === undefined || v === null || v === '' ? null : String(v)

/**
 * Writes one `aud_action_log` row per call of an `@ActionLog` route (see docs/design-notes.md#audit): caller, request,
 * masked params/result (secret key names and the route's `@Sensitive` fields, core/redact.ts), ok or
 * the error's message key, cost. Fire-and-forget: nothing here can fail
 * or delay the request. Runs after the guards, so 401/403 are not logged; validation errors are.
 */
@Injectable()
export class ActionLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ActionLogInterceptor.name)

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditWriter,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler) {
    const opts = this.reflector.get<ActionLogOptions | undefined>(ACTION_LOG, ctx.getHandler())
    if (!opts || ctx.getType() !== 'http') return next.handle()
    const req = ctx.switchToHttp().getRequest<Request>()
    const started = Date.now()
    const log = (result: unknown, error?: unknown) => {
      try {
        const params: Record<string, unknown> = {}
        if (req.query && Object.keys(req.query).length) params.query = req.query
        if (req.body !== undefined) params.body = req.body
        this.audit.action({
          domain: opts.domain,
          verb: opts.verb,
          bizId: text(opts.bizId ? opts.bizId(req, result) : req.params?.id),
          method: req.method,
          url: req.originalUrl,
          ip: plainIp(req.ip) || null,
          ua: req.get('user-agent') ?? '',
          params: Object.keys(params).length ? params : undefined,
          result: result instanceof StreamableFile ? null : result,
          errorKey: error === undefined ? undefined : classify(error).err.key,
          sensitive: sensitiveFields(this.reflector, ctx),
          costMs: Date.now() - started,
        })
      } catch (err) {
        this.logger.error(err, 'action log skipped')
      }
    }
    return next
      .handle()
      .pipe(tap({ next: (r: unknown) => log(r), error: (e) => log(undefined, e) }))
  }
}

/**
 * `@ActionLog({ domain: 'iam.user', verb: 'modify' })` on a write route (see docs/design-notes.md#audit). Every non-GET
 * controller method has it or `@SkipActionLog()` (`scripts/arch/action-log.mjs`).
 */
export const ActionLog = (opts: ActionLogOptions) =>
  applyDecorators(SetMetadata(ACTION_LOG, opts), UseInterceptors(ActionLogInterceptor))

/** A write route that is deliberately not action-logged (say why in a comment next to it). */
export const SkipActionLog = () => SetMetadata(SKIP_ACTION_LOG, true)
