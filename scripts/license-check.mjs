// License audit. Usage: node scripts/license-check.mjs [--dir <project>] [--notices <path>] [--self-test]
// Default: audits `pnpm licenses list --json --prod` of each workspace package, plus the separate pnpm root
// mobile/ when it is installed. Exceptions: license-exceptions.json, plus the audited project's
// own license-exceptions.json (they apply to that project only).
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import assert from 'node:assert/strict'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKSPACE = ['@qiwu/server', '@qiwu/web', '@qiwu/shared']
// the uni-app client, skipped when absent; PC-only: remove with mobile/ (docs/mobile.md)
const MOBILE = join(ROOT, 'mobile/')
// prettier-ignore
const WHITELIST = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'MIT-0', 'BlueOak-1.0.0', 'CC0-1.0', 'Python-2.0', 'Unicode-3.0',
  'Unicode-DFS-2016', 'Zlib', 'Unlicense'])
// prettier-ignore
const BANNED = new Set(['xlsx', 'tinymce', 'ckeditor5', 'aieditor', '@bpmn-io/form-js', 'vform3-builds', 'pm2', 'expr-eval', 'wangeditor', 'svg-captcha'])
const banned = (name, v) => BANNED.has(name) || (name === 'ua-parser-js' && parseInt(v, 10) >= 2)

const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
const glob = (p) => new RegExp(`^${p.split('*').map(esc).join('.*')}$`)
const inRange = (v, range) =>
  range.split('.').every((p, i) => p === 'x' || p === '*' || p === v.split(/[.+-]/)[i])
const norm = (s) => s.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()

// SPDX expression -> tree: string leaf | { op: 'AND'|'OR', n: [...] }. AND binds tighter than OR.
function parse(expr) {
  const t = expr
    .replace(/[()]/g, ' $& ')
    .trim()
    .split(/\s+/)
    .map((x) => (/^(and|or|with)$/i.test(x) ? x.toUpperCase() : x))
  let i = 0
  const list = (op, next) => {
    const n = [next()]
    while (t[i] === op) {
      i++
      n.push(next())
    }
    return n.length > 1 ? { op, n } : n[0]
  }
  const atom = () => {
    if (t[i] === '(') {
      i++
      const e = list('OR', () => list('AND', atom))
      if (t[i++] !== ')') throw new Error('missing )')
      return e
    }
    const id = t[i++]
    if (!id || /^(AND|OR|WITH|\))$/.test(id)) throw new Error('bad token')
    if (t[i] !== 'WITH') return id
    i += 2
    return `${id} WITH ${t[i - 1]}`
  }
  const tree = list('OR', () => list('AND', atom))
  if (i !== t.length) throw new Error('trailing tokens')
  return tree
}

function walk(node, elected, out) {
  if (typeof node === 'string') {
    if (!WHITELIST.has(node))
      out.push(
        /GPL/i.test(node)
          ? `${node} is copyleft (GPL/AGPL/LGPL)`
          : `${node} is not in the whitelist`,
      )
  } else if (node.op === 'AND') node.n.forEach((c) => walk(c, elected, out))
  else if (elected && node.n.includes(elected)) walk(elected, null, out)
  else {
    const ok = node.n.filter((c) => typeof c === 'string' && WHITELIST.has(c))
    out.push(
      `OR expression needs an election in license-exceptions.json (allowed branch: ${ok.join(', ') || 'none'})`,
    )
  }
}

function registrations({ name, version, license }, ex) {
  const alias = ex.aliases.find(
    (a) => a.package === name && a.version === version && a.from === license,
  )
  const lic = alias ? alias.to : license
  const exception = [...ex.binaryExceptions, ...ex.exceptions].find(
    (b) => glob(b.packagePattern).test(name) && b.license === lic,
  )
  const election = ex.elections.find(
    (e) =>
      e.package === name &&
      inRange(version, e.versionRange) &&
      norm(e.expression) === norm(lic ?? ''),
  )
  return { alias, lic, exception, election }
}

