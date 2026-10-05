// vue-i18n holds the locale; texts come only through `t()` below, never vue-i18n's own t/$t:
// the uni runtime does no `{name}` interpolation on mp-weixin/App, and a full vue-i18n build compiles messages
// with `new Function`, which mp-weixin forbids. Keys as on the web (see docs/design-notes.md#i18n): mobile's locales/<lang>/<ns>.json
// over the shared validation.* / field.* / seed.* messages, so the shared schemas' messages and seeded names work.
import { createI18n } from 'vue-i18n'
import {
  DEFAULT_LOCALE,
  LOCALES,
  fieldDomainOf,
  fieldLabelKeys,
  mergeLocaleFile,
  validationMessage,
  type Locale,
  type Messages,
  type ObjectSchema,
  type ValidationIssue,
} from '@qiwu/shared'
import { Locale as WotLocale } from '@wot-ui/ui/locale'
import wotEnUS from '@wot-ui/ui/locale/lang/en-US'

const files = import.meta.glob<Messages>(
  ['../../../packages/shared/src/i18n/*/**/*.json', '../locales/*/**/*.json'],
  { eager: true, import: 'default' },
)
const messages: Record<string, Messages> = {}
for (const [path, content] of Object.entries(files)) {
  const lang = path.match(/\/(?:i18n|locales)\/([^/]+)\//)?.[1] ?? ''
  mergeLocaleFile((messages[lang] ??= {}), path, content)
}

const STORAGE_KEY = 'qw.locale'
const isLocale = (v: unknown): v is Locale => LOCALES.includes(v as Locale)
/** Our locales as uni names them (uni.getLocale / uni.setLocale). */
const UNI: Record<Locale, string> = { 'zh-CN': 'zh-Hans', 'en-US': 'en' }

/** The saved choice (uni.setLocale does not persist on mp-weixin), else the system language, else zh-CN. */
export function detectLocale(): Locale {
  const saved: unknown = uni.getStorageSync(STORAGE_KEY)
  if (isLocale(saved)) return saved
  return uni.getLocale().startsWith('en') ? 'en-US' : DEFAULT_LOCALE
}

const i18n = createI18n({ legacy: false, locale: detectLocale(), fallbackLocale: DEFAULT_LOCALE })

/** Current locale (reactive: what renders through `t()` follows a switch); also the API's Accept-Language. */
export const locale = () => i18n.global.locale.value as Locale

function find(lang: string, key: string): string | undefined {
  let node: string | Messages | undefined = messages[lang]
  for (const part of key.split('.')) node = typeof node === 'object' ? node[part] : undefined
  return typeof node === 'string' ? node : undefined
}

const message = (key: string) => find(locale(), key) ?? find(DEFAULT_LOCALE, key)

/** `key`'s text with `{name}` placeholders filled from `params` (unknown ones stay); a missing key → the key. */
export function t(key: string, params?: Record<string, unknown>): string {
  const msg = message(key)
  if (msg === undefined) return key
  return params
    ? msg.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all))
    : msg
}

/** Seeded names are i18n keys, admin-created ones plain text (see docs/design-notes.md#i18n): `te(k) ? t(k) : k`. */
export const tx = (text: string) => t(text)

/**
 * The message of a shared schema's zod issue, as the web's form rules build it (see docs/adr/003-validation.md): `validation.*` with
 * the issue's params, `{field}` = the first existing `field.<domain>.<prop>` / `field.common.<prop>` label.
 */
export function issueText(schema: ObjectSchema, issue: ValidationIssue): string {
  const { key, params } = validationMessage(issue)
  const label = fieldLabelKeys(fieldDomainOf(schema), issue.path).find((k) => message(k) != null)
  // no Array#findLast: older mp-weixin / App JS engines lack it
  const prop = [...issue.path].reverse().find((p): p is string => typeof p === 'string')
  return t(key, { ...params, field: label ? t(label) : (prop ?? '') })
}

/** A form's messages by top-level field, the first issue of each (render in a computed: follows a switch). */
export function fieldErrors(
  schema: ObjectSchema,
  issues: readonly ValidationIssue[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of issues) out[String(issue.path[0] ?? '')] ??= issueText(schema, issue)
  return out
}

/** Each locale's name, in its own language. */
export const LANGUAGE_KEY: Record<Locale, string> = {
  'zh-CN': 'common.language.zhCN',
  'en-US': 'common.language.enUS',
}

/** Switches our texts, wot-ui's own texts and uni's built-in UI, and remembers the choice. */
export function setLocale(next: Locale) {
  i18n.global.locale.value = next
  WotLocale.use(next, next === 'en-US' ? wotEnUS : undefined)
  uni.setLocale(UNI[next])
  uni.setStorageSync(STORAGE_KEY, next)
}
