#!/usr/bin/env node
// i18n completeness check (rules 1–5; see docs/design-notes.md#i18n). Node stdlib only.
// Usage: node scripts/i18n-check.mjs [--root <dir>] [--self-test]   (I18N_TODO_STRICT=1 → rule 4 fails on TODOs)
// Limitations (regex-based on purpose): comments are stripped by a small tokenizer that knows '', "", `` strings
// but not regex literals or nested template literals; only literal keys are checked (t(`a.${x}`) is skipped).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const LANGS = ['zh-CN', 'en-US']
const args = process.argv.slice(2)
const rootArg = args.indexOf('--root')
const ROOT = rootArg >= 0 ? args[rootArg + 1] : join(dirname(fileURLToPath(import.meta.url)), '..')
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
const REF = /(?:(?<![\w$.])(?:\$t|tx?)|\bi18n(?:\.global)?\.t)\(\s*(['"`])([\w.-]+)\1\s*[,)]/g
const SEED_REF = /(['"`])((?:seed|menu)\.[\w.-]+)\1/g
// seed `labelI18n`/`nameI18n` (or *_i18n) object literals: dict labels, param names (mode B; see docs/design-notes.md#i18n)
const I18N_LITERAL = /\b(?:label|name)(?:I18n|_i18n)['"]?\s*:\s*\{([^{}]*)\}/g
const TEMPLATE_TABLE = /(['"])(msg_(?:inbox|mail|sms)_template)\1/g
const TEMPLATE_HELPER = 'apps/server/src/db/seeds/messaging/templates.ts'
const hasText = (body, lang) => new RegExp(`['"]${lang}['"]\\s*:\\s*(['"\`])(?!\\1)`).test(body)
const IS_TEST = /(^|\/)(__tests__|e2e|test)\/|\.(e2e-spec|spec|test)\.ts$/
// db/migrations: column COMMENTs are the codegen zh-CN labels
const NO_CJK_EXEMPT =
  /(^|\/)(locales|i18n)\/|(^|\/)db\/(seeds|migrations)\/|^scripts\/originality\//
// the uni-app client, skipped when absent; PC-only: remove with mobile/ (docs/mobile.md)
const MOBILE = 'mobile/src/'
const errors = []
const err = (file, line, msg) => errors.push(`${file}${line ? `:${line}` : ''}: ${msg}`)
const rel = (p) => relative(ROOT, p).split('\\').join('/')
const lineAt = (s, i) => s.slice(0, i).split('\n').length
const blank = (s) => s.replace(/[^\n]/g, ' ')

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!['node_modules', 'dist', 'coverage'].includes(e.name) && !e.name.startsWith('.'))
        walk(join(dir, e.name), out)
    } else out.push(join(dir, e.name))
  }
  return out.sort()
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    err(rel(file), 0, `invalid JSON (${e.message})`)
    return {}
  }
}

function flat(o, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(o ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, `${prefix}${k}.`, out)
    else out[prefix + k] = v
  }
  return out
}

// Removes // and /* */ comments outside '', "", `` strings; keeps line numbers.
function stripJs(src) {
  let out = ''
  let q = null
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (q) {
      out += c
      if (c === '\\') out += src[++i] ?? ''
      else if (c === q) q = null
    } else if (c === '"' || c === "'" || c === '`') {
      q = c
      out += c
    } else if (c === '/' && src[i + 1] === '/')
      while (i + 1 < src.length && src[i + 1] !== '\n') i++
    else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      out += blank(src.slice(i, stop))
      i = stop - 1
    } else out += c
  }
  return out
}

function strip(src, file) {
  if (!file.endsWith('.vue')) return stripJs(src)
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/g, (_, a, body, c) => a + stripJs(body) + c)
}

// Complete literal keys in shared source (templates with ${…} are skipped: not statically known).
const sharedKeyLiterals = (code) =>
  [...code.matchAll(/['"`]((?:validation|field)\.[\w.]+)['"`]/g)].map((m) => ({
    key: m[1],
    index: m.index,
  }))
const refs = (code) => [...code.matchAll(REF)].map((m) => ({ key: m[2], index: m.index }))

