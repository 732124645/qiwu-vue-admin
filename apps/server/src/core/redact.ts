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

// ---- free text a user or a model wrote (agent memories): secrets and personal numbers ----

/** a PEM block (private keys, certificates) whole */
const PEM = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g
/** a complete JWT: three base64url parts, the first a JSON header (`eyJ`) */
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g
/**
 * tokens with a known prefix and 20+ characters after it (masked only when they hold a digit): `sk-` style
 * keys, GitHub `ghp_`…, Slack `xox?-`, GitLab, Google; AWS key ids by their fixed form
 */
const KNOWN_TOKEN =
  /\b(?:(?:sk|rk|pk)-[\w-]{20,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{20,}|glpat-[\w-]{20,}|AIza[\w-]{20,})/g
const AWS_KEY_ID = /\bAKIA[0-9A-Z]{16}\b/g
/** a quoted value whole, else printable ASCII up to a space, comma or semicolon (never Chinese text) */
const VALUE = String.raw`("[^"]*"|'[^']*'|\u201c[^\u201d]*\u201d|[\x21-\x2b\x2d-\x3a\x3c-\x7e]+)`
/** the value after a secret's name and `:` / `=` / `is` (`password is x`, `pwd: "a b"`) */
const NAMED_SECRET = new RegExp(
  String.raw`\b(password|passwd|passcode|pwd|pin|secret|token|api[ _-]?key|private key)(\s*(?:\bis\b|[:\uff1a=])\s*)` +
    VALUE,
  'gi',
)
/** the same after a Chinese name (密码 口令 密钥 秘钥 令牌 验证码), the separator (是 为 ：) optional */
const NAMED_SECRET_CJK = new RegExp(
  String.raw`(\u5bc6\u7801|\u53e3\u4ee4|\u5bc6\u94a5|\u79d8\u94a5|\u4ee4\u724c|\u9a8c\u8bc1\u7801)(\s*(?:(?:\u662f|\u4e3a|[:\uff1a=])\s*)?)` +
    VALUE,
  'g',
)
/** a secret's name glued to its value (`pwd123456`) */
const GLUED_SECRET =
  /\b(password|passwd|passcode|pwd|pin)([A-Za-z0-9][\x21-\x2b\x2d-\x3a\x3c-\x7e]*)/gi
/** an 18-digit Chinese ID card number (the last character a digit or X) */
const ID_CARD =
  /(?<![\dA-Za-z])[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dA-Za-z])/g
/** 13-19 digits, single spaces or dashes between them allowed: a card number when Luhn passes */
const CARD_LIKE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g
/** a mainland mobile number, `+86` optional */
const MOBILE = /(?<![\d+])(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)/g
/** a long run of letters, digits, `_`, `-` (masked when it holds letters and digits both) */
const LONG_RUN = /[\w-]{24,}/g
/** `maskSecrets` reads at most this much: its callers keep far less (a memory is 1000 characters) */
const MASK_INPUT_MAX = 10_000

const quoted = (v: string) => /^["'\u201c]/.test(v)
/** printable ASCII starting with a letter or digit, 6+ characters, holding a digit: a value that looks like a secret */
const keyLike = (v: string) => /^[A-Za-z0-9][\x21-\x7e]{5,}$/.test(v) && /\d/.test(v)
/** after `is`: printable ASCII holding a digit or a symbol (`s3cret!`, not `valid` or `to`) */
const valueLike = (v: string) => /^[\x21-\x7e]+$/.test(v) && /[\d\W_]/.test(v)

/** The Luhn check of a digit string (card numbers). */
function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2
    sum += d
  }
  return sum % 10 === 0
}

/**
 * Free text with secrets and personal numbers masked (`***`), for text that is kept and shown again (agent
 * memories): what `textRedactor` masks in a text of no request (`name=value` of secret names), plus PEM
 * blocks, JWTs, tokens with a known prefix and AWS key ids, the value after a secret's name in English or
 * Chinese (after `:` / `=` any value, quoted ones whole; after `is` or no separator only a value that looks
 * like a secret; never Chinese words), Chinese ID card numbers, card numbers (13-19 digits passing Luhn),
 * mainland mobile numbers and long runs of letters and digits. Ordinary sentences that merely name a secret
 * (a forgotten password, "the token is valid") stay. Only the first {@link MASK_INPUT_MAX} characters are read and
 * returned: callers cut their text first, and a bound keeps the rules' run time small. The request loggers
 * keep their own rules.
 */
export function maskSecrets(input: string): string {
  const text = input.slice(0, MASK_INPUT_MAX)
  const named = (m: string, name: string, sep: string, value: string) => {
    if (quoted(value)) return `${name}${sep}${MASK}`
    const bare = !sep.trim()
    const keep = /\bis\b/i.test(sep) ? !valueLike(value) : bare && !keyLike(value)
    return keep ? m : `${name}${sep}${MASK}`
  }
  // whole blocks and tokens first: a pair rule would otherwise cut them at their first line or dot
  const blocks = text
    .replace(PEM, MASK)
    .replace(JWT, MASK)
    .replace(KNOWN_TOKEN, (m) => (/\d/.test(m) ? MASK : m))
    .replace(AWS_KEY_ID, MASK)
  return textRedactor(undefined)(blocks)
    .replace(NAMED_SECRET, named)
    .replace(NAMED_SECRET_CJK, named)
    .replace(GLUED_SECRET, (m, name: string, value: string) =>
      keyLike(value) ? `${name}${MASK}` : m,
    )
    .replace(ID_CARD, MASK)
    .replace(CARD_LIKE, (m) => {
      const digits = m.replace(/[ -]/g, '')
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? MASK : m
    })
    .replace(MOBILE, MASK)
    .replace(LONG_RUN, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? MASK : m))
}
