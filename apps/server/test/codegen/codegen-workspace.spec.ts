// Writing generated files (see docs/design-notes.md#codegen): only with NODE_ENV=development && CODEGEN_WRITE=true, only below
// apps/*/src, packages/shared/src, apps/server/test and the mobile client's src, never through a symlink, never over an existing
// file (a changed one comes back as a diff and nothing is written); `render --out` copies outside the
// repository only.
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  canWrite,
  checkPath,
  diffOf,
  MOBILE,
  repoRoot,
  WorkspaceError,
  writeCopy,
  writeWorkspace,
  zipOf,
} from '../../src/modules/platform/codegen/workspace.js'

const DEV = { NODE_ENV: 'development', CODEGEN_WRITE: 'true' }
/** the mobile client's directory (`mobile`), built from MOBILE like every mobile path (scripts/arch/mobile-refs) */
const MOBILE_ROOT = MOBILE.split('/')[0]!
const file = (path: string, content = `// ${path}\n`) => ({ path, content })

let tmp: string
let root: string
let outside: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'qw-cg-ws-')))
  root = join(tmp, 'repo')
  outside = join(tmp, 'outside')
  for (const d of ['apps/web/src', 'apps/server/src', 'apps/server/test', 'packages/shared/src'])
    mkdirSync(join(root, d), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), '')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  syncBuiltinESMExports()
  rmSync(tmp, { recursive: true, force: true })
})
const put = (path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}
const read = (path: string) => readFileSync(join(root, path), 'utf8')

it('writes only when NODE_ENV=development and CODEGEN_WRITE=true', () => {
  expect(canWrite(DEV)).toBe(true)
  for (const env of [
    {},
    { NODE_ENV: 'development' },
    { NODE_ENV: 'production', CODEGEN_WRITE: 'true' },
    { NODE_ENV: 'test', CODEGEN_WRITE: 'true' },
    { NODE_ENV: 'development', CODEGEN_WRITE: '1' },
  ])
    expect(canWrite(env)).toBe(false)
  expect(() => writeWorkspace(root, [file('apps/web/src/a.ts')], {})).toThrow(/writing is off/)
  expect(existsSync(join(root, 'apps/web/src/a.ts'))).toBe(false)
})

it('accepts plain paths below the source roots only', () => {
  for (const ok of [
    'apps/web/src/views/demo/book/index.vue',
    'apps/server/src/modules/demo/book/book.entity.ts',
    'apps/server/test/e2e/demo-book.e2e-spec.ts',
    'packages/shared/src/i18n/zh-CN/modules/demo.book.json',
    `${MOBILE}pages-biz/demo/book/index.vue`,
    `${MOBILE}api/demo/book.ts`,
  ])
    expect(checkPath(ok, true)).toBe(ok)
  for (const bad of [
    '../outside/x.ts',
    '/etc/passwd',
    'apps/web/src/../../../x.ts',
    'apps/web/src/./x.ts',
    'apps/web/src//x.ts',
    'apps/web/src/a\\..\\..\\x.ts',
    'apps/web/src/x.ts\n',
    'apps/web/src/',
    'README.md',
    'package.json',
    'apps/server/dist/main.js',
    'apps/web/node_modules/x/index.js',
    'packages/shared/package.json',
    'apps/Web/src/x.ts',
    '',
    // the mobile client: its src only (not its package, e2e or scripts), plain paths only
    `${MOBILE_ROOT}/package.json`,
    `${MOBILE_ROOT}/e2e/x.spec.ts`,
    `${MOBILE_ROOT}/scripts/mp-size.mjs`,
    `${MOBILE}../x.ts`,
    `x/${MOBILE}a.ts`,
  ])
    expect(() => checkPath(bad, true)).toThrow(/refused path|not a writable/)
  expect(() => writeWorkspace(root, [file('../outside/x.ts')], DEV)).toThrow(/refused path/)
  expect(existsSync(join(outside, 'x.ts'))).toBe(false)
})

it('never writes through a linked directory', () => {
  symlinkSync(outside, join(root, 'apps/web/src/linked'), 'junction')
  expect(() => writeWorkspace(root, [file('apps/web/src/linked/x.ts')], DEV)).toThrow(/symlink/)
  expect(existsSync(join(outside, 'x.ts'))).toBe(false)
})