// Rule 1 per location: each language's files deep-merged the way the loaders do (`mergeLocaleFile` in
// @qiwu/shared): `<ns>.json` is namespace <ns>, a module fragment `<domain>.<biz>.json` (a dot in the name,
// any sub-folder, e.g. shared `modules/`) holds whole top-level namespaces. Every file has its
// counterpart in the other language with the same keys; a key two files define is an error (the loaders
// would silently keep one).
function loadLocales(relDir, root = ROOT) {
  const dir = join(root, relDir)
  if (!existsSync(dir)) return null
  const tree = {}
  const keys = {}
  const files = {}
  for (const lang of LANGS) {
    tree[lang] = {}
    keys[lang] = new Set()
    files[lang] = {}
    const ldir = join(dir, lang)
    const origin = {}
    for (const path of walk(ldir).filter((p) => p.endsWith('.json'))) {
      const file = relative(ldir, path).split('\\').join('/')
      const name = file.split('/').pop().slice(0, -5)
      const json = readJson(path)
      files[lang][file] = flat(name.includes('.') ? json : { [name]: json })
      for (const [key, value] of Object.entries(files[lang][file])) {
        if (origin[key])
          err(`${relDir}/${lang}/${file}`, 0, `key '${key}' also defined in ${origin[key]}`)
        origin[key] ??= file
        keys[lang].add(key)
        const [ns, ...rest] = key.split('.')
        ;(tree[lang][ns] ??= {})[rest.join('.')] = value
      }
    }
  }
  for (const file of new Set(LANGS.flatMap((l) => Object.keys(files[l]))))
    for (const [lang, other] of [LANGS, [...LANGS].reverse()]) {
      const path = `${relDir}/${lang}/${file}`
      if (!files[lang][file]) err(path, 0, `locale file missing (exists in ${other})`)
      else
        for (const k of Object.keys(files[other][file] ?? {}))
          if (!(k in files[lang][file])) err(path, 0, `missing key '${k}' (present in ${other})`)
    }
  const nss = new Set(LANGS.flatMap((l) => Object.keys(tree[l])))
  return { dir, relDir, tree, keys, nss }
}

function checkRef(file, line, key, loc) {
  const ns = key.split('.')[0]
  if (!loc.nss.has(ns)) return err(file, line, `unknown namespace '${ns}' in key '${key}'`)
  for (const lang of LANGS)
    if (!loc.keys[lang].has(key)) err(file, line, `missing key '${key}' in ${lang}`)
}

// Split a helper call at top-level commas, preserving offsets for the table-literal check.
function callArgs(code, open) {
  const args = []
  const stack = [code[open]]
  let quote = null
  let start = open + 1
  for (let i = start; i < code.length; i++) {
    const c = code[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
    } else if (c === "'" || c === '"' || c === '`') quote = c
    else if ('([{'.includes(c)) stack.push(c)
    else if (')]}'.includes(c)) {
      const pair = { ')': '(', ']': '[', '}': '{' }[c]
      if (stack.pop() !== pair) return null
      if (!stack.length) {
        args.push({ text: code.slice(start, i), start, end: i })
        return args
      }
    } else if (c === ',' && stack.length === 1) {
      args.push({ text: code.slice(start, i), start, end: i })
      start = i + 1
    }
  }
  return null
}

