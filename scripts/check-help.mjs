// Fix hints for the repository checks (arch, i18n, originality, license): every failure says how to
// repair it and which public doc explains the rule. A help is `{ fix, doc }`, or a list of rules
// `{ match, fix, doc }` tried in order on the violation text, the last one without `match` (it covers the
// rest). `doc` is `docs/<file>.md#<anchor>` of this repository: a heading anchor (GitHub slug rules) or an
// explicit `<a id="…">`. A new arch check only exports `help`; scripts/arch/run.mjs prints and validates it.
// Self-test: node scripts/check-help.mjs --self-test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { anchorsOf, slug } from './md-anchors.mjs'

export { anchorsOf, slug }

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 文档链接 `docs/<file>.md#<anchor>` 的问题：格式不对、文件不存在或锚点不存在。 */
export function docProblems(doc, root = ROOT) {
  const m = /^(docs\/[\w./-]+\.md)#(.+)$/u.exec(doc ?? '')
  if (!m) return [`doc '${doc}' is not docs/<file>.md#<anchor>`]
  const file = join(root, m[1])
  if (!existsSync(file)) return [`doc ${m[1]} does not exist`]
  if (!anchorsOf(readFileSync(file, 'utf8')).has(m[2]))
    return [`doc ${m[1]} has no anchor #${m[2]}`]
  return []
}

const rulesOf = (help) => (Array.isArray(help) ? help : help ? [help] : [])

/** 一项检查的修复提示本身的问题：缺失、缺修复文字、末条带 match（总有违规找不到提示）或文档链接失效。 */
export function helpProblems(help, root = ROOT) {
  const rules = rulesOf(help)
  if (!rules.length) return ['no help: export help = { fix, doc } (see scripts/check-help.mjs)']
  const out = []
  if (rules.at(-1).match) out.push('help: the last rule must have no match (it covers the rest)')
  if (rules.slice(0, -1).some((r) => !r.match))
    out.push(
      'help: only the last rule may lack a match (an earlier one would take every violation)',
    )
  for (const { fix, doc } of rules) {
    if (!fix?.trim()) out.push('help: a rule without a fix text')
    out.push(...docProblems(doc, root).map((p) => `help: ${p}`))
  }
  return out
}

/** 一条违规对应的提示规则：第一条 match 命中的，或末尾不带 match 的那条。 */
export const helpFor = (help, violation) =>
  rulesOf(help).find((r) => !r.match || r.match.test(violation))

/** 一项检查全部违规的 `fix:` / `see:` 行，每条命中的规则只出一次。 */
export function helpLines(help, violations) {
  const used = new Set(violations.map((v) => helpFor(help, v)).filter(Boolean))
  return [...used].flatMap(({ fix, doc }) => [`  fix: ${fix}`, `  see: ${doc}`])
}