it('never writes through a linked file', (ctx) => {
  writeFileSync(join(outside, 'target.ts'), '// target\n')
  try {
    symlinkSync(join(outside, 'target.ts'), join(root, 'apps/web/src/file.ts'))
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM')
      ctx.skip('file symlinks require permission on Windows')
    throw error
  }
  expect(() => writeWorkspace(root, [file('apps/web/src/file.ts')], DEV)).toThrow(/symlink/)
  expect(readFileSync(join(outside, 'target.ts'), 'utf8')).toBe('// target\n')
})

it('never writes through a dangling symlink', (ctx) => {
  // a dangling link is refused too (it would create the file it points to)
  try {
    symlinkSync(join(outside, 'gone'), join(root, 'apps/server/test/gone'))
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM')
      ctx.skip('file symlinks require permission on Windows')
    throw error
  }
  expect(() => writeWorkspace(root, [file('apps/server/test/gone/x.ts')], DEV)).toThrow(/symlink/)
  expect(existsSync(join(outside, 'gone'))).toBe(false)
})

it('writes new files, leaves identical ones, and writes nothing while one differs (diff instead)', () => {
  put('apps/server/src/m/same.ts', '// same\n')
  put('apps/server/src/m/changed.ts', 'const a = 1\nconst b = 2\n')
  const files = [
    file('apps/server/src/m/same.ts', '// same\n'),
    file('apps/server/src/m/changed.ts', 'const a = 1\nconst b = 3\n'),
    file('apps/web/src/new/x.vue', '<template />\n'),
  ]
  const r = writeWorkspace(root, files, DEV)
  expect(r.written).toEqual([])
  expect(r.unchanged).toEqual(['apps/server/src/m/same.ts'])
  expect(r.conflicts.map((c) => c.path)).toEqual(['apps/server/src/m/changed.ts'])
  expect(r.conflicts[0]!.diff).toContain('--- a/apps/server/src/m/changed.ts')
  expect(r.conflicts[0]!.diff).toContain('+++ b/apps/server/src/m/changed.ts')
  expect(r.conflicts[0]!.diff).toMatch(/^-const b = 2$/m)
  expect(r.conflicts[0]!.diff).toMatch(/^\+const b = 3$/m)
  expect(read('apps/server/src/m/changed.ts')).toBe('const a = 1\nconst b = 2\n')
  expect(existsSync(join(root, 'apps/web/src/new/x.vue'))).toBe(false)

  const ok = writeWorkspace(root, [files[0]!, files[2]!], DEV)
  expect(ok).toEqual({
    written: ['apps/web/src/new/x.vue'],
    unchanged: ['apps/server/src/m/same.ts'],
    conflicts: [],
  })
  expect(read('apps/web/src/new/x.vue')).toBe('<template />\n')
})

it('treats on-disk CRLF against rendered LF as a conflict and writes nothing', () => {
  const path = 'apps/server/src/m/eol.ts'
  const fresh = 'apps/web/src/new/x.vue'
  const crlf = 'const value = 1\r\n'
  put(path, crlf)

  const result = writeWorkspace(root, [file(fresh), file(path, 'const value = 1\n')], DEV)
  expect(result.written).toEqual([])
  expect(result.unchanged).toEqual([])
  expect(result.conflicts).toEqual([{ path, diff: expect.stringContaining(path) }])
  expect(readFileSync(join(root, path))).toEqual(Buffer.from(crlf))
  expect(existsSync(join(root, fresh))).toBe(false)
  expect(existsSync(join(root, dirname(fresh)))).toBe(false)
})

it('all or nothing: a file in the way of a later target refuses the batch before any write', () => {
  put('apps/web/src/blocked', 'a file, not a directory\n')
  const files = [file('apps/server/src/modules/new/a.ts'), file('apps/web/src/blocked/b.vue')]
  expect(() => writeWorkspace(root, files, DEV)).toThrow(/apps\/web\/src\/blocked is in the way/)
  expect(existsSync(join(root, 'apps/server/src/modules'))).toBe(false)
  // a directory where a file goes
  mkdirSync(join(root, 'apps/web/src/dir.vue'))
  expect(() => writeWorkspace(root, [files[0]!, file('apps/web/src/dir.vue')], DEV)).toThrow(
    /is in the way/,
  )
  expect(existsSync(join(root, 'apps/server/src/modules'))).toBe(false)
})

