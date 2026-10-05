export const LOCALES = ['zh-CN', 'en-US'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'zh-CN'

/** Per-locale text stored in `*_i18n` JSON columns (dict labels, admin-created menu names, …). */
export type I18nText = Partial<Record<Locale, string>>

/** A locale message tree, as in the vue-i18n / nestjs-i18n JSON files. */
export interface Messages {
  [key: string]: string | Messages
}

/**
 * Deep-merges one locale file into `messages` (see docs/design-notes.md#i18n, #codegen): `<ns>.json` is namespace `<ns>`; a module
 * fragment `<domain>.<biz>.json` (a dot in its name) holds whole top-level namespaces itself, e.g.
 * `{"iam":{"position":{…}},"menu":{"iam":{"position":"…"}}}`, so a generated module adds its keys without
 * editing a shared file. Objects are copied, never shared with `content`; `i18n:check` rejects a key that
 * two files define.
 */
export function mergeLocaleFile(messages: Messages, path: string, content: Messages): Messages {
  const name = (path.split(/[\\/]/).pop() ?? '').replace(/\.json$/, '')
  return mergeMessages(messages, name.includes('.') ? content : { [name]: content })
}

function mergeMessages(target: Messages, source: Messages): Messages {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key]
    target[key] =
      typeof value === 'string'
        ? value
        : mergeMessages(typeof current === 'object' ? current : {}, value)
  }
  return target
}