/** 自测：锚点规则、提示校验，以及 run.mjs 对缺提示的检查报错、对失败的检查打印 fix / see。 */
function selfTest() {
  assert.equal(slug('Windows（原生 PowerShell 5.1）'), 'windows原生-powershell-51')
  assert.equal(slug('bpmn.io 水印义务'), 'bpmnio-水印义务')
  assert.equal(slug('7. 项目自己的表、迁移与模板升级'), '7-项目自己的表迁移与模板升级')
  assert.equal(slug('基础层（`src/core`）'), '基础层srccore')
  assert.equal(slug('TODO 与验收'), 'todo-与验收')
  assert.equal(slug('snake_case and kebab-case'), 'snake_case-and-kebab-case')
  const md = '# A\n## A\n<a id="x"></a>\n```sh\n# not a heading\n```\n## 手写 SQL\n'
  assert.deepEqual([...anchorsOf(md)].sort(), ['a', 'a-1', 'x', '手写-sql'])

  const tmp = mkdtempSync(join(tmpdir(), 'qw-check-help-'))
  try {
    const put = (file, text) => {
      mkdirSync(dirname(join(tmp, file)), { recursive: true })
      writeFileSync(join(tmp, file), text)
    }
    put('docs/a.md', '# Guide\n## 第一节\n<a id="other"></a>\n')
    assert.deepEqual(helpProblems({ fix: 'f', doc: 'docs/a.md#第一节' }, tmp), [])
    assert.deepEqual(helpProblems({ fix: 'f', doc: 'docs/a.md#other' }, tmp), [])
    assert.match(helpProblems(undefined, tmp)[0], /no help/)
    assert.match(helpProblems({ doc: 'docs/a.md#guide' }, tmp)[0], /without a fix/)
    assert.match(helpProblems({ fix: 'f', doc: 'docs/b.md#guide' }, tmp)[0], /does not exist/)
    assert.match(helpProblems({ fix: 'f', doc: 'docs/a.md#gone' }, tmp)[0], /no anchor #gone/)
    assert.match(helpProblems({ fix: 'f', doc: 'README.md#guide' }, tmp)[0], /is not docs/)
    assert.match(
      helpProblems([{ match: /x/, fix: 'f', doc: 'docs/a.md#guide' }], tmp)[0],
      /last rule/,
    )

    // run.mjs 与本文件拷进临时仓库，配上假检查：缺提示、链接失效的检查失败，失败的检查按规则打印提示
    put('scripts/check-help.mjs', readFileSync(fileURLToPath(import.meta.url), 'utf8'))
    put('scripts/md-anchors.mjs', readFileSync(join(ROOT, 'scripts/md-anchors.mjs'), 'utf8'))
    put('scripts/arch/run.mjs', readFileSync(join(ROOT, 'scripts/arch/run.mjs'), 'utf8'))
    const check = (violations) => `export default () => ${JSON.stringify(violations)}\n`
    put('scripts/arch/no-help.mjs', check([]))
    put(
      'scripts/arch/bad-doc.mjs',
      `${check([])}export const help = { fix: 'f', doc: 'docs/a.md#gone' }\n`,
    )
    put(
      'scripts/arch/fails.mjs',
      `${check(['a.ts:1 plain', 'b.ts:2 plain', 'c.ts:3 special'])}export const help = [
  { match: /special/, fix: 'Fix the special one.', doc: 'docs/a.md#other' },
  { fix: 'Fix the plain ones.', doc: 'docs/a.md#第一节' },
]\n`,
    )
    put(
      'scripts/arch/passes.mjs',
      `${check([])}export const help = { fix: 'f', doc: 'docs/a.md#guide' }\n`,
    )
    const run = (only) =>
      spawnSync(
        process.execPath,
        [join(tmp, 'scripts/arch/run.mjs'), '--root', tmp, '--only', only],
        {
          encoding: 'utf8',
        },
      )
    const missing = run('no-help,bad-doc')
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, / {2}x no-help: no help: export help/)
    assert.match(missing.stderr, / {2}x bad-doc: help: doc docs\/a\.md has no anchor #gone/)
    const failing = run('fails')
    assert.equal(failing.status, 1)
    assert.equal(
      failing.stderr,
      [
        '  x a.ts:1 plain',
        '  x b.ts:2 plain',
        '  x c.ts:3 special',
        '  fix: Fix the plain ones.',
        '  see: docs/a.md#第一节',
        '  fix: Fix the special one.',
        '  see: docs/a.md#other',
        '',
      ].join('\n'),
    )
    assert.match(failing.stdout, /arch: 3 violation\(s\)/)
    const passing = run('passes')
    assert.equal(passing.status, 0, passing.stderr)
    assert.equal(passing.stderr, '')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  console.log('check-help self-test: anchors, help validation and run.mjs fix/see output ok')
}

/** 自测：仓库里每项 arch 检查的提示都有效，真实检查失败时打印它自己的 fix / see。 */
async function selfTestRepo() {
  const dir = join(ROOT, 'scripts/arch')
  const names = readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'run.mjs')
  for (const name of names) {
    const { help } = await import(pathToFileURL(join(dir, name)).href)
    assert.deepEqual(helpProblems(help), [], name)
  }
  const tmp = mkdtempSync(join(tmpdir(), 'qw-check-help-repo-'))
  try {
    mkdirSync(join(tmp, 'apps/server/src'), { recursive: true })
    writeFileSync(join(tmp, 'apps/server/src/a.ts'), "redis.get('dict:x')\nredis.del('dict:y')\n")
    const r = spawnSync(
      process.execPath,
      [join(dir, 'run.mjs'), '--root', tmp, '--only', 'redis-keys'],
      { encoding: 'utf8' },
    )
    assert.equal(r.status, 1, r.stdout + r.stderr)
    const { help } = await import(pathToFileURL(join(dir, 'redis-keys.mjs')).href)
    assert.equal(r.stderr.split(`  fix: ${help.fix}\n  see: ${help.doc}\n`).length, 2, r.stderr)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  console.log(`check-help repo self-test: ${names.length} arch checks carry a valid help`)
}

// run directly (also through a symlinked or substituted path)
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) &&
  process.argv.includes('--self-test')
) {
  selfTest()
  await selfTestRepo()
}
