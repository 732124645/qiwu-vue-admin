import { type ExecutionContext, SetMetadata } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'

/**
 * Key names whose values never reach a log (see docs/design-notes.md#audit); `code`/`answer` match only exactly, so
 * `dictCode` stays readable. The action log and the API logs (http trace / fault) use it.
 */
export const SECRET_KEY =
  /pass|secret|token|key|verifier|otp|ticket|captcha|authorization|cookie|^code$|^answer$/i

export const MASK = '***'

const SENSITIVE = 'qw:redact:sensitive'

/**
 * `@Sensitive('paramValue')` on a controller or route: fields whose values may be secrets under a
 * plain name, masked like the secret key names (any depth, query too) wherever the request is logged.
 * Every logger of requests reads them with `sensitiveFields` (action log, http trace) or, given only
 * the request, `rememberedSensitive` (the error filter's http fault).
 */
export const Sensitive = (...fields: string[]) => SetMetadata(SENSITIVE, fields)

/** The `@Sensitive` fields of the route and its controller. */
export const sensitiveFields = (reflector: Reflector, ctx: ExecutionContext): string[] =>
  reflector.getAllAndMerge<string[]>(SENSITIVE, [ctx.getHandler(), ctx.getClass()])

const ROUTE_FIELDS = new WeakMap<object, readonly string[]>()

/**
 * Keeps the route's `@Sensitive` fields with its request (core/audit HttpTraceInterceptor, every route)
 * for loggers that get only the request: exception filters never see the handler.
 */
export const rememberSensitive = (req: object, fields: readonly string[]): void => {
  ROUTE_FIELDS.set(req, fields)
}

/** What `rememberSensitive` kept; undefined when the request failed before its route's interceptors. */
export const rememberedSensitive = (req: object): readonly string[] | undefined =>
  ROUTE_FIELDS.get(req)

const secret = (name: string, fields: readonly string[]) =>
  SECRET_KEY.test(name) || fields.includes(name)

/**
 * `url` with the value of every secret-named (or `fields`) query parameter masked
 * (`/a?token=x&page=1` → `/a?token=***&page=1`); the path and the other parameters stay as sent.
 */
export function redactedUrl(url: string, fields: readonly string[] = []): string {
  const at = url.indexOf('?')
  if (at < 0) return url
  const query = url
    .slice(at + 1)
    .split('&')
    .map((pair) => {
      // the decoded name, as the query parser sees it (`api%5Fkey`, `pass+word`)
      const name = new URLSearchParams(pair).keys().next().value
      return name !== undefined && secret(name, fields) ? `${pair.split('=')[0]}=${MASK}` : pair
    })
  return `${url.slice(0, at)}?${query.join('&')}`
}

/**
 * `url` with every query value masked (`/a?token=x&page=1` → `/a?token=***&page=***`): for a logger that
 * cannot know the route's `@Sensitive` fields (pino binds the request before routing).
 */
export function queryMaskedUrl(url: string): string {
  const at = url.indexOf('?')
  if (at < 0) return url
  const names = url
    .slice(at + 1)
    .split('&')
    .map((pair) => `${pair.split('=')[0]}=${MASK}`)
  return `${url.slice(0, at)}?${names.join('&')}`
}

/**
 * JSON of `value` with every secret-named (or `fields`) key masked at any depth (bigints as strings),
 * cut to `max` characters; null when there is nothing to write or it cannot be serialized (cycles).
 */
export function redactedJson(
  value: unknown,
  max: number,
  fields: readonly string[] = [],
): string | null {
  try {
    const json = JSON.stringify(value, (k, v: unknown) =>
      k && secret(k, fields) ? MASK : typeof v === 'bigint' ? String(v) : v,
    ) as string | undefined
    return json === undefined ? null : json.slice(0, max)
  } catch {
    return null
  }
}

/** Values shorter than this are not searched for in free text: they would mask ordinary words. */
const SECRET_VALUE_MIN = 4

/** `name=value`, `name: value`, `"name": "value"` (value quoted or up to a separator) */
const PAIR =
  /(["']?)\b([A-Za-z_][\w-]*)\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;&)}\]]+)/g

/** a parameter list dumped into a message (`parameters: [...]`), to the end of its line */
const DUMP = /\b(parameters|params|bindings)\b\s*[:=]?\s*\[[^\n]*\]/gi

/** The values of `value` under secret-named (or `fields`) keys, any depth, long enough to search for. */
function secretValues(
  value: unknown,
  fields: readonly string[],
  under = false,
  out: string[] = [],
) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    const text = String(value)
    if (under && text.length >= SECRET_VALUE_MIN) out.push(text)
  } else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value))
      secretValues(v, fields, under || secret(k, fields), out)
  return out
}

/**
 * A masker for free text (an exception's message) of a request (see docs/design-notes.md#audit): every value the request
 * carried under a secret-named (or `fields`) key (`{ query, body }`, any depth) is replaced wherever it
 * appears, then `name=value` / `name: value` / JSON pairs of secret names are masked and parameter
 * dumps (`parameters: [...]`) cut.
 */
export function textRedactor(
  request: unknown,
  fields: readonly string[] = [],
): (text: string) => string {
  // longest first: a secret containing another is replaced whole
  const values = [...new Set(secretValues(request, fields))].sort((a, b) => b.length - a.length)
  return (text) => {
    let out = text
    for (const v of values) out = out.split(v).join(MASK)
    return out
      .replace(PAIR, (pair, q: string, name: string, sep: string) =>
        secret(name, fields) ? `${q}${name}${q}${sep}${MASK}` : pair,
      )
      .replace(DUMP, `$1: [${MASK}]`)
  }
}

/** `'…'` / `"…"` literals: the values a driver message quotes (and, alas, the names) */
const QUOTED = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g

/**
 * A database driver error's message (mysql2's, or TypeORM's QueryFailedError, which copies its
 * `sqlState` / `code`) with every quoted literal masked, behind its code (`ER_…`): those messages quote
 * the values they refused. Any other message as it is.
 */
export function driverMasked(message: string, error: object): string {
  const { sqlState, code } = error as { sqlState?: unknown; code?: unknown }
  if (typeof sqlState !== 'string') return message
  const quoted = message.replace(QUOTED, `'${MASK}'`)
  return typeof code === 'string' ? `${code}: ${quoted}` : quoted
}

/** A stack's frames (`    at …`) without the lines above them, which repeat the message. */
export const stackFrames = (stack: string | undefined): string | null =>
  stack
    ?.split('\n')
    .filter((l) => /^\s+at /.test(l))
    .join('\n') || null
