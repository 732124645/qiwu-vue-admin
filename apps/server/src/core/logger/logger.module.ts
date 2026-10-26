import { LoggerModule } from 'nestjs-pino'
import type { Options } from 'pino-http'
import { AppConfigService } from '../config/config.module.js'
import { requestId } from '../context/context.module.js'
import { driverMasked, queryMaskedUrl, stackFrames, textRedactor } from '../redact.js'

/** What pino-std-serializers makes of a request (the part kept). */
interface SerializedReq {
  id: unknown
  method: string
  url: string
  headers: Record<string, unknown>
  remoteAddress?: string
  remotePort?: number
}

/** What pino-std-serializers makes of a response. */
interface SerializedRes {
  statusCode: number
  headers: Record<string, unknown>
}

const maskText = textRedactor(undefined)

const errorLike = (e: unknown): e is { message: string; cause?: unknown } =>
  typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string'

/**
 * An error's message and its causes', each masked (secret-named pairs, parameter dumps, a driver
 * error's quoted values: core/redact.ts), joined like pino joins them.
 */
function maskedMessage(error: unknown): string {
  const messages: string[] = []
  for (let e = error, depth = 0; errorLike(e) && depth < 10; depth++) {
    messages.push(maskText(driverMasked(e.message, e)))
    e = e.cause
  }
  return messages.join(': ')
}

/**
 * A serialized error (pino-std-serializers: `raw` is the error) as the process log keeps it: no database
 * driver dumps (TypeORM `parameters`, mysql2 `sql` with the values inlined and `sqlMessage`, the nested
 * `driverError`), the message masked (`maskedMessage`), the stack cut to its frames (the other lines
 * repeat the messages).
 */
function sanitizedError(serialized: Record<string, unknown>): Record<string, unknown> {
  if (typeof serialized?.message !== 'string') return serialized
  const {
    parameters: _parameters,
    sql: _sql,
    sqlMessage: _sqlMessage,
    driverError: _driverError,
    ...err
  } = serialized
  return {
    ...err,
    message: maskedMessage(serialized.raw ?? serialized),
    stack: typeof err.stack === 'string' ? stackFrames(err.stack) : err.stack,
    ...(Array.isArray(err.aggregateErrors)
      ? { aggregateErrors: (err.aggregateErrors as Record<string, unknown>[]).map(sanitizedError) }
      : {}),
  }
}

/**
 * pino-http options (exported for the spec, which adds its own stream). Requests are logged masked like
 * the API logs (core/redact.ts; see docs/design-notes.md#audit): pino binds the request to the request's logger before
 * routing, when the route's `@Sensitive` fields are not known yet, so like the API logs of a request
 * whose route is unknown no query value is kept (every one masked; the query and params objects are
 * left out); secret headers are redacted, a redirect's `Location` keeps only its query names (a presigned
 * download URL carries its signature there). Errors are masked (`sanitizedError`, and the line's `msg`
 * pino would take from them); the error filter logs 5xx already masked with the request's secrets too
 * (`describeFault`).
 */
const STARTUP_CONTEXTS = new Set([
  'NestFactory',
  'InstanceLoader',
  'RoutesResolver',
  'RouterExplorer',
  'NestApplication',
])

export const pinoHttpOptions = (cfg: AppConfigService): Options => ({
  level: cfg.get('LOG_LEVEL'),
  genReqId: requestId,
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  hooks: {
    // with no message given, pino makes the error's raw message the line's `msg`: give the masked one
    logMethod(args, method, level) {
      // 开发重启只省略框架的重复注册信息，不过滤警告、错误或业务日志。
      if (
        process.env.QW_DEV === '1' &&
        cfg.get('NODE_ENV') === 'development' &&
        level === 30 &&
        STARTUP_CONTEXTS.has((args[0] as { context?: string } | undefined)?.context ?? '')
      )
        return
      const [first] = args as unknown[]
      const err =
        first instanceof Error ? first : (first as { err?: unknown } | null | undefined)?.err
      if (args.length === 1 && errorLike(err) && (first as { msg?: unknown }).msg === undefined)
        return method.call(this, first as object, maskedMessage(err))
      return method.apply(this, args)
    },
  },
  serializers: {
    req: (req: SerializedReq) => ({
      id: req.id,
      method: req.method,
      url: queryMaskedUrl(req.url),
      headers: req.headers,
      remoteAddress: req.remoteAddress,
      remotePort: req.remotePort,
    }),
    res: (res: SerializedRes) => {
      const { location } = res.headers ?? {}
      return typeof location === 'string'
        ? { ...res, headers: { ...res.headers, location: queryMaskedUrl(location) } }
        : res
    },
    err: sanitizedError,
  },
  // pino-pretty is a devDependency: only ever loaded in development
  transport:
    cfg.get('NODE_ENV') === 'development'
      ? {
          target: 'pino-pretty',
          options:
            process.env.QW_DEV === '1'
              ? {
                  singleLine: true,
                  ignore: 'pid,hostname,req.headers,res.headers,req.remoteAddress,req.remotePort',
                }
              : undefined,
        }
      : undefined,
})

/** Structured JSON logs (pino); every request line carries reqId = CLS id = traceId. Needs CoreConfigModule. */
export const CoreLoggerModule = LoggerModule.forRootAsync({
  inject: [AppConfigService],
  useFactory: (cfg: AppConfigService) => ({ pinoHttp: pinoHttpOptions(cfg) }),
})
