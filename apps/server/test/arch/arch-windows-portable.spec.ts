// The portable source guard against throwaway trees, including a non-git copy.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve('../..')

function temporary(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qw windows guard '))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function fixture(dir: string, tree: Record<string, string>) {
  for (const [file, text] of Object.entries({
    '.gitattributes': '* text=auto eol=lf\n*.png binary\n',
    'notes.txt': 'Notes\n',
    'README.md': '## Windows\n```powershell\npnpm.cmd verify\n```\n',
    'docs/getting-started.md': '## Windows\n```powershell\npnpm.cmd verify\n```\n',
    ...tree,
  })) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  execFileSync('git', ['init', '-q', dir], { timeout: 5000 })
  execFileSync('git', ['add', '.'], { cwd: dir, timeout: 5000 })
}

const guard = (dir: string) =>
  spawnSync(
    process.execPath,
    [join(ROOT, 'scripts/arch/run.mjs'), '--root', dir, '--only', 'windows-portable'],
    { encoding: 'utf8', timeout: 10_000 },
  )

it('portable guard accepts Node bins, comments, self-tests, POSIX tutorials and non-git copies', () => {
  temporary((dir) => {
    fixture(dir, {
      'scripts/tool.mjs': `
// spawnSync('pnpm', [])
/* execFileSync('npm', []) */
function selfTest() { spawnSync('pnpm', []) }
spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')])
spawnSync('diff', ['/dev/null']); execFileSync('rm', []); spawnSync('cp', []); execFile('touch', [])
execSync('pnpm why -r --json vue')
`,
      'scripts/arch/windows-portable.mjs': "spawnSync('pnpm', [])\n",
      'scripts/ci-local.mjs': `const before = [['test', "pnpm --filter '!@qiwu/server' test"]]\n`,
      'apps/server/test/fixture.spec.ts': "spawnSync('cp', [])\n",
      'docs/windows.md':
        '```powershell\n$env:TITLE=\'Example\'; pnpm.cmd verify\n```\n```bat\nset "TITLE=Example"\npnpm.cmd verify\n```\n```bash\nTITLE=x pnpm verify && cat x | head\n```\n',
    })
    const r = guard(dir)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('arch: 1 checks ok')
    rmSync(join(dir, '.git'), { recursive: true, force: true })
    const copy = guard(dir)
    expect(copy.status).toBe(0)
    expect(copy.stdout).toContain('arch: 1 checks ok')
  })
})

it('portable guard rejects literal pnpm/npm/npx launches and bin shims', () => {
  temporary((dir) => {
    const commands = ['pnpm', 'npm', 'npx']
    fixture(dir, {
      'scripts/tool.mjs': [
        ...commands.map((cmd) => `spawnSync(\n '${cmd}', [])`),
        "execFileSync('pnpm.cmd', [])",
        "spawn('npm', [])",
        "execFile('npx', [])",
        "const tsc = join(root, 'node_modules/.bin/tsc')",
        "const lint = '.bin/oxlint'",
      ].join('\n'),
      'apps/server/src/modules/platform/codegen/workspace.ts': "spawnSync('pnpm', [])\n",
    })
    const r = guard(dir)
    expect(r.status).toBe(1)
    for (const cmd of commands) expect(r.stderr).toContain(`spawnSync(${cmd})`)
    expect(r.stderr).toContain('execFileSync(pnpm.cmd)')
    expect(r.stderr).toContain('spawn(npm)')
    expect(r.stderr).toContain('execFile(npx)')
    expect(r.stderr.match(/must run through its Node bin/g)).toHaveLength(2)
    expect(r.stderr).toContain('codegen/workspace.ts:1')
  })
})

it('portable guard rejects checkout and Windows example regressions', () => {
  temporary((dir) => {
    fixture(dir, {
      '.gitattributes': '* text=auto\n',
      'docs/windows.md':
        '```powershell\nTITLE=x pnpm verify\npnpm verify && pnpm build\ncat x | head\npnpm verify 2>/dev/null\npnpm \\\nverify\n```\n',
    })
    // An index-only link tests core.symlinks=false too, without requiring Windows symlink privileges.
    const blob = execFileSync('git', ['hash-object', 'README.md'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim()
    execFileSync('git', ['update-index', '--cacheinfo', `120000,${blob},notes.txt`], { cwd: dir })
    const r = guard(dir)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('.gitattributes:1 must enforce')
    expect(r.stderr).toContain('PNG assets must stay binary')
    expect(r.stderr).toContain('notes.txt: tracked symlink')
    expect(r.stderr.match(/Windows example contains POSIX shell syntax/g)).toHaveLength(5)
  })
})

it('portable guard requires Windows getting-started examples', () => {
  temporary((dir) => {
    fixture(dir, {
      'README.md': '# Getting started\n```powershell\npnpm.cmd verify\n```\n',
      'docs/getting-started.md': '## Windows\n```sh\npnpm verify\n```\n',
    })
    const r = guard(dir)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('README.md: must include a Windows section')
    expect(r.stderr).toContain('docs/getting-started.md: must include a Windows section')
    for (const file of ['README.md', 'docs/getting-started.md'])
      writeFileSync(join(dir, file), '## Windows\n```powershell\npnpm.cmd verify\n```\n')
    const fixed = guard(dir)
    expect(fixed.status).toBe(0)
    expect(fixed.stdout).toContain('arch: 1 checks ok')
    expect(fixed.stderr).toBe('')
  })
})

it('portable guard rejects a physical symlink in place of a tracked file and passes regular files', () => {
  temporary((dir) => {
    fixture(dir, {})
    const ok = guard(dir)
    expect(ok.status).toBe(0)
    expect(ok.stderr).toBe('')
    rmSync(join(dir, 'notes.txt'))
    try {
      symlinkSync('README.md', join(dir, 'notes.txt'))
    } catch (error) {
      // Windows without symlink privileges still exercises the index-only link case above.
      if (
        process.platform === 'win32' &&
        ['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')
      )
        return
      throw error
    }
    const result = guard(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('notes.txt: must be a regular file, not a symlink')
    expect(result.stderr).not.toContain('README.md')
    rmSync(join(dir, 'notes.txt'))
    writeFileSync(join(dir, 'notes.txt'), 'Notes\n')
    expect(guard(dir).status).toBe(0)
  })
})
