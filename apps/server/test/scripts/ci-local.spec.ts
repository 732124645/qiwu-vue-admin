// scripts/ci-local.mjs: `--parallel` runs server test → golden beside
// Playwright (web, web with multi-tenancy on, then mobile), each step in its own process group logging to its own file; the
// first failure stops the other lane's whole group. Serial stays the default and `--serial` wins over
// `--parallel`. `--part <name> [--shard <i>/<n>]` plans one slice of the gate, as the CI jobs run it.
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

  it('serial by default; --parallel plans the two lanes after the non-server tests; --serial wins; the multi-tenancy Playwright, then mobile e2e follow the web Playwright', () => {
    const plan = (...args: string[]) => {
      const r = spawnSync(process.execPath, [PATH, '--dry', ...args], { encoding: 'utf8' })
      expect(r.status).toBe(0)
      return r.stdout
    }
    const lanes = [
      'test server + coverage: RUN  pnpm --filter @qiwu/server exec vitest run --coverage',
      'gen:check-golden: RUN  pnpm gen:check-golden --skip-build  (parallel lane 1)',
      'playwright: RUN  pnpm --filter @qiwu/web e2e  (parallel lane 2)',
      'playwright tenant: RUN  pnpm --filter @qiwu/web e2e:tenant  (parallel lane 2)',
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
      'playwright:',
      'playwright tenant:',
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

it('builds the shared package right after the frozen install, before verify, in every mode the platform runs', () => {
  // Windows refuses effective parallel mode before planning (see the next case)
  const modes = process.platform === 'win32' ? [[]] : [[], ['--parallel']]
  for (const args of modes) {
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

describe('--part: one slice of the gate per CI job', () => {
  const plan = (...args: string[]) =>
    spawnSync(process.execPath, [PATH, '--dry', ...args], { encoding: 'utf8' })
  /** The planned `▶ …` lines; a mobile step of a PC-only checkout (docs/mobile.md) reads as RUN. */
  const steps = (...args: string[]) => {
    const r = plan(...args)
    expect(r.status).toBe(0)
    return r.stdout
      .split('\n')
      .filter((line) => line.startsWith('▶ '))
      .map((line) => line.replace(/^▶ (mobile [^:]+): SKIP \(.+\)$/, '▶ $1: RUN'))
  }
  const names = (lines: string[]) => lines.map((line) => line.slice(2, line.indexOf(': ')))
  const setup = [
    '▶ install: RUN  pnpm i --frozen-lockfile',
    '▶ shared build: RUN  pnpm --filter @qiwu/shared build',
    '▶ build (server): RUN  pnpm --filter @qiwu/server build',
  ]
  const vitest = 'pnpm --filter @qiwu/server exec vitest run'
  const fileTimes = '--reporter=../../scripts/vitest-file-times.mjs'

  it('without --part the server step stays one unsharded run without a blob report', () => {
    expect(plan().stdout).toContain(
      `test server + coverage: RUN  ${vitest} --coverage --reporter=default ${fileTimes}\n`,
    )
  })

  it('server: one vitest shard with coverage into a blob report; only shard 1 checks the golden modules', () => {
    const shard = (i: number) =>
      `▶ test server ${i}/3 + coverage: RUN  ${vitest} --shard=${i}/3 --coverage --reporter=default --reporter=blob ${fileTimes}`
    expect(steps('--part', 'server', '--shard', '1/3')).toEqual([
      ...setup,
      shard(1),
      '▶ gen:check-golden: RUN  pnpm gen:check-golden --skip-build',
    ])
    expect(steps('--part', 'server', '--shard', '2/3')).toEqual([...setup, shard(2)])
  })

  it('coverage merges the blob reports (the thresholds apply there); needs the install only', () => {
    expect(steps('--part', 'coverage')).toEqual([
      '▶ install: RUN  pnpm i --frozen-lockfile',
      `▶ coverage (merged shards): RUN  ${vitest} --merge-reports --coverage`,
    ])
  })

  it('web-e2e: one Playwright shard; more-e2e: multi-tenancy, then mobile', () => {
    expect(steps('--part', 'web-e2e', '--shard', '2/3')).toEqual([
      ...setup,
      '▶ playwright 2/3: RUN  pnpm --filter @qiwu/web e2e --shard=2/3',
    ])
    expect(steps('--part', 'more-e2e')).toEqual([
      ...setup,
      '▶ playwright tenant: RUN  pnpm --filter @qiwu/web e2e:tenant',
      '▶ mobile install: RUN  pnpm mobile:install',
      '▶ mobile e2e: RUN  pnpm mobile:e2e',
    ])
  })

  it('checks: every step of the full gate but the server tests and Playwright, in the same order', () => {
    const full = names(steps())
    const checks = names(steps('--part', 'checks'))
    expect(checks).toEqual(
      full.filter((step) => !/^(test server|gen:check-golden|playwright|mobile e2e)/.test(step)),
    )
    expect(checks).toContain('smoke:boot')
    expect(checks).toContain('mobile build mp-weixin')
  })

  it.each([
    [['--part', 'nope'], '--part takes one of checks, server, coverage, web-e2e, more-e2e'],
    [['--part'], '--part takes one of'],
    [['--shard', '1/3'], '--shard needs --part server or --part web-e2e'],
    [['--part', 'checks', '--shard', '1/3'], '--part checks has no shards'],
    [['--part', 'more-e2e', '--shard', '1/1'], '--part more-e2e has no shards'],
    [['--part', 'server', '--shard', '0/3'], '--shard takes <i>/<n>'],
    [['--part', 'server', '--shard', '4/3'], '--shard takes <i>/<n>'],
    [['--part', 'web-e2e', '--shard', '2'], '--shard takes <i>/<n>'],
    [['--part', 'web-e2e', '--shard'], '--shard takes <i>/<n>'],
    [['--part', 'server', '--parallel'], 'drop --parallel'],
    [['--part', 'server'], '--part server needs --shard <i>/<n>'],
    [['--part', 'web-e2e'], '--part web-e2e needs --shard <i>/<n>'],
    [['--part', 'web-e2e', '--shard=2/3'], 'write --shard 2/3'],
    [['--part=server', '--shard', '1/3'], 'write --part server'],
  ])('rejects %j before planning any step', (args, message) => {
    const r = plan(...args)
    expect(r.status).not.toBeNull()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(message)
    expect(r.stdout).not.toContain('▶')
  })
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
