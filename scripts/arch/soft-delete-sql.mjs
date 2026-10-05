// Raw SQL never reads soft-deleted rows by accident. Every table is soft-deleted
// (the tables of `CREATE TABLE` in apps/server/src/db/migrations). In apps/server/src (the migrations
// aside), a string or template literal naming such a table after FROM / JOIN / UPDATE (DELETE FROM too)
// must hold a `deleted_at IS [NOT] NULL` condition for it (not the column in a select list or a SET):
// `<alias>.deleted_at IS …` when the table has an alias (a bare one counts when the literal names a single
// table), else a bare one or `<table>.deleted_at IS …`, one bare condition per such table (a subquery on a
// second table needs its own). So must the condition
// of a query-builder join on a table without an entity (`.innerJoin('<table>', '<alias>', '<cond>')`;
// TypeORM adds the condition itself for an entity's table). A statement that must cover deleted rows too
// (a purge, a cache sweep, the seeds' natural-key lookups) says so: `qw:include-deleted` on one of its
// lines or the line above it.
// Baseline: soft-delete-sql.baseline.json (beside this file) holds per-file counts of the violations the
// modules still have to fix; a file may not have more, and one that has fewer must lower its
// count (the file shrinks to `{}`, then goes).
// A heuristic over literals: SQL assembled from several literals, table names in variables and
// query-builder `from`/`update` by table name are not seen; entity repositories and query builders
// filter deleted rows by themselves.
const MIGRATIONS = 'apps/server/src/db/migrations/'
const BASELINE = 'scripts/arch/soft-delete-sql.baseline.json'
const MARK = /qw:include-deleted/
const REF = /\b(from|join|update)\s+`?([a-z][a-z0-9_]*)`?(?:\s+(?:as\s+)?`?([a-z][a-z0-9_]*)`?)?/gi
// words that may follow a table name without being its alias
const NOT_ALIAS = new Set(
  'where on join inner left right cross natural straight_join set order group limit using for lock union having as values select and or force use ignore window partition when then'.split(
    ' ',
  ),
)
const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g
const JOIN =
  /\.(?:inner|left)Join(?:AndSelect)?\(\s*(['"`])([a-z][a-z0-9_]*)\1\s*,\s*(['"`])(\w+)\3\s*(?:,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`))?/g

// Masks // and /* */ comments with spaces (line breaks kept) so offsets still map to lines.
const maskComments = (src) =>
  src.replace(
    /\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g,
    (m, pre = '') => pre + m.slice(pre.length).replace(/[^\n]/g, ' '),
  )

// a deleted_at condition (`deleted_at IS [NOT] NULL`, not `… AS name`): naming the column in a select
// list or a SET filters nothing
const COND = String.raw`deleted_at\s+IS\s+(?:NOT\s+)?NULL\b(?!\s+AS\b)`

/**
 * The tables of `text` (a literal) without their own deleted_at condition: `<alias>.deleted_at IS …` for
 * an aliased table, `<table>.deleted_at IS …` or a bare `deleted_at IS …` otherwise, one bare condition
 * per table (two unaliased tables need two); a single aliased table may use a bare one too.
 */
function unfiltered(text, tables) {
  const refs = [...text.matchAll(REF)]
    .map((m) => ({ table: m[2].toLowerCase(), alias: m[3] }))
    .filter((r) => tables.has(r.table))
  let bare = text.match(new RegExp(`(^|[^.\\w])${COND}`, 'gi'))?.length ?? 0
  const qualified = (name) => new RegExp(`\\b${name}\\.${COND}`, 'i').test(text)
  return refs.filter(({ table, alias }) => {
    if (qualified(table)) return false
    const aliased = alias && !NOT_ALIAS.has(alias.toLowerCase())
    if (aliased && qualified(alias)) return false
    if ((aliased && refs.length > 1) || bare === 0) return true
    bare-- // this table takes one bare condition
    return false
  })
}

export default function ({ files, read }) {
  const tables = new Set()
  for (const file of files(`${MIGRATIONS}*.ts`))
    for (const m of read(file).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?`?([a-z][a-z0-9_]*)/g))
      tables.add(m[1])
  const entities = new Set()
  const sources = files('apps/server/src/**/*.ts').filter((f) => !f.startsWith(MIGRATIONS))
  for (const file of sources)
    for (const m of read(file).matchAll(/@Entity\(\s*['"]([a-z][a-z0-9_]*)['"]/g))
      entities.add(m[1])

  const found = new Map()
  for (const file of sources) {
    const raw = read(file)
    const src = maskComments(raw)
    const rawLines = raw.split('\n')
    const lineOf = (i) => src.slice(0, i).split('\n').length
    const marked = (from, to) => rawLines.slice(Math.max(0, from - 2), to).some((l) => MARK.test(l))
    const out = []
    const flag = (start, end, table, why) => {
      const n = lineOf(start)
      if (!marked(n, lineOf(end))) out.push(`${file}:${n} ${table}: ${why}`)
    }
    for (const m of src.matchAll(LITERAL))
      for (const { table } of unfiltered(m[0], tables))
        flag(m.index, m.index + m[0].length, table, 'raw SQL without its deleted_at condition')
    for (const m of src.matchAll(JOIN)) {
      const [, , table, , alias, cond = ''] = m
      if (!tables.has(table) || entities.has(table)) continue
      if (!new RegExp(`\\b${alias}\\.${COND}`, 'i').test(cond))
        flag(m.index, m.index + m[0].length, table, 'join without its deleted_at condition')
    }
    if (out.length) found.set(file, [...new Set(out)])
  }

  let baseline = {}
  try {
    baseline = JSON.parse(read(BASELINE))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const violations = []
  for (const file of new Set([...found.keys(), ...Object.keys(baseline)])) {
    const hits = found.get(file) ?? []
    const allowed = baseline[file] ?? 0
    if (hits.length > allowed) violations.push(...hits)
    else if (hits.length < allowed)
      violations.push(
        `${file}: ${hits.length} unfiltered statement(s), ${BASELINE} allows ${allowed}: lower it to ${hits.length}${hits.length ? '' : ' (drop the entry)'}`,
      )
  }
  return violations
}
