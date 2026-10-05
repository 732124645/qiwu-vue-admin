import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecutionContext } from '@nestjs/common'
import { DEFAULT_LOCALE, LOCALES, mergeLocaleFile, type Messages } from '@qiwu/shared'
import { I18nLoader, I18nModule, type I18nResolver } from 'nestjs-i18n'
import { i18nDirs } from '../paths.js'
import { currentLocale, resolveLocale } from './locale.js'

/** One resolver with the whole chain (`locale.ts`), shared with the error filter. */
class LocaleResolver implements I18nResolver {
  resolve(ctx: ExecutionContext) {
    return ctx.getType() === 'http'
      ? resolveLocale(ctx.switchToHttp().getRequest())
      : currentLocale()
  }
}

/**
 * Every JSON under `<dir>/<lang>/` of the locale dirs, sub-folders included (the shared module fragments in
 * `modules/`), deep-merged per language by `mergeLocaleFile`: `<ns>.json` namespaces and `<domain>.<biz>.json`
 * module fragments (see docs/design-notes.md#codegen). nestjs-i18n's own JSON loader would take a fragment's first name part as a
 * namespace and replace, not merge, what two files share.
 */
function localeMessages(dirs: string[]): Record<string, Messages> {
  const messages: Record<string, Messages> = {}
  for (const lang of LOCALES)
    for (const root of dirs.map((dir) => join(dir, lang)).filter((d) => existsSync(d)))
      for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' }).sort())
        if (file.endsWith('.json'))
          mergeLocaleFile(
            (messages[lang] ??= {}),
            file,
            JSON.parse(readFileSync(join(root, file), 'utf8')) as Messages,
          )
  return messages
}

class LocaleFilesLoader extends I18nLoader {
  constructor(private readonly dirs: string[]) {
    super()
  }
  async languages() {
    return [...LOCALES]
  }
  async load() {
    return localeMessages(this.dirs)
  }
}

/**
 * Backend messages (see docs/design-notes.md#i18n), `{name}` placeholders like vue-i18n. Locale JSON from `i18nDirs()`:
 * dist/i18n when built, src/i18n + the shared validation/field/seed JSON when run from source.
 * The language is resolved in nestjs-i18n's interceptor, i.e. after the guards, so the signed-in user's
 * locale is known (its middleware would run before authentication).
 */
export const CoreI18nModule = I18nModule.forRoot({
  fallbackLanguage: DEFAULT_LOCALE,
  loaders: [new LocaleFilesLoader(i18nDirs())],
  resolvers: [new LocaleResolver()],
  disableMiddleware: true,
})
