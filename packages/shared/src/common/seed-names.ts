/** A `seed.json` (`packages/shared/src/i18n/<lang>/seed.json`): the texts of seeded display names. */
export interface SeedTexts {
  [name: string]: string | SeedTexts
}

/**
 * Seeded display names are stored as i18n keys (`seed.position.engLead`; see docs/design-notes.md#i18n), so a name search
 * must also find a row by the text the user sees: the keys under `prefix` (`seed.position.`) whose text in
 * any of `langs` contains `term`, ignoring case like MySQL's `LIKE`. The list filter is then
 * `name LIKE %term% OR name IN (these keys)`.
 */
export function seedKeysMatching(term: string, prefix: string, langs: SeedTexts[]): string[] {
  const needle = term.toLowerCase()
  const keys = new Set<string>()
  const walk = (texts: SeedTexts, path: string) => {
    for (const [name, value] of Object.entries(texts)) {
      const key = `${path}.${name}`
      if (typeof value !== 'string') walk(value, key)
      else if (key.startsWith(prefix) && value.toLowerCase().includes(needle)) keys.add(key)
    }
  }
  for (const texts of langs) walk(texts, 'seed')
  return [...keys]
}