describe.skipIf(process.platform === 'win32')('POSIX file permissions', () => {
  it('all or nothing: a write failing midway removes the files and directories the batch created', () => {
    put('apps/server/src/m/kept.ts', '// kept\n')
    mkdirSync(join(root, 'apps/web/src/locked'))
    chmodSync(join(root, 'apps/web/src/locked'), 0o555)
    try {
      const files = [
        file('apps/server/src/m/new.ts'),
        file('apps/server/src/deep/er/x.ts'),
        file('apps/web/src/locked/y.vue'),
      ]
      expect(() => writeWorkspace(root, files, DEV)).toThrow(/writing failed, nothing was kept/)
    } finally {
      chmodSync(join(root, 'apps/web/src/locked'), 0o755)
    }
    expect(existsSync(join(root, 'apps/server/src/m/new.ts'))).toBe(false)
    expect(existsSync(join(root, 'apps/server/src/deep'))).toBe(false)
    expect(read('apps/server/src/m/kept.ts')).toBe('// kept\n')
  })
})

it('refuses a batch where two tables map to one path: nothing is written or copied', () => {
  const mod = 'apps/server/src/modules/demo/book'
  // demo_book and a second table configured with the same group, domain and business
  const book = [file(`${mod}/book.entity.ts`, '// demo_book\n'), file('apps/web/src/api/a.ts')]
  const other = [file(`${mod}/book.entity.ts`, '// other_book\n')]
  expect(() => writeWorkspace(root, [...book, ...other], DEV)).toThrow(
    `two files of this batch go to ${mod}/book.entity.ts`,
  )
  expect(existsSync(join(root, mod)) || existsSync(join(root, 'apps/web/src/api/a.ts'))).toBe(false)
  expect(() => writeCopy(root, join(outside, 'gen'), [...book, ...other])).toThrow(/two files/)
  expect(existsSync(join(outside, 'gen/apps'))).toBe(false)
})

it('render --out copies below a directory outside the repository only', () => {
  const files = [file('apps/web/src/a/x.ts'), file('packages/shared/src/y.ts')]
  expect(writeCopy(root, join(outside, 'gen'), files)).toEqual([
    join(outside, 'gen/apps/web/src/a/x.ts'),
    join(outside, 'gen/packages/shared/src/y.ts'),
  ])
  // again: an output directory is replaced file by file
  writeCopy(root, join(outside, 'gen'), [file('apps/web/src/a/x.ts', 'v2\n')])
  expect(readFileSync(join(outside, 'gen/apps/web/src/a/x.ts'), 'utf8')).toBe('v2\n')
  for (const dir of [root, join(root, 'apps/web/src'), join(root, 'tmp-gen')])
    expect(() => writeCopy(root, dir, files)).toThrow(/outside the repository/)
  // a link from outside back into the repository
  symlinkSync(join(root, 'apps'), join(outside, 'back'), 'junction')
  expect(() => writeCopy(root, join(outside, 'back'), files)).toThrow(/outside the repository/)
  expect(() => writeCopy(root, join(outside, 'gen2'), [file('../../x.ts')])).toThrow(/refused/)
  expect(existsSync(join(root, 'tmp-gen'))).toBe(false)
})

it('finds the repository root from apps/server', () => {
  expect(repoRoot(join(root, 'apps/server'))).toBe(root)
  expect(() => repoRoot(join(outside, 'a/b'))).toThrow(/not the repository root/)
})

it('zips whitelisted paths only, each once, the same bytes each time', async () => {
  const read = async (stream: NodeJS.ReadableStream) => {
    const chunks: Buffer[] = []
    for await (const c of stream) chunks.push(c as Buffer)
    return Buffer.concat(chunks)
  }
  const files = [
    file('apps/web/src/a.vue'),
    file('packages/shared/src/b.ts'),
    file(`${MOBILE}pages-biz/demo/book/index.vue`),
  ]
  const zip = await read(zipOf(files))
  expect(zip.subarray(0, 2).toString()).toBe('PK')
  for (const f of files) expect(zip.includes(Buffer.from(f.path))).toBe(true)
  expect(await read(zipOf(files))).toEqual(zip)
  for (const bad of [
    'apps/web/../x.ts',
    '/etc/passwd',
    'scripts/x.mjs',
    'apps/web/src/a b.ts',
    `${MOBILE_ROOT}/package.json`,
  ])
    expect(() => zipOf([file(bad)])).toThrow(WorkspaceError)
  expect(() => zipOf([...files, files[0]!])).toThrow(/two files of this batch/)
})

