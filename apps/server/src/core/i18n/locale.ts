import type { IncomingMessage } from 'node:http'
import {
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  DEFAULT_TIMEZONE_PARAM,
  LOCALES,
  type Locale,
} from '@qiwu/shared'
import { clsGet } from '../context/cls.js'
import type { ParamService } from '../settings/param.service.js'

/** Exact tag first (case-insensitive), then by language: `en-GB` → en-US, `zh`/`zh-TW` → zh-CN. */
export function matchLocale(tag: string): Locale | undefined {
  const t = tag.trim().toLowerCase()
  const lang = t.split('-')[0]
  return (
    LOCALES.find((l) => l.toLowerCase() === t) ??
    LOCALES.find((l) => l.split('-')[0]!.toLowerCase() === lang)
  )
}

/** Best supported locale of an `Accept-Language` header (by q, then order; q=0 excluded). */
function fromAcceptLanguage(header: string): Locale | undefined {
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.split(';')
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
      return { tag, q: q === undefined ? 1 : Number(q.slice(2)) }
    })
    .filter(({ q }) => q > 0)
    .sort((a, b) => b.q - a.q) // stable: equal q keeps header order
  for (const { tag } of ranked) {
    const locale = matchLocale(tag)
    if (locale) return locale
  }
  return undefined
}

type Req = IncomingMessage & { query?: Record<string, unknown> }

/** The language the request asks for explicitly: `?lang=`, then `Accept-Language`; unsupported ones are skipped. */
export function requestLocale(req: Req): Locale | undefined {
  const lang = req.query?.lang
  return (
    (typeof lang === 'string' ? matchLocale(lang) : undefined) ??
    fromAcceptLanguage(req.headers['accept-language'] ?? '')
  )
}

/**
 * Response language (see docs/design-notes.md#api-envelope): `?lang` → `Accept-Language` → the signed-in user's locale (CLS
 * principal, set by the auth guard) → zh-CN.
 */
export const resolveLocale = (req: Req): Locale =>
  requestLocale(req) ?? clsGet('principal')?.locale ?? DEFAULT_LOCALE

/** Same chain from the request context (CLS `locale` = the request's explicit choice), for non-HTTP callers. */
export const currentLocale = (): Locale =>
  clsGet('locale') ?? clsGet('principal')?.locale ?? DEFAULT_LOCALE

/** A valid IANA zone from `X-Timezone`, canonicalized (`utc` → `UTC`); anything else → null. */
export function timezoneOf(header: string | undefined): string | null {
  if (!header || !/^[\w+/-]{1,64}$/.test(header)) return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: header }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/** Request zone (unless null is passed), then configured default; a stored user zone can be first choice. */
export async function currentTimezone(
  params: ParamService,
  preferred: string | null | undefined = clsGet('timezone'),
): Promise<string> {
  return (
    preferred ??
    timezoneOf((await params.get(DEFAULT_TIMEZONE_PARAM)) ?? undefined) ??
    DEFAULT_TIMEZONE
  )
}
