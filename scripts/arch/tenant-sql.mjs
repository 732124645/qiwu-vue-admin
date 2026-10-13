// Raw SQL and the tenant (see docs/design-notes.md#tenancy). The ORM adds the tenant condition by itself;
// SQL written as text does not get it. In apps/server/src (spec files aside):
//  1. A string or template literal naming a tenant table after FROM / JOIN / UPDATE (DELETE FROM too,
//     subqueries included; the migrations aside) holds a tenant_id condition of its own:
//     `<alias>.tenant_id = …` / `IN (…)` (`<table>.tenant_id` for a table without an alias; a bare
//     `tenant_id` when the statement reads a single table), in a WHERE or ON clause where it is ANDed at
//     every level: an OR beside it (`a OR b AND t.tenant_id = ?`) lets rows of other tenants in, so the
//     rest is bracketed first (`(a OR b) AND t.tenant_id = ?`). The condition stands in the same query as
//     the table (one in a subquery filters nothing outside it). One in an ON clause counts for the table
//     that JOIN brings in only, never for a RIGHT JOIN's: an outer join keeps its other side whatever ON
//     says, so the main table and a RIGHT JOIN's kept side are filtered in WHERE. A table joined in needs
//     its own condition whatever the main table is. `INSERT [INTO]` / `REPLACE [INTO]` a tenant table
//     lists tenant_id (INSERT … SELECT and ON DUPLICATE KEY UPDATE too; the SELECT part is rule 1 again).
//  2. Every withTenant( / allTenants( call outside core/context carries a reason.
//  3. Only core/context and core/auth write the tenant keys of the request context (tenantId,
//     allTenants, actorTenantId) directly (`set('<key>', …)`, a store literal holding one handed to
//     `runWith` / `enterWith`, or `<store>.<key> = …`); everyone else goes through withTenant /
//     allTenants.
//  4. Every `arch-allow: sql-concat` comment says how the assembled SQL stays in its tenant
//     (`tenant: <how>`) or why it crosses tenants (`qw:cross-tenant <reason>`), migrations included.
// What breaks rule 1 or 2 on purpose carries `qw:cross-tenant <reason>` on one of its lines or on a
// comment line right above (the end of the statement above is not this one's); rule 3 has no such way
// out.
// Tenant tables: the tables of `CREATE TABLE` in the migrations minus PLATFORM_TABLES
// (apps/server/src/core/db/tenant-tables.ts, read as text).
// Baseline: none (the file is gone, a missing one reads as `{}`), so every hit fails. Should one be
// needed again, tenant-sql.baseline.json (beside this file) holds per-file counts of the rule 1
// statements left to fix; more than that fails, fewer is fine. Rules 2 to 4 have no baseline: each of
// their hits fails. `node scripts/arch/tenant-sql.mjs --update-baseline` (or run.mjs with
// --update-baseline) lowers the counts to what is found, never raises them, and deletes the file once
// nothing is left.
// A heuristic over literals: SQL assembled from several literals or with table names in variables is not
// seen (rule 4 covers the assembled kind).
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const SRC = 'apps/server/src/'
const MIGRATIONS = 'apps/server/src/db/migrations/'
const TABLES_FILE = 'apps/server/src/core/db/tenant-tables.ts'
const BASELINE = 'scripts/arch/tenant-sql.baseline.json'
const MARK = /qw:cross-tenant\s+\S/
const CONCAT = /\/\/\s*arch-allow:\s*sql-concat\b/
const NOTE = /\btenant:\s*\S|qw:cross-tenant\s+\S/
const PRIMITIVES = new Set(['withTenant', 'allTenants'])
const CLS_KEYS = new Set(['tenantId', 'allTenants', 'actorTenantId'])
const CLS_WRITES = new Set(['set', 'setIfUndefined', 'clsSet'])
// calls taking a whole store: `runWith(store, fn)`, `enterWith(store)`
const CLS_STORES = new Set(['runWith', 'enterWith'])
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/
const CLS_WRITERS = /^apps\/server\/src\/core\/(context|auth)\//
// an interpolation `${…}`: a word no table or alias is named
const HOLE = '__expr__'

// --- SQL text ---------------------------------------------------------------------------------------