it('Git diffs use clean relative headers for Chinese and space paths, ignore external tools, and return nothing for equal bytes', () => {
  const path = 'apps/web/src/中文 space.ts'
  const before = 'const value = "原值"\n'
  const after = 'const value = "新值"\n'
  put(path, before)
  vi.stubEnv('GIT_CONFIG_COUNT', '2')
  vi.stubEnv('GIT_CONFIG_KEY_0', 'diff.external')
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'missing-external-diff')
  vi.stubEnv('GIT_CONFIG_KEY_1', 'color.ui')
  vi.stubEnv('GIT_CONFIG_VALUE_1', 'always')
  const diff = diffOf(join(root, path), path, after)
  expect(diff).toMatch(
    /^--- a\/apps\/web\/src\/中文 space.ts\n\+\+\+ b\/apps\/web\/src\/中文 space.ts\n@@/,
  )
  expect(diff).toContain(`-${before}`)
  expect(diff).toContain(`+${after}`)
  expect(diff).not.toContain(tmp)
  expect(diff).not.toContain('qw-codegen-diff-')
  expect(diff).not.toContain('diff --git')
  expect(diff).not.toContain('\u001b[')
  expect(diff).not.toMatch(/^index /m)
  const spawn = vi.spyOn(childProcess, 'spawnSync')
  syncBuiltinESMExports()
  expect(diffOf(join(root, path), path, before)).toBe('')
  expect(spawn).not.toHaveBeenCalled()
})

it('reports byte differences even when Git normalizes CRLF to LF', () => {
  const path = 'apps/web/src/eol.ts'
  put(path, 'const value = 1\r\n')
  vi.stubEnv('GIT_CONFIG_COUNT', '1')
  vi.stubEnv('GIT_CONFIG_KEY_0', 'core.autocrlf')
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'true')
  const diff = diffOf(join(root, path), path, 'const value = 1\n')
  expect(diff).not.toBe('')
  expect(diff).toContain(path)
  expect(diff).toContain('line endings/attributes')
})

it.each([
  {
    status: 0,
    stdout: '',
    stderr: '',
    expected: 'apps/web/src/a.ts: differs (line endings/attributes only or no text hunk)\n',
  },
  {
    status: 1,
    stdout: 'Binary files differ\n',
    stderr: '',
    expected: 'apps/web/src/a.ts: differs (line endings/attributes only or no text hunk)\n',
  },
  {
    status: 1,
    stdout:
      'diff --git a/secret b/secret\nindex 123..456\n--- secret\n+++ secret\n@@ -1 +1 @@\n-old\n+new\n',
    stderr: '',
    expected: '--- a/apps/web/src/a.ts\n+++ b/apps/web/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
  },
  {
    status: null,
    error: Object.assign(new Error('no Git'), { code: 'ENOENT' }),
    stdout: '',
    stderr: '',
    expected: 'apps/web/src/a.ts: differs (no Git to show how)\n',
  },
])('distinguishes Git status $status / $error from a diff hunk', ({ expected, ...result }) => {
  const path = 'apps/web/src/a.ts'
  put(path, 'old\n')
  vi.spyOn(childProcess, 'spawnSync').mockReturnValue(
    result as ReturnType<typeof childProcess.spawnSync>,
  )
  syncBuiltinESMExports()
  expect(diffOf(join(root, path), path, 'new\n')).toBe(expected)
})

it.each([
  { status: 2, stdout: '', stderr: 'bad Git' },
  {
    status: null,
    stdout: '',
    stderr: '',
    error: Object.assign(new Error('denied'), { code: 'EACCES' }),
  },
  { status: null, stdout: '', stderr: '', signal: 'SIGTERM' },
])(
  'throws on Git errors instead of reporting an empty diff: $status / $error / $signal',
  (result) => {
    put('apps/web/src/a.ts', 'old\n')
    vi.spyOn(childProcess, 'spawnSync').mockReturnValue(
      result as ReturnType<typeof childProcess.spawnSync>,
    )
    syncBuiltinESMExports()
    expect(() => diffOf(join(root, 'apps/web/src/a.ts'), 'apps/web/src/a.ts', 'new\n')).toThrow(
      /git diff/,
    )
  },
)
