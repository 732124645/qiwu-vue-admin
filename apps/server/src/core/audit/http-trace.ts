import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import {
  DEFAULT_HTTP_TRACE_EXCLUDE,
  DEFAULT_HTTP_TRACE_MODE,
  HTTP_TRACE_EXCLUDE_PARAM,
  HTTP_TRACE_MODE_PARAM,
  HTTP_TRACE_MODES,
  type HttpTraceMode,
} from '@qiwu/shared'
import type { Request, Response } from 'express'
import { from, switchMap, tap } from 'rxjs'
import { classify } from '../http/http-error.filter.js'
import { rememberSensitive, sensitiveFields } from '../redact.js'
import { ParamService } from '../settings/param.service.js'
import { AuditWriter, requestSummary, skipHttpLogs } from './audit-writer.js'

const SKIP_HTTP_TRACE = 'qw:audit:skip-http-trace'

/**
 * A route (or controller) the API logs never record: no access log row whatever the mode, and no error
 * log row for its 5xx either (health probes…).
 */
export const SkipHttpTrace = () => SetMetadata(SKIP_HTTP_TRACE, true)

const READS = new Set(['GET', 'HEAD'])

/**
 * Whether `audit.http_trace.exclude_paths` (`[METHOD ]<path prefix>` entries, by comma or line) covers
 * the request; malformed entries (no leading `/`, more than two words) match nothing.
 */
export function traceExcluded(entries: string, method: string, path: string): boolean {
  return entries.split(/[,\r\n]+/).some((entry) => {
    const words = entry.trim().split(/\s+/)
    const [verb, prefix] = words.length === 2 ? words : [undefined, words[0]]
    return (
      words.length <= 2 &&
      prefix?.startsWith('/') === true &&
      (verb === undefined || verb.toUpperCase() === method) &&
      path.startsWith(prefix)
    )
  })
}

/**
 * The API access log (global; see docs/design-notes.md#audit): one `aud_http_trace` row per request the param
 * `audit.http_trace.mode` selects when it arrives (`off` / `write` = non-GET, the default / `all`),
 * except `@SkipHttpTrace()` routes and the paths of `audit.http_trace.exclude_paths` (both params read
 * through ParamService: cached, an edit applies at once): caller, path, masked query and body (secret key names and
 * `@Sensitive` fields), status, result code, error key, cost. The row is written without awaiting: the
 * log never fails a request. Runs after the guards, so their refusals (401/403/429) are not recorded;
 * validation (400) and handler errors are. Also hands the error filter, which only gets the request,
 * the route's `@Sensitive` fields (`rememberSensitive`) and its `@SkipHttpTrace` (`skipHttpLogs`).
 */
@Injectable()
export class HttpTraceInterceptor implements NestInterceptor {
  private readonly logger = new Logger(HttpTraceInterceptor.name)

  constructor(
    private readonly reflector: Reflector,
    private readonly params: ParamService,
    private readonly audit: AuditWriter,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler) {
    if (ctx.getType() !== 'http') return next.handle()
    const http = ctx.switchToHttp()
    const req = http.getRequest<Request>()
    const sensitive = sensitiveFields(this.reflector, ctx)
    rememberSensitive(req, sensitive)
    const targets = [ctx.getHandler(), ctx.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(SKIP_HTTP_TRACE, targets)) {
      skipHttpLogs(req)
      return next.handle()
    }
    const res = http.getResponse<Response>()
    const startedAt = new Date()
    // now, while the request context (caller, trace id) is active
    const summary = requestSummary(req, sensitive)
    const log = (error?: unknown) => {
      try {
        const failure = error === undefined ? undefined : classify(error)
        this.audit.trace({
          req: summary,
          status: failure?.status ?? res.statusCode,
          bizCode: failure?.err.code ?? '0',
          errorKey: failure?.err.key,
          startedAt,
          costMs: Date.now() - startedAt.getTime(),
        })
      } catch (err) {
        this.logger.error(err, 'http trace skipped')
      }
    }
    return from(this.traced(req.method, summary.url)).pipe(
      switchMap((traced) =>
        traced
          ? next.handle().pipe(tap({ next: () => log(), error: (e: unknown) => log(e) }))
          : next.handle(),
      ),
    )
  }

  /** Mode and exclusion (cached reads); unset, unknown or unreadable params → their defaults. */
  private async traced(method: string, path: string): Promise<boolean> {
    let mode: HttpTraceMode = DEFAULT_HTTP_TRACE_MODE
    let exclude = DEFAULT_HTTP_TRACE_EXCLUDE
    try {
      const [m, x] = await Promise.all([
        this.params.get(HTTP_TRACE_MODE_PARAM),
        this.params.get(HTTP_TRACE_EXCLUDE_PARAM),
      ])
      mode = HTTP_TRACE_MODES.find((v) => v === m?.trim()) ?? DEFAULT_HTTP_TRACE_MODE
      exclude = x ?? DEFAULT_HTTP_TRACE_EXCLUDE
    } catch (err) {
      this.logger.error(err, 'http trace params unreadable')
    }
    return (
      mode !== 'off' &&
      !(mode === 'write' && READS.has(method)) &&
      !traceExcluded(exclude, method, path)
    )
  }
}