// Returns ['fail'|'note'|'ok', message].
function check(pkg, ex) {
  const { name, version } = pkg
  if (banned(name, version)) return ['fail', 'hard-banned']
  if (
    name.startsWith('@iconify-json/') &&
    !ex.iconSets.includes(name.slice('@iconify-json/'.length))
  )
    return ['fail', 'icon set not registered in license-exceptions.json iconSets']
  const { alias, lic, exception, election } = registrations(pkg, ex)
  if (exception) return ['note', `registered exception (${lic})`]
  if (!lic || lic === 'Unknown') return ['fail', 'unknown license']
  if (/^SEE LICEN[CS]E IN/i.test(lic)) return ['fail', 'custom license (SEE LICENSE IN)']
  if (lic === 'UNLICENSED') return ['fail', 'UNLICENSED (proprietary)']
  let tree
  try {
    tree = parse(lic)
  } catch {
    return ['fail', 'not a valid SPDX expression (register a package@version alias if legit)']
  }
  const why = []
  walk(tree, election?.elected, why)
  if (why.length) return ['fail', why.join('; ')]
  if (election) return ['note', `elected ${election.elected}`]
  return alias ? ['note', `alias ${alias.from} -> ${alias.to}`] : ['ok', '']
}

function collect(pkgs, packages, ex, where) {
  for (const p of packages) {
    const key = `${p.name}@${p.version}`
    if (!pkgs.has(key)) pkgs.set(key, { ...p, ex, where: [] })
    if (!pkgs.get(key).where.includes(where)) pkgs.get(key).where.push(where)
  }
}

const BEGIN = '<!-- BEGIN GENERATED LICENSE NOTICES -->'
const END = '<!-- END GENERATED LICENSE NOTICES -->'
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const sorted = (pkgs) =>
  [...pkgs].sort(([, a], [, b]) => compare(a.name, b.name) || compare(a.version, b.version))
const cell = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\|/g, '&#124;')
    .replace(/[\r\n]+/g, ' ')

