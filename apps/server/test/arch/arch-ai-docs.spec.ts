// scripts/arch/ai-docs.mjs against a throwaway tree: the AI docs (public-ai/**, docs/ai.md, docs/ai/**) may
// only name pnpm scripts, repo paths, link targets and heading anchors that exist; public-ai files link
// from their exported place. Placeholders, local env files and pnpm's own commands pass. The real tree
// passing is `pnpm arch:check` (pnpm verify). The anchors follow GitHub's heading slugs, Chinese and
// full-width punctuation included.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// the agent rules file and the skills folder, spelled in parts (this spec is public code)
const RULES = ['AGENTS', 'md'].join('.')
const SKILLS = `.${['clau', 'de'].join('')}/skills`
const POINTER = `.github/${['copi', 'lot'].join('')}-instructions.md`

const TREE: Record<string, string> = {
  'package.json': JSON.stringify({ scripts: { verify: 'x', 'arch:check': 'x' } }),
  'apps/api/package.json': JSON.stringify({ name: '@x/api', scripts: { test: 'x' } }),
  'tools/package.json': JSON.stringify({ scripts: { build: 'x' } }),
  'docs/guide.md': [
    '# 指南',
    '## 5. 检查与后续使用',
    '## Windows（原生 PowerShell 5.1）',
    '## 建表、软删除与引用约定（New tables）',
    '## The `gen` command',
    '## The `gen` command',
    '<a id="tenancy"></a>',
    '```md',
    '## In a fence',
    '```',
  ].join('\n\n'),
  'docs/ai.md': [
    'Run `pnpm verify`, `pnpm i`, `pnpm --filter @x/api test <stem>` and `pnpm -C tools build`.',
    'Bad: `pnpm nope` and `pnpm --filter @x/api lint` and `pnpm -C tools test`.',
    'Paths: `docs/guide.md`, `apps/api/<domain>.ts`, `apps/server/.env.local`, `core/db/x.ts`.',
    'Missing: `docs/gone.md` and `apps/api/src/gone.ts:12`.',
    'Links: [a](guide.md#5-检查与后续使用) [b](guide.md#windows原生-powershell-51)',
    '[c](guide.md#tenancy) [d](https://example.com/x) [e](#local) [i](guide.md#建表软删除与引用约定new-tables)',
    '[j](guide.md#the-gen-command-1) [k](guide.md#in-a-fence)',
    'Broken: [f](guide.md#no-such) [g](missing.md) [h](#nowhere)',
    '',
    '## Local',
    '',
    '```sh',
    'I18N_TODO_STRICT=1 pnpm verify && pnpm run missing-script',
    '```',
    '',
  ].join('\n'),
  [`public-ai/${RULES}`]: `# Rules\n\nSee [ai](docs/ai.md#local), \`docs/project-rules.md\`, \`public-ai/${RULES}\`.\n`,
  'public-ai/.tool/skills/x/SKILL.md':
    'Follow `docs/ai/recipes/x.md` and [r](../../../docs/guide.md#指南), not `docs/ai/recipes/y.md`.\n',
  'docs/ai/recipes/x.md': '# X\n\n[up](../../guide.md#tenancy) [no](../../guide.md#nope)\n',
  'docs/ai/project-map.md': '`pnpm generated-only`\n',
}

