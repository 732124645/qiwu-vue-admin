// scripts/ci-local.mjs: `--parallel` runs server test → golden beside
// Playwright (web, then mobile), each step in its own process group logging to its own file; the
// first failure stops the other lane's whole group. Serial stays the default and `--serial` wins over
// `--parallel`.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

type Step = [name: string, cmd: string, skip?: string]
const PATH = join(process.cwd(), '../../scripts/ci-local.mjs')
const { runLanes } = (await import(pathToFileURL(PATH).href)) as {
  runLanes: (lanes: Step[][], opts: { logDir: string }) => Promise<[string, string, string][]>
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qw-ci-local-spec-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Shell prefix: waits up to ~10 s for `file`, then runs the rest only if it is there (no endless loop). */
const whenFile = (file: string) =>
  `for i in $(seq 200); do [ -f '${file}' ] && break; sleep 0.05; done; [ -f '${file}' ] &&`
const log = (step: string) => readFileSync(join(dir, `qw-ci-local-${step}.log`), 'utf8')
const statuses = (rows: [string, string, string][]) => rows.map(([name, status]) => [name, status])
const alive = (pid: number) => {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

describe.skipIf(process.platform === 'win32')('POSIX parallel lanes', () => {
  it('runs the lanes side by side, each lane in order, every step logging to its own file', async () => {
    const flag = join(dir, 'flag')
    // the first lane waits for a file only the second lane writes: serial would never end
    const rows = await runLanes(
      [
        [
          ['wait flag', `${whenFile(flag)} echo waited`],
          ['then', 'echo then; echo err >&2'],
        ],
        [
          ['write flag', `touch '${flag}'; echo wrote`],
          // a step of a part this checkout lacks: skipped, never run
          ['skipped', `touch '${join(dir, 'ran')}'`, 'part missing'],
        ],
      ],
      { logDir: dir },
    )
    expect(statuses(rows)).toEqual([
      ['wait flag', 'PASS'],
      ['then', 'PASS'],
      ['write flag', 'PASS'],
      ['skipped', 'SKIP'],
    ])
    expect(existsSync(join(dir, 'ran'))).toBe(false)
    expect(log('wait-flag')).toBe('waited\n')
    expect(log('then')).toBe('then\nerr\n')
    expect(log('write-flag')).toBe('wrote\n')
  }, 15_000)

  it('the first failure stops the other lane: its whole process group, and its later steps never run', async () => {
    const pidFile = join(dir, 'pid')
    // a grandchild (node under sh), so only a signal to the whole group reaches it; gone by itself after
    // 30 s should the test fail
    const hang = `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(() => {}, 30000)"; echo never`
    const started = Date.now()
    const rows = await runLanes(
      [
        [
          ['hang', hang],
          ['after hang', `touch '${join(dir, 'ran')}'`],
        ],
        [['boom', `${whenFile(pidFile)} echo boom; exit 3`]],
      ],
      { logDir: dir },
    )
    expect(statuses(rows)).toEqual([
      ['hang', 'stopped'],
      ['after hang', 'not run'],
      ['boom', 'FAIL (3)'],
    ])
    // stopped by the Ctrl-C to its group, not by the SIGKILL 10 s later
    expect(Date.now() - started).toBeLessThan(8000)
    await vi.waitFor(() => expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false), {
      timeout: 5000,
    })
    expect(existsSync(join(dir, 'ran'))).toBe(false)
    expect(log('hang')).not.toContain('never')
    expect(log('boom')).toBe('boom\n')
  }, 20_000)

  it('serial by default; --parallel plans the two lanes after the non-server tests; --serial wins; mobile e2e follows the web Playwright', () => {
    const plan = (...args: string[]) => {
      const r = spawnSync(process.execPath, [PATH, '--dry', ...args], { encoding: 'utf8' })
      expect(r.status).toBe(0)
      return r.stdout
    }
    const lanes = [
      'test server + coverage: RUN  pnpm --filter @qiwu/server exec vitest run --coverage',
      'gen:check-golden: RUN  pnpm gen:check-golden --skip-build  (parallel lane 1)',
      'playwright: RUN  pnpm --filter @qiwu/web e2e  (parallel lane 2)',
    ]
    expect(plan()).not.toContain('parallel')
    expect(plan('--parallel', '--serial')).not.toContain('parallel')
    const parallel = plan('--parallel')
    for (const line of lanes) expect(parallel).toContain(line)
    // SKIP in a PC-only checkout (docs/mobile.md)
    expect(parallel).toMatch(
      /mobile e2e: (RUN {2}pnpm mobile:e2e|SKIP \(.+\)) {2}\(parallel lane 2\)/,
    )
    // the steps around the lanes stay serial, in the same order
    const order = [
      'test (non-server)',
      'test server',
      'gen:check-golden',
      'playwright',
      'mobile e2e',
      'smoke:boot',
    ]
    for (const out of [plan(), parallel]) {
      const at = order.map((step) => out.indexOf(`▶ ${step}`))
      expect(at).toEqual([...at].sort((a, b) => a - b))
      expect(at).not.toContain(-1)
    }
  })
})

it('plans shell commands without single quotes and requires matches for the non-server filter', () => {
  const result = spawnSync(process.execPath, [PATH, '--dry'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  const commands = result.stdout.split('\n').filter((line) => line.includes(': RUN  '))
  expect(commands.length).toBeGreaterThan(0)
  for (const command of commands) expect(command).not.toContain("'")
  expect(result.stdout).toContain(
    'test (non-server): RUN  pnpm -r --fail-if-no-match --filter "!@qiwu/server" test',
  )
})

it('builds the shared package right after the frozen install, before verify, in both modes', () => {
  for (const args of [[], ['--parallel']]) {
    const out = spawnSync(process.execPath, [PATH, '--dry', ...args], { encoding: 'utf8' }).stdout
    expect(out).toContain('shared build: RUN  pnpm --filter @qiwu/shared build\n')
    // a fresh checkout has no packages/shared/dist: verify's typecheck needs it
    const steps = out
      .split('\n')
      .filter((line) => line.startsWith('▶ '))
      .map((line) => line.slice(2, line.indexOf(':')))
    expect(steps.slice(0, 4)).toEqual(['install', 'shared build', 'verify', 'build'])
  }
})

it('rejects effective parallel mode on Windows before planning any step, while --serial wins', () => {
  const preload = join(dir, 'win32.mjs')
  writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' })\n")
  const plan = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, PATH, '--dry', ...args], {
      encoding: 'utf8',
    })
  const parallel = plan('--parallel')
  expect(parallel.status).not.toBeNull()
  expect(parallel.status).not.toBe(0)
  expect(parallel.stderr).toContain('--serial')
  expect(parallel.stdout).not.toContain('▶')
  const serial = plan('--parallel', '--serial')
  expect(serial.status).toBe(0)
  expect(serial.stdout).toContain('ci:local summary (dry run)')
  expect(serial.stdout).not.toContain('parallel')
})