function templateErrors(code, file) {
  if (file === TEMPLATE_HELPER) return []
  const problems = []
  const allowed = []
  for (const match of code.matchAll(/\bupsertTemplates\s*\(/g)) {
    const args = callArgs(code, match.index + match[0].length - 1)
    const line = lineAt(code, match.index)
    if (!args || args.length < 5) {
      problems.push([line, 'invalid upsertTemplates call'])
      continue
    }
    const table = args[1].text.trim().match(/^(['"])(msg_(?:inbox|mail|sms)_template)\1$/)?.[2]
    if (!table) {
      problems.push([line, 'upsertTemplates needs a template table literal'])
      continue
    }
    allowed.push(args[1])
    const rows = args[3].text
    const fields =
      table === 'msg_sms_template'
        ? ['body']
        : [table === 'msg_mail_template' ? 'subject' : 'title', 'body']
    for (const lang of LANGS) {
      const entry = rows.match(new RegExp(`['"]${lang}['"]\\s*:\\s*\\{`))
      const locale = entry && callArgs(rows, entry.index + entry[0].length - 1)
      if (
        !locale ||
        fields.some(
          (field) =>
            !locale
              .find((arg) => new RegExp(`^\\s*${field}\\s*:`).test(arg.text))
              ?.text.match(new RegExp(`^\\s*${field}\\s*:\\s*(['"\x60])([\\s\\S]*?)\\1`))?.[2]
              ?.trim(),
        )
      )
        problems.push([line, `template ${table} needs non-empty ${fields.join('/')} in '${lang}'`])
    }
    if (!/\bname\s*:\s*(['"])seed\.[\w.-]+\1/.test(args[4].text))
      problems.push([line, 'template name must be a seed.* key literal'])
  }
  for (const match of code.matchAll(TEMPLATE_TABLE))
    if (!allowed.some((arg) => match.index >= arg.start && match.index < arg.end))
      problems.push([lineAt(code, match.index), `seed templates through ${TEMPLATE_HELPER}`])
  return problems
}

function main() {
  const web = loadLocales('apps/web/src/locales')
  const server = loadLocales('apps/server/src/i18n')
  const shared = loadLocales('packages/shared/src/i18n')
  const mobile = loadLocales(`${MOBILE}locales`)
  const sources = [
    ...walk(join(ROOT, 'apps')),
    ...walk(join(ROOT, 'packages')),
    ...walk(join(ROOT, MOBILE)),
  ].filter((f) => /\.(ts|vue)$/.test(f))
  // Server and web keys may also come from shared: copied into server i18n at build time (see docs/design-notes.md#i18n),
  // merged into the web messages at runtime (validation.* / field.* / seed.*); a key both define is an error.
  const withShared = (loc) => {
    if (!loc) return loc
    for (const l of LANGS)
      for (const k of loc.keys[l])
        if (shared?.keys[l].has(k))
          err(`${loc.relDir}/${l}`, 0, `key '${k}' also defined in packages/shared/src/i18n/${l}`)
    return {
      nss: new Set([...loc.nss, ...(shared?.nss ?? [])]),
      keys: Object.fromEntries(
        LANGS.map((l) => [l, new Set([...loc.keys[l], ...(shared?.keys[l] ?? [])])]),
      ),
    }
  }
  const webLoc = withShared(web)
  const serverLoc = withShared(server)
  const mobileLoc = withShared(mobile)
  let refCount = 0

  for (const f of sources) {
    const file = rel(f)
    const code = strip(readFileSync(f, 'utf8'), file)
    // Rule 2: literal keys referenced in web / server source exist.
    const loc = file.startsWith('apps/web/src/')
      ? webLoc
      : file.startsWith('apps/server/src/')
        ? serverLoc
        : file.startsWith('packages/shared/src/')
          ? shared
          : file.startsWith(MOBILE)
            ? mobileLoc
            : null
    // shared code returns message keys as plain literals ('validation.required'), not via t()
    const found = file.startsWith('packages/shared/src/') ? sharedKeyLiterals(code) : refs(code)
    if (loc && !IS_TEST.test(file) && !NO_CJK_EXEMPT.test(file))
      for (const r of found) {
        refCount++
        checkRef(file, lineAt(code, r.index), r.key, loc)
      }
    // Rule 3: no CJK characters outside comments.
    if (IS_TEST.test(file) || NO_CJK_EXEMPT.test(file)) continue
    code
      .split('\n')
      .forEach((l, i) => CJK.test(l) && err(file, i + 1, `CJK literal: ${l.trim().slice(0, 60)}`))
  }

  // Rule 4: en-US empty values + __todo.json entries (fail only when I18N_TODO_STRICT=1).
  // The design intentionally hides the English login motto with an empty value.
  const INTENTIONAL_EMPTY = new Set([`${MOBILE}locales:login.motto`])
  const todo = new Set()
  for (const loc of [web, server, shared, mobile].filter(Boolean)) {
    for (const [ns, m] of Object.entries(loc.tree['en-US']))
      for (const [k, v] of Object.entries(m))
        if (
          typeof v === 'string' &&
          !v.trim() &&
          !INTENTIONAL_EMPTY.has(`${loc.relDir}:${ns}.${k}`)
        )
          todo.add(`${loc.relDir}:${ns}.${k}`)
    const todoFile = join(loc.dir, '__todo.json')
    if (existsSync(todoFile)) {
      const t = readJson(todoFile)
      for (const k of Array.isArray(t) ? t : Object.keys(flat(t))) todo.add(`${loc.relDir}:${k}`)
    }
  }
  console.log(
    `rule 4: ${todo.size} en-US TODO entr${todo.size === 1 ? 'y' : 'ies'} (empty values + __todo.json)`,
  )
  if (todo.size && process.env.I18N_TODO_STRICT === '1')
    for (const t of todo)
      err(t.split(':')[0], 0, `en-US TODO '${t.split(':')[1]}' (I18N_TODO_STRICT=1)`)

  // Rule 5: every 'seed.*' / 'menu.*' literal in seeds exists in both languages of the web messages
  // (menu.json or a module fragment in web locales, seed.json in shared: the server searches seeded names
  // by their text too). Dict labels / param names and each template code have both languages;
  // template names are seed.* keys and template writes use upsertTemplates.
  // db/seeds plus the module menu seeds (`modules/**/<biz>.seed.ts`; see docs/design-notes.md#layering)
  const seedFiles = [
    ...walk(join(ROOT, 'apps/server/src/db/seeds')).filter((p) => /\.(ts|json)$/.test(p)),
    ...walk(join(ROOT, 'apps/server/src/modules')).filter((p) => p.endsWith('.seed.ts')),
  ]
  if (!seedFiles.length) console.log('rule 5: no seeds yet (skipped)')
  else
    for (const f of seedFiles) {
      const code = f.endsWith('.ts') ? stripJs(readFileSync(f, 'utf8')) : readFileSync(f, 'utf8')
      for (const m of code.matchAll(SEED_REF))
        checkRef(rel(f), lineAt(code, m.index), m[2], webLoc ?? { nss: new Set(), keys: {} })
      for (const m of code.matchAll(I18N_LITERAL))
        for (const lang of LANGS.filter((l) => !hasText(m[1], l)))
          err(rel(f), lineAt(code, m.index), `i18n literal without a '${lang}' text: ${m[0]}`)
      for (const [line, message] of templateErrors(code, rel(f))) err(rel(f), line, message)
    }

  if (errors.length) {
    for (const e of errors) console.error(e)
    console.error(`i18n:check failed: ${errors.length} error(s)`)
    process.exit(1)
  }
  console.log(`i18n:check ok (${sources.length} source files, ${refCount} key refs)`)
}

function selfTest() {
  const s = stripJs("a('x // y') // 中\n/* 中\n */ b `/*`")
  assert.ok(
    !CJK.test(s) && s.includes("'x // y'") && s.includes('`/*`') && s.split('\n').length === 3,
  )
  assert.ok(!CJK.test(strip('<template><!-- 中 --></template><script>// 中\n</script>', 'a.vue')))
  const src =
    "t('app.a') $t(\"b.c\") i18n.global.t('d.e', {}) this.i18n.t('f.g') x.t('no.x') t('app.' + v) tx('seed.r') t(`h.${i}`)"
  assert.deepEqual(
    refs(src).map((r) => r.key),
    ['app.a', 'b.c', 'd.e', 'f.g', 'seed.r'],
  )
  assert.ok(
    IS_TEST.test('apps/server/test/e2e/a.e2e-spec.ts') &&
      NO_CJK_EXEMPT.test('apps/server/src/db/seeds/x.ts') &&
      NO_CJK_EXEMPT.test('apps/server/src/db/migrations/x.ts') &&
      !NO_CJK_EXEMPT.test('apps/server/src/modules/x.ts'),
  )
  const lit = (src) =>
    [...src.matchAll(I18N_LITERAL)].map((m) => LANGS.filter((l) => hasText(m[1], l)).length)
  assert.deepEqual(
    lit(
      "labelI18n: { 'zh-CN': '男', 'en-US': 'Male' } nameI18n: { 'zh-CN': '', 'en-US': 'x' } \"name_i18n\": {\"en-US\": \"y\"} nameI18n: Texts",
    ),
    [2, 1, 1],
  )
  const templateFile = 'apps/server/src/db/seeds/messaging/delivery.seed.ts'
  const goodTemplate =
    "upsertTemplates(q, 'msg_sms_template', 'code', { 'zh-CN': { body: '验证码' }, 'en-US': { body: 'Code' } }, { name: 'seed.smsTemplate.authCode' })"
  assert.deepEqual(templateErrors(stripJs(goodTemplate), templateFile), [])
  assert.match(
    templateErrors(
      stripJs(goodTemplate.replace("'en-US': { body: 'Code' }", '')),
      templateFile,
    )[0][1],
    /en-US/,
  )
  assert.match(
    templateErrors(stripJs(goodTemplate.replace("body: 'Code'", "body: ''")), templateFile)[0][1],
    /en-US/,
  )
  assert.match(
    templateErrors(stripJs("upsert(q, 'msg_sms_template', { code: 'x' })"), templateFile)[0][1],
    /seed templates through/,
  )
  assert.match(
    templateErrors(
      stripJs(goodTemplate.replace("name: 'seed.smsTemplate.authCode'", "name: 'Custom'")),
      templateFile,
    )[0][1],
    /seed\.\*/,
  )
  // rule 1 over module fragments: deep-merged per language, file pairs with the same keys, no key twice
  const tmp = mkdtempSync(join(tmpdir(), 'i18n-check-'))
  const put = (file, json) => {
    mkdirSync(dirname(join(tmp, file)), { recursive: true })
    writeFileSync(join(tmp, file), JSON.stringify(json))
  }
  put('l/zh-CN/menu.json', { home: 'a', iam: { title: 'b' } })
  put('l/zh-CN/modules/iam.position.json', {
    iam: { position: { entity: 'c' } },
    menu: { iam: { position: 'd' } },
  })
  put('l/zh-CN/z.dup.json', { menu: { home: 'e' } })
  put('l/en-US/menu.json', { home: 'A', iam: { title: 'B' } })
  put('l/en-US/modules/iam.position.json', {
    iam: { position: {} },
    menu: { iam: { position: 'D' } },
  })
  const loc = loadLocales('l', tmp)
  assert.deepEqual([...loc.keys['zh-CN']].sort(), [
    'iam.position.entity',
    'menu.home',
    'menu.iam.position',
    'menu.iam.title',
  ])
  assert.deepEqual(loc.tree['en-US'].menu, { home: 'A', 'iam.title': 'B', 'iam.position': 'D' })
  assert.deepEqual(errors.splice(0), [
    "l/zh-CN/z.dup.json: key 'menu.home' also defined in menu.json",
    "l/en-US/modules/iam.position.json: missing key 'iam.position.entity' (present in zh-CN)",
    'l/en-US/z.dup.json: locale file missing (exists in zh-CN)',
  ])
  // Rule 4: only the intentional mobile motto is exempt; other blanks and explicit TODOs still fail.
  try {
    const check = () =>
      spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--root', tmp], {
        env: { ...process.env, I18N_TODO_STRICT: '1' },
        encoding: 'utf8',
        timeout: 10_000,
      })
    put(`${MOBILE}locales/zh-CN/login.json`, { motto: 'verse', slogan: 'text' })
    put(`${MOBILE}locales/en-US/login.json`, { motto: '', slogan: 'Text' })
    const allowed = check()
    assert.equal(allowed.status, 0, allowed.stderr)
    assert.match(allowed.stdout, /rule 4: 0 en-US TODO entries/)
    put(`${MOBILE}locales/en-US/login.json`, { motto: '', slogan: '' })
    for (const lang of LANGS) put(`apps/web/src/locales/${lang}/login.json`, { motto: '' })
    put(`${MOBILE}locales/__todo.json`, ['login.motto'])
    const rejected = check()
    assert.equal(rejected.status, 1, rejected.stderr)
    assert.ok(rejected.stderr.includes(`${MOBILE}locales: en-US TODO 'login.slogan'`))
    assert.match(rejected.stderr, /apps\/web\/src\/locales: en-US TODO 'login.motto'/)
    assert.ok(rejected.stderr.includes(`${MOBILE}locales: en-US TODO 'login.motto'`))
  } finally {
    rmSync(tmp, { recursive: true })
  }
  console.log('i18n-check self-test ok')
}

if (args.includes('--self-test')) selfTest()
else main()
