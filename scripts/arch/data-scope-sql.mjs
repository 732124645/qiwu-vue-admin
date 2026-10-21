// Raw SQL and data scope (see docs/data-scope.md, docs/design-notes.md#data-scope). The ORM path
// (`scopedQb`) adds the caller's data scope; SQL written as text does not. In apps/server/src (spec files
// and migrations aside) a string or template literal naming the table of a data-scoped entity after FROM
// or JOIN (subqueries and DELETE FROM included) is a template literal that interpolates a `.sql`
// (`${scope.sql}`) inside a function whose own body calls `dataScopeSql(` or `dataScopeSqlFor(` (a call in a
// nested function counts for that function only; the literal may sit in a callback of the calling one), or
// carries `qw:no-data-scope <reason>` on one of its lines or on a comment line right above (the reason is
// required). A plain string cannot hold the scope, so it always needs the marker. A query builder call
// `from` / `addFrom` / `…Join…` naming such a table as a string bypasses `scopedQb`: it needs the marker.
// Data-scoped tables: the `@Entity('<table>')` of every class decorated with `@DataScoped(…)` in
// apps/server/src. No baseline: every hit fails.
// A heuristic over literals, with the SQL reader of tenant-sql: SQL assembled from several literals, table
// names in variables, a bracketed table reference (`FROM (t)`) and dataScopeSql wrapped in a helper method
// are not seen.
import ts from 'typescript'
import { calleeName, literalText, tableRefs, tokenize } from './tenant-sql.mjs'

export const help = [
  {
    match: /query builder/,
    fix: 'Query the entity through scopedQb() of its service instead of a table-name string, or add a `qw:no-data-scope <reason>` comment when the read does not act for the caller.',
    doc: 'docs/data-scope.md#手写-sql',
  },
  {
    fix: "Call dataScopeSql()/dataScopeSqlFor() in the same function and interpolate `${scope.sql}` into this template literal (its params at the matching position), or add a `qw:no-data-scope <reason>` comment for a system query that does not read on the caller's behalf.",
    doc: 'docs/data-scope.md#手写-sql',
  },
]

const SRC = 'apps/server/src/'
const MIGRATIONS = 'apps/server/src/db/migrations/'
const MARK = /qw:no-data-scope\s+(?!\*\/)\S/
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/
const SCOPE_CALLS = new Set(['dataScopeSql', 'dataScopeSqlFor'])
const READS = new Set(['from', 'join', 'straight_join'])
const QB_TABLE = /^(from|addFrom)$|Join/

const parse = (file, raw) => ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true)

/** The tables of the classes decorated with `@DataScoped(…)`, from their `@Entity('<table>')`. */
function scopedTables(sources) {
  const tables = new Set()
  for (const [file, raw] of sources) {
    if (!raw.includes('DataScoped')) continue
    const visit = (n) => {
      if (ts.isClassDeclaration(n)) {
        const calls = (ts.getDecorators(n) ?? [])
          .map((d) => d.expression)
          .filter((e) => ts.isCallExpression(e))
        const named = (name) => calls.find((c) => calleeName(c) === name)
        if (named('DataScoped')) {
          const table = named('Entity')?.arguments[0]
          if (!table || !ts.isStringLiteralLike(table))
            throw new Error(`${file}: @DataScoped ${n.name?.text} without @Entity('<table>')`)
          tables.add(table.text)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(parse(file, raw))
  }
  return tables
}

/** Whether `fn`'s own body calls dataScopeSql / dataScopeSqlFor (the bodies of nested functions not). */
function callsScope(fn) {
  let found = false
  const visit = (n) => {
    if (found || ts.isFunctionLike(n)) return
    if (ts.isCallExpression(n) && SCOPE_CALLS.has(calleeName(n))) found = true
    else ts.forEachChild(n, visit)
  }
  if (fn.body) visit(fn.body)
  return found
}

function fileViolations(file, raw, tables) {
  const lines = raw.split('\n')
  const marked = (from, to) =>
    lines.slice(from - 1, to).some((l) => MARK.test(l)) ||
    (from >= 2 && COMMENT_LINE.test(lines[from - 2]) && MARK.test(lines[from - 2]))
  const sf = parse(file, raw)
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1
  const scoped = new Map()
  const inScopedFunction = (n) => {
    for (let p = n.parent; p; p = p.parent) {
      if (!ts.isFunctionLike(p)) continue
      if (!scoped.has(p)) scoped.set(p, callsScope(p))
      if (scoped.get(p)) return true
    }
    return false
  }
  const out = new Set()
  const visit = (n) => {
    const text = literalText(n)
    if (text !== undefined) {
      const toks = tokenize(text)
      const read = tableRefs(toks)
        .filter((r) => READS.has(toks[r.at].v) && tables.has(r.table))
        .map((r) => r.table)
      const from = lineOf(n.getStart(sf))
      if (
        read.length &&
        !marked(from, lineOf(n.getEnd())) &&
        !(
          ts.isTemplateExpression(n) &&
          n.templateSpans.some(
            (s) => ts.isPropertyAccessExpression(s.expression) && s.expression.name.text === 'sql',
          ) &&
          inScopedFunction(n)
        )
      )
        for (const table of read)
          out.add(
            `${file}:${from} ${table}: raw SQL on a data-scoped table: add dataScopeSql(…) or qw:no-data-scope <reason>`,
          )
    }
    if (ts.isCallExpression(n) && QB_TABLE.test(calleeName(n) ?? ''))
      for (const a of n.arguments) {
        const at = lineOf(a.getStart(sf))
        if (ts.isStringLiteralLike(a) && tables.has(a.text) && !marked(at, at))
          out.add(
            `${file}:${at} ${a.text}: query builder on a data-scoped table by name: use scopedQb or qw:no-data-scope <reason>`,
          )
      }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return [...out]
}

export default function ({ files, read }) {
  const sources = files(`${SRC}**/*.ts`)
    .filter((f) => !f.endsWith('.spec.ts'))
    .map((f) => [f, read(f)])
  const tables = scopedTables(sources)
  const violations = []
  for (const [file, raw] of sources)
    if (!file.startsWith(MIGRATIONS)) violations.push(...fileViolations(file, raw, tables))
  return violations
}
