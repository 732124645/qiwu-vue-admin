import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common'
import { Err, type ErrorDef, fieldLabelKeys, validationMessage } from '@qiwu/shared'
import type { Request, Response } from 'express'
import { I18nService } from 'nestjs-i18n'
import { QueryFailedError } from 'typeorm'
import type { z } from 'zod'
import {
  AuditWriter,
  describeFault,
  httpLogsSkipped,
  requestSummary,
} from '../audit/audit-writer.js'
import { requestId } from '../context/context.module.js'
import { resolveLocale } from '../i18n/locale.js'
import { rememberedSensitive, textRedactor } from '../redact.js'
import { BizError } from './biz-error.js'
import { ValidationException } from './validation.pipe.js'

/** Error envelope (see docs/design-notes.md#api-envelope). */
export interface ApiErrorBody {
  code: string
  msg: string
  data: null
  errors?: { path: string; msg: string }[]
  traceId: string
}

/** HTTP status of a framework/guard exception → its common code (unlisted 4xx → BAD_REQUEST). */
const BY_STATUS: Record<number, ErrorDef> = {
  400: Err.BAD_REQUEST,
  401: Err.UNAUTHENTICATED,
  403: Err.FORBIDDEN,
  404: Err.NOT_FOUND,
  409: Err.CONFLICT,
  413: Err.PAYLOAD_TOO_LARGE,
  422: Err.UNPROCESSABLE,
  429: Err.TOO_MANY_REQUESTS,
}

/** MySQL errno → code: unique index hit (1062), row still referenced by a foreign key (1451). */
const BY_ERRNO: Record<number, ErrorDef> = { 1062: Err.DUPLICATE, 1451: Err.IN_USE }

export interface Failure {
  err: ErrorDef
  status: number
  params?: Record<string, unknown>
}

/** An exception → its error code, HTTP status and message params (also the action log's failure key). */
export function classify(e: unknown): Failure {
  if (e instanceof BizError) return { err: e.err, status: e.err.status, params: e.params }
  if (e instanceof ValidationException) return { err: Err.VALIDATION_FAILED, status: 400 }
  if (e instanceof HttpException) {
    const status = e.getStatus()
    return { err: BY_STATUS[status] ?? (status < 500 ? Err.BAD_REQUEST : Err.INTERNAL), status }
  }
  if (e instanceof QueryFailedError) {
    const err = BY_ERRNO[(e.driverError as { errno?: number } | undefined)?.errno ?? 0]
    if (err) return { err, status: err.status }
  }
  // the body parser's own failures (http-errors, `expose` = the client's fault): a body over the JSON
  // limit → 413, an unsupported charset → 415, … (a malformed one is a SyntaxError: Nest makes it a 400)
  const { status, expose } = (e ?? {}) as { status?: unknown; expose?: unknown }
  if (expose === true && typeof status === 'number' && status >= 400 && status < 500)
    return { err: BY_STATUS[status] ?? Err.BAD_REQUEST, status }
  return { err: Err.INTERNAL, status: 500 }
}

/**
 * Every exception → `{ code, msg, data: null, errors?, traceId }` with the real HTTP status. `msg` is
 * always the translated message of the code (never the exception text: nothing internal leaks);
 * zod failures add translated `errors[]` and use the first one as `msg`. 5xx go, masked, to the process
 * log and to the API error log (`aud_http_fault`; see docs/design-notes.md#audit) with the request (masked like every log),
 * the latter except on `@SkipHttpTrace()` routes.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name)

  constructor(
    private readonly i18n: I18nService,
    private readonly audit: AuditWriter,
  ) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp()
    const req = http.getRequest<Request>()
    // not I18nContext: errors from guards/unknown routes never reach nestjs-i18n's interceptor
    const lang = resolveLocale(req)
    const t = (key: string, args?: Record<string, unknown>) =>
      String(this.i18n.translate(key, { lang, args }))
    const { err, status, params } = classify(exception)
    // a seeded name in the params (a node / model named by an i18n key: WF_NO_ASSIGNEE's `{ node }`)
    // shows in the request language, as the lists show it
    const args =
      params &&
      Object.fromEntries(
        Object.entries(params).map(([k, v]) => [
          k,
          typeof v === 'string' && v.startsWith('seed.') ? t(v) : v,
        ]),
      )
    const body: ApiErrorBody = {
      code: err.code,
      msg: t(err.key, args),
      data: null,
      traceId: requestId(req),
    }
    if (exception instanceof ValidationException) {
      body.errors = exception.issues.map((issue) => {
        const path = issue.path.map(String).join('.')
        return { path, msg: this.translate(t, issue, path, exception.domain) }
      })
      body.msg = body.errors[0]?.msg ?? body.msg
    }
    if (status >= 500) this.logFault(req, exception)
    // failures before the CLS middleware (e.g. a malformed JSON body) have no echoed id yet
    http.getResponse<Response>().setHeader('X-Request-Id', body.traceId).status(status).json(body)
  }

  /**
   * A 5xx, masked once (`describeFault`: never the raw exception text) for the process log and the fault
   * row alike; the row's request is masked with the route's `@Sensitive` fields (filters never see the
   * handler: the access log interceptor kept them with the request; undefined when it failed before).
   * Never throws: the error response goes out whatever happens to its log lines.
   */
  private logFault(req: Request, exception: unknown) {
    try {
      const fields = rememberedSensitive(req)
      const fault = describeFault(
        exception,
        textRedactor({ query: req.query, body: req.body as unknown }, fields),
      )
      // not `err`: pino's error serializer would name the plain object's class `Object`
      this.logger.error({ fault }, 'request failed')
      if (!httpLogsSkipped(req)) this.audit.fault(requestSummary(req, fields), fault)
    } catch (err) {
      this.logger.error(err, 'http fault log skipped')
    }
  }

  private translate(
    t: (key: string, args?: Record<string, unknown>) => string,
    issue: z.core.$ZodIssue,
    path: string,
    domain?: string,
  ) {
    const { key, params } = validationMessage(issue)
    // a missing key translates to itself: the first label key that doesn't is the one that exists
    const label = fieldLabelKeys(domain, issue.path).find((k) => t(k) !== k)
    return t(key, { ...params, field: label ? t(label) : path })
  }
}