const TOKEN =
  /\s+|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`([^`]*)`|([A-Za-z_][\w$]*)|(<=>|<>|!=|>=|<=|\|\||&&|\S)/gy
// words ending a clause, or starting one, at their bracket level
const CLAUSE = new Set(
  'where on having set select from join straight_join values value group order limit update using into union window returning'.split(
    ' ',
  ),
)
// words that may follow a table name without being its alias
const NOT_ALIAS = new Set(
  'where on join inner left right cross natural straight_join full outer set order group limit using for lock union having as values value select and or force use ignore window partition when then into returning duplicate key skip nowait share'.split(
    ' ',
  ),
)
const OR = new Set(['or', 'xor', '||'])

/** Words (lowercased; `` `name` `` too), strings and symbols, each with its bracket level. */
function tokenize(text) {
  const out = []
  let depth = 0
  TOKEN.lastIndex = 0
  for (let m; TOKEN.lastIndex < text.length && (m = TOKEN.exec(text));) {
    if (/^\s/.test(m[0])) continue
    const word = m[1] ?? m[2]
    const v = word !== undefined ? word.toLowerCase() : /^['"]/.test(m[0]) ? '' : m[3]
    const kind = word !== undefined ? 'word' : /^['"]/.test(m[0]) ? 'str' : 'sym'
    if (v === ')') depth = Math.max(0, depth - 1)
    out.push({ v, kind, depth })
    if (v === '(') depth++
  }
  return out
}

const isWord = (t, ...words) => t?.kind === 'word' && (!words.length || words.includes(t.v))

/** Index of the `)` closing the `(` at `open`, or the end. */
function closing(toks, open) {
  for (let i = open + 1; i < toks.length; i++)
    if (toks[i].v === ')' && toks[i].depth === toks[open].depth) return i
  return toks.length
}

/**
 * For each token, the index of the `(` opening the subquery it stands in, -1 at the top level: a
 * condition filters the tables of its own query only.
 */
function queryLevels(toks) {
  const out = []
  const open = [-1]
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].v === ')' && open.length > 1) open.pop()
    out.push(open.at(-1))
    if (toks[k].v === '(') open.push(isWord(toks[k + 1], 'select') ? k : open.at(-1))
  }
  return out
}

/**
 * The tables a statement names: `{ table, alias, into, columns, at, right }` after FROM (a comma list
 * too), JOIN, UPDATE (not `FOR UPDATE` nor `ON DUPLICATE KEY UPDATE`), INTO (with its column list) and
 * INSERT / REPLACE without INTO; `at` = the index of that word, `right` = a RIGHT JOIN.
 */
function tableRefs(toks) {
  const refs = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (!isWord(t, 'from', 'join', 'straight_join', 'update', 'into', 'insert', 'replace')) continue
    if (t.v === 'update' && isWord(toks[i - 1], 'key', 'for')) continue
    const writes = t.v === 'update' || t.v === 'insert' || t.v === 'replace'
    let j = i + 1
    while (writes && isWord(toks[j], 'low_priority', 'high_priority', 'delayed', 'ignore')) j++
    // `INSERT … INTO t`: the INTO names it
    if (t.v !== 'update' && writes && isWord(toks[j], 'into')) continue
    const into = t.v === 'into' || t.v === 'insert' || t.v === 'replace'
    const right =
      t.v === 'join' && isWord(toks[isWord(toks[i - 1], 'outer') ? i - 2 : i - 1], 'right')
    for (;;) {
      if (!isWord(toks[j])) break
      // `schema.table`
      if (toks[j + 1]?.v === '.' && isWord(toks[j + 2])) j += 2
      const ref = { table: toks[j].v, alias: undefined, into, columns: [], at: i, right }
      j++
      if (isWord(toks[j], 'as') && isWord(toks[j + 1])) j++
      if (isWord(toks[j]) && !NOT_ALIAS.has(toks[j].v)) ref.alias = toks[j++].v
      if (ref.into) {
        if (toks[j]?.v === '(') {
          const end = closing(toks, j)
          for (let k = j + 1; k < end; k++)
            if (isWord(toks[k]) && toks[k].depth === toks[j].depth + 1) ref.columns.push(toks[k].v)
        } else if (isWord(toks[j], 'set'))
          for (let k = j + 1; k < toks.length && !isWord(toks[k], 'on'); k++)
            if (isWord(toks[k]) && toks[k + 1]?.v === '=') ref.columns.push(toks[k].v)
      }
      refs.push(ref)
      // `FROM a x, b y` / `UPDATE a, b`
      if (t.v !== 'from' && t.v !== 'update') break
      if (toks[j]?.v !== ',' || toks[j].depth !== t.depth) break
      j++
    }
  }
  return refs
}

/**
 * Where a condition at token `start` stands: its clause word (`where`, `on`, …) and the brackets around
 * it inside that clause; undefined when no clause word is found at its level (a select list of a
 * subquery, …).
 */
function clauseOf(toks, start) {
  let level = toks[start].depth
  const groups = []
  for (let j = start - 1; j >= 0; j--) {
    const t = toks[j]
    if (t.depth > level) continue
    if (t.depth < level) {
      // the bracket this level opened: a subquery ended without a clause word, else a group
      if (isWord(toks[j + 1], 'select')) return undefined
      groups.push(j)
      level = t.depth
      continue
    }
    if (isWord(t) && CLAUSE.has(t.v)) return { word: t.v, at: j, groups }
  }
  return undefined
}

/** Whether an OR stands at bracket level `level` between tokens `from` and `to` (exclusive). */
function orAt(toks, from, to, level) {
  for (let k = from; k < to; k++) {
    const t = toks[k]
    if (t.depth < level) return false
    if (t.depth === level && OR.has(t.v)) return true
  }
  return false
}

/**
 * The tenant_id conditions of a statement: `{ qual, anded, level, on }`, `qual` = the alias or table
 * before `.tenant_id` (null for a bare one), `anded` = in a WHERE or ON clause with no OR beside it at
 * any level, `level` = its query (queryLevels), `on` = in an ON clause: the ref that JOIN brings in (null
 * for a RIGHT JOIN or a bracketed join), undefined in WHERE.
 */
function tenantConditions(toks, refs, levels) {
  const out = []
  for (let i = 0; i < toks.length; i++) {
    if (!isWord(toks[i], 'tenant_id')) continue
    const next = toks[i + 1]
    if (!(next?.v === '=' || next?.v === '<=>' || isWord(next, 'in'))) continue
    const qualified = toks[i - 1]?.v === '.' && isWord(toks[i - 2])
    const start = qualified ? i - 2 : i
    const clause = clauseOf(toks, start)
    if (!clause || (clause.word !== 'where' && clause.word !== 'on')) continue
    const base = toks[clause.at].depth
    let end = clause.at + 1
    while (
      end < toks.length &&
      toks[end].depth >= base &&
      !(toks[end].depth === base && isWord(toks[end]) && CLAUSE.has(toks[end].v))
    )
      end++
    let anded = !orAt(toks, clause.at + 1, end, base)
    for (const g of clause.groups)
      if (orAt(toks, g + 1, closing(toks, g), toks[g].depth + 1)) anded = false
    let on
    if (clause.word === 'on') {
      let join = clause.at - 1
      while (
        join >= 0 &&
        !(toks[join].depth === base && isWord(toks[join], 'join', 'straight_join'))
      )
        join--
      const ref = refs.find((r) => r.at === join)
      on = ref && !ref.right ? ref : null
    }
    out.push({ qual: qualified ? toks[i - 2].v : null, anded, level: levels[i], on })
  }
  return out
}

/** What a statement does wrong with tenant tables: `{ table, why }`. */
export function tenantProblems(text, tenant, known) {
  const toks = tokenize(text)
  const refs = tableRefs(toks)
  if (!refs.some((r) => tenant.has(r.table))) return []
  const read = refs.filter((r) => !r.into && known.has(r.table))
  const levels = queryLevels(toks)
  const conditions = tenantConditions(toks, refs, levels)
  const problems = []
  for (const ref of refs) {
    if (!tenant.has(ref.table)) continue
    if (ref.into) {
      if (!ref.columns.includes('tenant_id'))
        problems.push({ table: ref.table, why: 'INSERT without the tenant_id column' })
      continue
    }
    const qual = ref.alias ?? ref.table
    const own = conditions.filter(
      (c) =>
        (c.qual === qual || (c.qual === null && read.length === 1)) &&
        c.level === levels[ref.at] &&
        (c.on === undefined || c.on === ref),
    )
    if (!own.length)
      problems.push({ table: ref.table, why: `no ${qual}.tenant_id condition of its own` })
    else if (!own.some((c) => c.anded))
      problems.push({
        table: ref.table,
        why: 'tenant_id condition beside a top-level OR: bracket the rest first',
      })
  }
  return problems
}

// --- source files -----------------------------------------------------------------------------------

/** The cooked text of a string or template literal, an interpolation as one placeholder word. */
function literalText(n) {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
  if (ts.isTemplateExpression(n))
    return n.head.text + n.templateSpans.map((s) => ` ${HOLE} ${s.literal.text}`).join('')
  return undefined
}

const calleeName = (call) =>
  ts.isIdentifier(call.expression)
    ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.text
      : undefined

function readSets({ files, read }) {
  const tables = new Set()
  for (const file of files(`${MIGRATIONS}*.ts`))
    for (const m of read(file).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?`?([a-z][a-z0-9_]*)/g))
      tables.add(m[1])
  const list = read(TABLES_FILE).match(/\bPLATFORM_TABLES\b[^=]*=\s*\[([^\]]*)\]/)
  if (!list) throw new Error(`${TABLES_FILE}: PLATFORM_TABLES not found`)
  const platform = new Set([...list[1].matchAll(/['"]([a-z][a-z0-9_]*)['"]/g)].map((m) => m[1]))
  if (!platform.size) throw new Error(`${TABLES_FILE}: PLATFORM_TABLES is empty`)
  return { known: tables, tenant: new Set([...tables].filter((t) => !platform.has(t))) }
}

/**
 * Every violation of one file (`<file>:<line> <what>: <why>`, one per line and table or rule): `sql` =
 * rule 1 (counted against the baseline), `other` = rules 2 to 4.
 */
function fileViolations(file, raw, { tenant, known }) {
  const lines = raw.split('\n')
  // the lines `from`..`to`, or a comment line right above them
  const marked = (from, to) =>
    lines.slice(from - 1, to).some((l) => MARK.test(l)) ||
    (from >= 2 && COMMENT_LINE.test(lines[from - 2]) && MARK.test(lines[from - 2]))
  const other = new Set()
  const sqlOut = new Set()
  lines.forEach((l, i) => {
    if (CONCAT.test(l) && !NOTE.test(l))
      other.add(`${file}:${i + 1} sql-concat: say how it stays in its tenant (tenant: …)`)
  })
  const sf = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true)
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1
  const sql = !file.startsWith(MIGRATIONS)
  const context = file.startsWith('apps/server/src/core/context/')
  const clsWrite = (at, key) => {
    if (!CLS_WRITERS.test(file))
      other.add(`${file}:${at} ${key}: written outside core/context and core/auth`)
  }
  const visit = (n) => {
    const text = sql ? literalText(n) : undefined
    if (text !== undefined) {
      const from = lineOf(n.getStart(sf))
      const problems = tenantProblems(text, tenant, known)
      if (problems.length && !marked(from, lineOf(n.getEnd())))
        for (const { table, why } of problems) sqlOut.add(`${file}:${from} ${table}: ${why}`)
    }
    if (ts.isCallExpression(n)) {
      const name = calleeName(n)
      const at = lineOf(n.getStart(sf))
      if (!context && PRIMITIVES.has(name) && !marked(at, at))
        other.add(`${file}:${at} ${name}: crosses tenants without a qw:cross-tenant reason`)
      const key = n.arguments[0]
      if (CLS_WRITES.has(name) && key && ts.isStringLiteralLike(key) && CLS_KEYS.has(key.text))
        clsWrite(at, key.text)
      if (CLS_STORES.has(name) && key && ts.isObjectLiteralExpression(key))
        for (const p of key.properties) if (CLS_KEYS.has(p.name?.text)) clsWrite(at, p.name.text)
    }
    // `<store>.tenantId = …` / `<store>['tenantId'] ??= …`
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = n.left
      const key = ts.isPropertyAccessExpression(target)
        ? target.name.text
        : ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)
          ? target.argumentExpression.text
          : undefined
      if (CLS_KEYS.has(key)) clsWrite(lineOf(n.getStart(sf)), key)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return { sql: [...sqlOut], other: [...other] }
}

export default function ({ root, files, read, updateBaseline }) {
  const sets = readSets({ files, read })
  const found = new Map()
  const violations = []
  for (const file of files(`${SRC}**/*.ts`)) {
    if (file.endsWith('.spec.ts')) continue
    const { sql, other } = fileViolations(file, read(file), sets)
    violations.push(...other)
    if (sql.length) found.set(file, sql)
  }

  let baseline = {}
  try {
    baseline = JSON.parse(read(BASELINE))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  for (const [file, hits] of found)
    if (hits.length > (baseline[file] ?? 0)) violations.push(...hits)
  if (updateBaseline) {
    const lowered = {}
    for (const [file, allowed] of Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b))) {
      const n = Math.min(allowed, found.get(file)?.length ?? 0)
      if (n) lowered[file] = n
    }
    if (Object.keys(lowered).length)
      writeFileSync(join(root, BASELINE), `${JSON.stringify(lowered, null, 2)}\n`)
    else rmSync(join(root, BASELINE), { force: true })
  }
  return violations
}

// `node scripts/arch/tenant-sql.mjs [--update-baseline] [--root <dir>]`: this check alone
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const run = join(dirname(fileURLToPath(import.meta.url)), 'run.mjs')
  const r = spawnSync(process.execPath, [run, '--only', 'tenant-sql', ...process.argv.slice(2)], {
    stdio: 'inherit',
  })
  process.exit(r.status ?? 1)
}
