// docs/design-notes.md#security: parameterized SQL only (apps/server/src). Flags, across line breaks:
//  1. the first argument of .query/.where/.andWhere/.orWhere/.having/.orderBy/.addOrderBy/.groupBy/
//     .select/.addSelect/.setParameter-free raw calls being a template literal with `${`, or a string
//     concatenated with a non-literal via `+` (literal-only 'a' + 'b' is fine);
//  2. .query(<identifier>) — SQL prebuilt elsewhere; pass a literal with ? / :params instead;
//  3. any template literal with `${` whose text contains SQL keywords (prebuilt SQL strings).
// Escape hatch (almost never, e.g. an alias/identifier the code itself chose, never a value):
// `// arch-allow: sql-concat <reason>` on the flagged line or the line directly above it.
const CALL =
  /\.(query|where|andWhere|orWhere|having|orderBy|addOrderBy|groupBy|select|addSelect)\s*\(\s*/g
const SQL_WORDS = /\b(select|insert|update|delete|where|from|join|values|order\s+by|group\s+by)\b/i
const ALLOW = /\/\/\s*arch-allow:\s*sql-concat\s+\S/

// Masks // and /* */ comments with spaces (line breaks kept) so offsets still map to lines.
const maskComments = (src) =>
  src.replace(
    /\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g,
    (m, pre = '') => pre + m.slice(pre.length).replace(/[^\n]/g, ' '),
  )

// Literal-only concatenation ('a' + 'b') is fine; anything left after removing literals is a value.
const stripLiterals = (s) =>
  s.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\$]|\\.)*`/g, '')

// First call argument (text up to the top-level ',' or ')'); good enough for guard purposes.
function firstArg(src, start) {
  let depth = 0
  let quote = null
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '`' || c === '"' || c === "'") quote = c
    else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) {
      if (depth === 0) return src.slice(start, i)
      depth--
    } else if (c === ',' && depth === 0) return src.slice(start, i)
  }
  return src.slice(start)
}

export default function ({ files, read }) {
  const out = []
  for (const file of files('apps/server/src/**/*.ts')) {
    const raw = read(file)
    const src = maskComments(raw)
    const rawLines = raw.split('\n')
    const lineOf = (i) => src.slice(0, i).split('\n').length
    const allowed = (n) => ALLOW.test(rawLines[n - 1] ?? '') || ALLOW.test(rawLines[n - 2] ?? '')
    const flag = (index, why) => {
      const n = lineOf(index)
      if (!allowed(n)) out.push(`${file}:${n} ${why}; use a literal with :params`)
    }
    for (const m of src.matchAll(CALL)) {
      const argStart = m.index + m[0].length
      const arg = firstArg(src, argStart).trim()
      if (/^`[\s\S]*\$\{/.test(arg)) flag(argStart, `.${m[1]}() SQL built by interpolation`)
      else if (/\+/.test(arg) && /[\w$]/.test(stripLiterals(arg)))
        flag(argStart, `.${m[1]}() SQL built by concatenation`)
      else if (m[1] === 'query' && /^[A-Za-z_$][\w$.]*$/.test(arg))
        flag(argStart, `.query(${arg}) runs prebuilt SQL`)
    }
    for (const m of src.matchAll(/`(?:[^`\\]|\\.)*\$\{(?:[^`\\]|\\.)*`/g)) {
      const text = m[0].replace(/\$\{[^}]*\}/g, '')
      if (SQL_WORDS.test(text)) flag(m.index, 'SQL template literal with interpolation')
    }
  }
  return [...new Set(out)]
}
