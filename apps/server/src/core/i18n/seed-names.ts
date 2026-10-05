import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOCALES, seedKeysMatching, type SeedTexts } from '@qiwu/shared'
import { i18nDirs } from '../paths.js'

let texts: SeedTexts[] | undefined

/**
 * The seed keys under `prefix` (`seed.position.`) whose text in any language contains `term` (see docs/design-notes.md#i18n),
 * from the shared `<lang>/seed.json` files (read once): a list filter on a seeded name column is
 * `name LIKE %term% OR name IN (these keys)`.
 */
export function seedKeysLike(prefix: string, term: string): string[] {
  texts ??= LOCALES.flatMap((lang) =>
    i18nDirs()
      .map((dir) => join(dir, lang, 'seed.json'))
      .filter((file) => existsSync(file))
      .map((file) => JSON.parse(readFileSync(file, 'utf8')) as SeedTexts),
  )
  return seedKeysMatching(term, prefix, texts)
}