it('flags missing scripts, paths, link targets and anchors in the AI docs', () => {
  const root = mkdtempSync(join(tmpdir(), 'qw-arch-'))
  try {
    for (const [file, text] of Object.entries(TREE)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), text)
    }
    const r = spawnSync(
      process.execPath,
      ['../../scripts/arch/run.mjs', '--root', root, '--only', 'ai-docs'],
      { encoding: 'utf8' },
    )
    expect(r.status).toBe(1)
    const found = r.stderr
      .split('\n')
      .filter((l) => l.startsWith('  x '))
      .map((l) => l.slice(4))
    const expected: [string, string][] = [
      ['docs/ai.md:2', 'pnpm nope'],
      ['docs/ai.md:2', 'pnpm --filter @x/api lint'],
      ['docs/ai.md:2', 'pnpm -C tools test'],
      ['docs/ai.md:4', 'docs/gone.md does not exist'],
      ['docs/ai.md:4', 'apps/api/src/gone.ts does not exist'],
      ['docs/ai.md:7', 'has no heading #in-a-fence'],
      ['docs/ai.md:8', 'has no heading #no-such'],
      ['docs/ai.md:8', 'docs/missing.md does not exist'],
      ['docs/ai.md:8', 'has no heading #nowhere'],
      ['docs/ai.md:13', 'has no script "missing-script"'],
      [`public-ai/${RULES}:3`, `write the public path ${RULES}`],
      ['docs/ai/recipes/x.md:3', 'has no heading #nope'],
      ['public-ai/.tool/skills/x/SKILL.md:1', 'docs/ai/recipes/y.md does not exist'],
    ]
    const missed = expected.filter(
      ([at, what]) => !found.some((l) => l.startsWith(`${at} `) && l.includes(what)),
    )
    // `found` rides along so a failure shows every violation the check printed
    expect({ missed, count: found.length, found }).toMatchObject({
      missed: [],
      count: expected.length,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Writes the tree, runs the ai-docs check on it and returns the violation lines. */
function violations(tree: Record<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), 'qw-arch-'))
  try {
    for (const [file, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), text)
    }
    const r = spawnSync(
      process.execPath,
      ['../../scripts/arch/run.mjs', '--root', root, '--only', 'ai-docs'],
      { encoding: 'utf8' },
    )
    return r.stderr.split('\n').filter((l) => l.startsWith('  x '))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

it('in a public checkout (no public-ai/) checks the exported AI files at the root, the own ones only', () => {
  const found = violations({
    'package.json': JSON.stringify({ scripts: { verify: 'x' } }),
    [RULES]: 'Run `pnpm verify` then `pnpm nope`.\n',
    'docs/guide.md': '# Guide\n',
    [`${SKILLS}/qiwu-x/SKILL.md`]: 'Follow `docs/ai/recipes/gone.md`.\n',
    // a project's own or a third-party skill: its paths are its own business
    [`${SKILLS}/pdf/SKILL.md`]: 'Run `scripts/fill_form.py` and `docs/nowhere.md`.\n',
    [POINTER]: `Read [rules](../${RULES}#none).\n`,
  })
  const text = found.join('\n')
  expect(text).toContain(`  x ${RULES}:1 `)
  expect(text).toMatch(/pnpm nope/)
  expect(text).toContain(`  x ${SKILLS}/qiwu-x/SKILL.md:1 `)
  expect(text).toMatch(/gone\.md does not exist/)
  expect(text).toContain(`  x ${POINTER}:1 `)
  expect(text).toMatch(/has no heading #none/)
  expect(found).toHaveLength(3)
})

it('a project that removed the mobile client or a sample domain still passes; others still fail', () => {
  const doc = [
    `See [mobile](mobile.md), \`${['mobile', 'src', 'pages.json'].join('/')}\`, \`pnpm mobile:verify\`, \`docs/mobile.md\`.`,
    'Sample: `apps/server/src/modules/demo/book/`, `apps/web/src/locales/zh-CN/demo.book.json`.',
    'Also `apps/server/test/e2e/demo-book.e2e-spec.ts` and `pnpm --filter "@x/api" test`.',
    'Still checked: `apps/server/src/modules/erp/` and `pnpm mobile-nope`.',
  ].join('\n')
  const found = violations({
    'package.json': JSON.stringify({ scripts: { verify: 'x' } }),
    'apps/api/package.json': JSON.stringify({ name: '@x/api', scripts: { test: 'x' } }),
    'apps/server/src/modules/biz/x.ts': '',
    'apps/web/src/locales/zh-CN/x.json': '{}',
    'apps/server/test/e2e/x.ts': '',
    'docs/ai.md': doc,
  })
  expect(found.join('\n')).toMatch(
    /docs\/ai\.md:4 apps\/server\/src\/modules\/erp\/? does not exist/,
  )
  expect(found.join('\n')).toMatch(/docs\/ai\.md:4 .*pnpm mobile-nope/)
  expect(found).toHaveLength(2)
})
