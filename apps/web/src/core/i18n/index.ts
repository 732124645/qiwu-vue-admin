import { computed } from 'vue'
import { createI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import epEn from 'element-plus/es/locale/lang/en'
import epZhCn from 'element-plus/es/locale/lang/zh-cn'
import {
  DEFAULT_LOCALE,
  LOCALES,
  mergeLocaleFile,
  type I18nText,
  type Locale,
  type Messages,
} from '@qiwu/shared'
import { sharedMessages } from '@/core/form/zod-rules'

// locales/<lang>/<namespace>.json → messages[lang][namespace], a module fragment
// locales/<lang>/<domain>.<biz>.json (generated modules; see docs/design-notes.md#codegen) deep-merged at the root; on top of the
// shared validation/field messages and seeded display names (seed.*: the server searches them too; see docs/design-notes.md#i18n).
const files = import.meta.glob<Messages>('/src/locales/*/**/*.json', {
  eager: true,
  import: 'default',
})
const messages = structuredClone(sharedMessages)
for (const [path, content] of Object.entries(files)) {
  const [, lang = ''] = path.match(/\/locales\/([^/]+)\//) ?? []
  mergeLocaleFile((messages[lang] ??= {}), path, content)
}

const STORAGE_KEY = 'qw.locale'
const isLocale = (v: unknown): v is Locale => LOCALES.includes(v as Locale)

/** localStorage → navigator.language (exact, then language prefix) → zh-CN. */
export function detectLocale(): Locale {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(STORAGE_KEY)
  } catch {
    // storage blocked: fall through to the browser language
  }
  if (isLocale(saved)) return saved
  const nav = navigator.language ?? ''
  return (
    LOCALES.find((l) => l.toLowerCase() === nav.toLowerCase()) ??
    LOCALES.find((l) => l.split('-')[0] === nav.split('-')[0]) ??
    DEFAULT_LOCALE
  )
}

export const i18n = createI18n({
  legacy: false,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  messages,
})

/** Current locale; also the source of the `Accept-Language` request header. */
export const currentLocale = () => i18n.global.locale.value as Locale

const EP = { 'zh-CN': epZhCn, 'en-US': epEn } as const
const DAYJS = { 'zh-CN': 'zh-cn', 'en-US': 'en' } as const

/** For `<el-config-provider :locale="elementLocale">`. */
export const elementLocale = computed(() => EP[currentLocale()])

// ECharts registers its ZH and EN texts itself (echarts/core); importing ECharts here to register them
// again would pull it into the main chunk, so the charts read the name and rebuild with it (QwChart).
const ECHARTS = { 'zh-CN': 'ZH', 'en-US': 'EN' } as const
/**
 * ECharts' language (legend selector, aria descriptions, toolbox): QwChart's `init-options.locale` and
 * its `:key`, so a switch rebuilds every chart in the new language.
 */
export const chartLocale = computed(() => ECHARTS[currentLocale()])

const FORM_CREATE = { 'zh-CN': 'zh-cn', 'en-US': 'en' } as const
/**
 * form-create's language: a renderer's `locale` prop (its validation messages) and the designer's locale
 * texts (FormDesigner, which hands it to its own renderers and the preview).
 */
export const formLocale = computed(() => FORM_CREATE[currentLocale()])

function apply(locale: Locale) {
  i18n.global.locale.value = locale
  dayjs.locale(DAYJS[locale])
  document.documentElement.lang = locale
}

/**
 * Switches vue-i18n, Element Plus, dayjs, ECharts (`chartLocale`), form-create (`formLocale`), `<html lang>`
 * and the API language, and remembers it in this browser; the locale store also saves it to the signed-in
 * account.
 */
export function setLocale(locale: Locale) {
  apply(locale)
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // storage blocked: the switch still applies to this page
  }
}

apply(detectLocale())

/** `te(k) ? t(k) : k` — seeded names are i18n keys, admin-created ones are plain text (see docs/design-notes.md#i18n). */
export const tx = (key: string) => (i18n.global.te(key) ? i18n.global.t(key) : key)

/** A session's client (online users, sign-in log): `console` → computer, `mobile` → phone, else the OAuth2 client id. */
export const clientName = (clientId: string) =>
  i18n.global.te(`common.client.${clientId}`)
    ? i18n.global.t(`common.client.${clientId}`)
    : clientId

/**
 * The name of a row another row points to (`<ref>Id` + joined `<ref>Name`), shown as typed (never `tx`: user and
 * admin text that looks like a key must not turn into a seeded label; wrap in `tx` where names are seeded keys).
 * Once that row is deleted the API keeps the id and sends the name as null (soft delete) → `#<id> (deleted)`;
 * no id → ''.
 */
export const refName = (id: number | null | undefined, name: string | null | undefined) =>
  name || (id == null ? '' : i18n.global.t('common.ref.deleted', { id }))

/** Per-locale DB text (`name_i18n` / `label_i18n`) first, then `tx(fallback)`. */
export const localized = (text: I18nText | null | undefined, fallback: string) =>
  text?.[currentLocale()] || tx(fallback)