function writeNotices(path, pkgs, coverage) {
  const rows = sorted(pkgs).map(([key, p]) => {
    const [kind, msg] = check(p, p.ex)
    if (kind === 'fail') throw new Error(`${key}: ${msg}; notices not written`)
    const { alias, lic, exception, election } = registrations(p, p.ex)
    const notes = [
      alias && `alias ${alias.from} -> ${alias.to}: ${alias.reason ?? ''}`,
      exception && `exception ${exception.packagePattern}: ${exception.reason ?? ''}`,
      !exception && election && `elected ${election.elected}: ${election.reason ?? ''}`,
    ]
      .filter(Boolean)
      .join('; ')
    return `| ${[p.name, p.version, p.license, exception ? lic : (election?.elected ?? lic), [...p.where].sort().join(', '), notes].map(cell).join(' | ')} |`
  })
  const block = [
    BEGIN,
    '',
    '## 生产依赖机器清单',
    '',
    '由 `node scripts/license-check.mjs --notices THIRD-PARTY-NOTICES.md` 生成；普通 `pnpm license:check` 只读。仅此标记区会被替换，区外人工许可全文保留。',
    `覆盖：${coverage}。仅已安装的生产依赖；不代替人工许可全文与原创性审计。`,
    '',
    '| Package | Version | Reported license | Selected license | Where | Registration / reason |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    END,
  ].join('\n')
  const original = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const begins = original.split(BEGIN).length - 1
  const ends = original.split(END).length - 1
  if (
    (begins || ends) &&
    (begins !== 1 || ends !== 1 || original.indexOf(BEGIN) > original.indexOf(END))
  )
    throw new Error('invalid generated notices markers; notices not written')
  const next = begins
    ? original.slice(0, original.indexOf(BEGIN)) +
      block +
      original.slice(original.indexOf(END) + END.length)
    : original +
      (original.endsWith('\n\n') || !original ? '' : original.endsWith('\n') ? '\n' : '\n\n') +
      block +
      '\n'
  // Same-filesystem rename: readers never see a partial file; failures leave the old file intact.
  const temp = mkdtempSync(join(dirname(path), '.license-notices-'))
  try {
    const file = join(temp, 'notices')
    writeFileSync(file, next)
    renameSync(file, path)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

function pnpmLicenses(args, cwd) {
  let out
  try {
    out = execSync(`pnpm ${[...args, 'licenses', 'list', '--json', '--prod'].join(' ')}`, {
      cwd,
      encoding: 'utf8',
      timeout: 180_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    throw new Error(
      `pnpm licenses list failed in ${cwd} ${args.join(' ')}: ${(e.stdout || e.stderr || e.message).trim()}`,
    )
  }
  return Object.entries(JSON.parse(out)).flatMap(([key, entries]) =>
    entries.flatMap((e) =>
      e.versions.map((version) => ({ name: e.name, version, license: e.license || key })),
    ),
  )
}

function selfTest() {
  const ex = {
    aliases: [
      { package: 'chainsaw', version: '0.1.0', from: 'MIT/X11', to: 'MIT' },
      {
        package: 'bpmn-js',
        version: '18.30.1',
        from: 'Unknown',
        to: 'LicenseRef-bpmn-io',
        reason: 'pinned license file',
      },
    ],
    // prettier-ignore
    elections: [{ package: 'jszip', versionRange: '3.10.x', expression: 'MIT OR GPL-3.0-or-later', elected: 'MIT' }],
    binaryExceptions: [
      { packagePattern: '@img/sharp-libvips-*', license: 'LGPL-3.0-or-later' },
      ...['x64', 'arm64', 'ia32'].map((arch) => ({
        packagePattern: `@img/sharp-win32-${arch}`,
        license: 'Apache-2.0 AND LGPL-3.0-or-later',
      })),
    ],
    exceptions: [
      { packagePattern: 'caniuse-lite', license: 'CC-BY-4.0' },
      { packagePattern: 'bpmn-js', license: 'LicenseRef-bpmn-io' },
    ],
    iconSets: ['ep'],
  }
  const cases = `
    ok   a@1.0.0 MIT
    ok   pako@1.0.11 (MIT AND Zlib)
    ok   big-integer@1.6.52 Unlicense
    ok   jszip@3.10.2 (MIT OR GPL-3.0-or-later)
    fail jszip@2.0.0 (MIT OR GPL-3.0-or-later)
    ok   @img/sharp-libvips-linux-x64@1.3.3 LGPL-3.0-or-later
    fail @img/sharp-libvips-linux-x64@1.3.3 Apache-2.0 AND LGPL-3.0-or-later
    ok   @img/sharp-win32-x64@0.34.5 Apache-2.0 AND LGPL-3.0-or-later
    ok   @img/sharp-win32-arm64@0.34.5 Apache-2.0 AND LGPL-3.0-or-later
    ok   @img/sharp-win32-ia32@0.34.5 Apache-2.0 AND LGPL-3.0-or-later
    fail unrelated-binary@1.0.0 Apache-2.0 AND LGPL-3.0-or-later
    fail libfoo@1.0.0 LGPL-3.0-or-later
    ok   caniuse-lite@1.0.30001813 CC-BY-4.0
    fail caniuse-db@1.0.30001813 CC-BY-4.0
    ok   chainsaw@0.1.0 MIT/X11
    fail chainsaw@0.2.0 MIT/X11
    fail b@1.0.0 GPL-3.0
    fail c@1.0.0 Unknown
    fail d@1.0.0 SEE LICENSE IN LICENSE.md
    fail e@1.0.0 UNLICENSED
    fail f@1.0.0 MIT AND
    fail g@1.0.0 (MIT OR Apache-2.0) AND GPL-2.0
    fail h@1.0.0 MPL-2.0
    ok   ua-parser-js@1.0.40 MIT
    fail ua-parser-js@2.0.0 MIT
    fail wangeditor@4.7.15 MIT
    ok   bpmn-js@18.30.1 Unknown
    fail bpmn-js@18.31.0 Unknown
    fail @bpmn-io/form-js@1.0.0 MIT
    ok   @iconify-json/ep@1.2.4 Apache-2.0
    fail @iconify-json/mdi@1.2.3 Apache-2.0`
  const lines = cases.trim().split('\n')
  for (const line of lines) {
    const [want, id, ...license] = line.trim().split(/\s+/)
    const at = id.lastIndexOf('@')
    const pkg = { name: id.slice(0, at), version: id.slice(at + 1), license: license.join(' ') }
    assert.equal(check(pkg, ex)[0] === 'fail' ? 'fail' : 'ok', want, line.trim())
  }
  const realEx = JSON.parse(readFileSync(join(ROOT, 'license-exceptions.json'), 'utf8'))
  const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')
  const notices = readFileSync(join(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8')
  const windowsPackages = []
  for (const arch of ['x64', 'arm64', 'ia32']) {
    const name = `@img/sharp-win32-${arch}`
    // Lockfile package and snapshot keys repeat; check each distinct locked version once.
    const versions = new Set(
      [...lock.matchAll(new RegExp(`^ {2}'${esc(name)}@([^']+)':$`, 'gm'))].map(
        (match) => match[1],
      ),
    )
    assert.ok(versions.size, `${name}: missing from pnpm-lock.yaml`)
    for (const version of versions) {
      const [kind, msg] = check(
        { name, version, license: 'Apache-2.0 AND LGPL-3.0-or-later' },
        realEx,
      )
      assert.ok(['ok', 'note'].includes(kind), `${name}@${version}: ${msg}`)
      windowsPackages.push(`${name}@${version}`)
    }
  }
  for (const { packagePattern } of realEx.binaryExceptions)
    assert.ok(
      notices.includes(packagePattern),
      `${packagePattern}: missing from THIRD-PARTY-NOTICES.md`,
    )
  const temp = mkdtempSync(join(tmpdir(), 'license-check-'))
  try {
    const path = join(temp, 'NOTICES.md')
    const pkgs = new Map()
    const packages = [
      { name: 'z', version: '1.0.0', license: 'MIT' },
      { name: 'a', version: '2.0.0', license: 'ISC' },
      { name: 'a', version: '1.0.0', license: 'MIT' },
      { name: 'a-b', version: '1.0.0', license: 'MIT' },
      { name: 'bpmn-js', version: '18.30.1', license: 'Unknown' },
      { name: 'chainsaw', version: '0.1.0', license: 'MIT/X11' },
      { name: 'jszip', version: '3.10.2', license: 'MIT OR GPL-3.0-or-later' },
      { name: '@img/sharp-libvips-linux-x64', version: '1.3.3', license: 'LGPL-3.0-or-later' },
    ]
    collect(pkgs, packages, ex, '@qiwu/web')
    collect(pkgs, packages, ex, 'mobile')
    collect(pkgs, packages, ex, 'mobile')
    assert.equal(pkgs.size, packages.length)
    assert.deepEqual(pkgs.get('a@1.0.0').where, ['@qiwu/web', 'mobile'])
    const manual = '# Manual license text\r\n\r\nCopyright & terms.\r\n'
    writeFileSync(path, manual)
    writeNotices(path, pkgs, '@qiwu/web, mobile')
    const first = readFileSync(path, 'utf8')
    assert.ok(first.startsWith(manual))
    assert.equal(first.split('| a | 1.0.0 |').length - 1, 1)
    assert.ok(first.indexOf('| a | 1.0.0 |') < first.indexOf('| a | 2.0.0 |'))
    assert.ok(first.indexOf('| a | 2.0.0 |') < first.indexOf('| z |'))
    assert.ok(first.indexOf('| a | 2.0.0 |') < first.indexOf('| a-b |'))
    assert.ok(first.includes('| @qiwu/web, mobile |'))
    assert.ok(first.includes('| Unknown | LicenseRef-bpmn-io |'))
    assert.ok(first.includes('alias Unknown -> LicenseRef-bpmn-io: pinned license file'))
    assert.ok(first.includes('| MIT/X11 | MIT |'))
    assert.ok(first.includes('| MIT OR GPL-3.0-or-later | MIT |'))
    assert.ok(first.includes('exception @img/sharp-libvips-*'))
    writeNotices(path, pkgs, '@qiwu/web, mobile')
    assert.equal(readFileSync(path, 'utf8'), first)
    const prefix = 'Manual prefix\r\n'
    const suffix = '\r\nManual suffix\r\n'
    writeFileSync(path, prefix + BEGIN + '\nold generated text\n' + END + suffix)
    writeNotices(path, pkgs, '@qiwu/web, mobile')
    assert.equal(
      readFileSync(path, 'utf8'),
      prefix + first.slice(first.indexOf(BEGIN), first.indexOf(END) + END.length) + suffix,
    )
    for (const bad of [BEGIN, END, END + BEGIN, BEGIN + BEGIN + END, BEGIN + END + END]) {
      writeFileSync(path, bad)
      assert.throws(() => writeNotices(path, pkgs, 'fixture'), /invalid.*markers/)
      assert.equal(readFileSync(path, 'utf8'), bad)
    }
    const invalid = new Map()
    collect(invalid, [{ name: 'bad', version: '1.0.0', license: 'Unknown' }], ex, 'fixture')
    writeFileSync(path, manual)
    assert.throws(() => writeNotices(path, invalid, 'fixture'), /unknown license/)
    assert.equal(readFileSync(path, 'utf8'), manual)
    const absent = join(temp, 'absent.md')
    assert.throws(() => writeNotices(absent, invalid, 'fixture'), /unknown license/)
    assert.equal(existsSync(absent), false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
  console.log(`license-check self-test: ${lines.length} cases ok`)
  console.log(
    `license-check real-config self-test: ${windowsPackages.join(', ')} ok; ${realEx.binaryExceptions.length} binary exceptions mentioned in notices`,
  )
  console.log(
    'license-check notices self-test: collection, licenses, preservation, markers, refusal and repeatability ok',
  )
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' },
      notices: { type: 'string' },
      'self-test': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(
      'Usage: node scripts/license-check.mjs [--dir <project>] [--notices <path>] [--self-test]',
    )
    console.log(
      '--notices: explicitly replace only the generated section after a successful production-dependency audit; default audit is read-only.',
    )
    return
  }
  if (values['self-test']) return selfTest()
  if (values.dir === '' || values.notices === '')
    throw new Error('--dir and --notices require non-empty paths')
  const read = (dir) => JSON.parse(readFileSync(join(dir, 'license-exceptions.json'), 'utf8'))
  const root = read(ROOT)
  const exFor = (dir) => {
    const own = resolve(dir) !== resolve(ROOT) && existsSync(join(dir, 'license-exceptions.json'))
    const add = own ? read(dir) : {}
    const keys = ['aliases', 'elections', 'binaryExceptions', 'exceptions', 'iconSets']
    return Object.fromEntries(keys.map((k) => [k, [...(root[k] ?? []), ...(add[k] ?? [])]]))
  }
  let targets = [[resolve(values.dir ?? '.'), []]]
  let skipped = ''
  if (values.dir === undefined) {
    targets = WORKSPACE.map((w) => [ROOT, ['--filter', w]])
    if (existsSync(join(MOBILE, 'node_modules'))) targets.push([MOBILE, []])
    else if (existsSync(MOBILE)) {
      skipped = 'mobile 未安装，未覆盖；发布前必须先 pnpm mobile:install 再重新生成'
      console.log(
        `note ${MOBILE} is not installed: coverage incomplete (pnpm mobile:install, then regenerate notices)`,
      )
    }
  }
  // a package the workspace and mobile/ share is judged by the workspace's exceptions (first target)
  const pkgs = new Map()
  for (const [cwd, args] of targets) {
    const ex = exFor(cwd)
    collect(pkgs, pnpmLicenses(args, cwd), ex, args[1] ?? (relative(ROOT, cwd) || '.'))
  }
  let fails = 0
  for (const [key, p] of sorted(pkgs)) {
    const [kind, msg] = check(p, p.ex)
    if (kind === 'fail') fails++
    if (kind !== 'ok')
      console.log(
        `${kind === 'fail' ? 'FAIL' : 'note'} ${key}  ${p.license}  ${msg}${p.where.length ? `  [${p.where.join(', ')}]` : ''}`,
      )
  }
  console.log(`license-check: ${pkgs.size} packages, ${fails} violation(s)`)
  if (fails) {
    process.exitCode = 1
    return
  }
  if (values.notices !== undefined) {
    const path = resolve(values.notices)
    const coverage = targets
      .map(([cwd, args]) => args[1] ?? (relative(ROOT, cwd) || '.'))
      .sort()
      .join(', ')
    writeNotices(path, pkgs, coverage + (skipped ? `；${skipped}` : ''))
    console.log(
      `license-check: notices written to ${path}${skipped ? ' (coverage incomplete)' : ''}`,
    )
  }
}

try {
  main(process.argv.slice(2))
} catch (e) {
  console.error(`license-check: ${e.message}`)
  process.exitCode = 1
}
