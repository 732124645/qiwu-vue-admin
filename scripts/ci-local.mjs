// Full local gate (see docs/design-notes.md#layering): run steps in order, stop at the first failure, print a summary.
// --dry: only print the planned steps (RUN/SKIP) and exit 0.
// --parallel: after the non-server tests, server test → golden and Playwright (web, web with
// multi-tenancy on, then mobile when mobile/ exists) run side by side, each step in its own process group with its
// output in its own log file; the first failure stops the other lane. --serial (the default until 3
// green parallel runs in a row) wins over --parallel.
// --part <name> [--shard <i>/<n>]: one slice of the gate, as the parallel jobs of .github/workflows/ci.yml
// run it (each on its own runner, in order): checks (everything but the server tests and Playwright),
// server (one vitest shard with coverage into a blob report under apps/server/.vitest/blob; shard 1
// then runs gen:check-golden and smoke:boot), coverage (merges those blobs and checks the coverage thresholds),
// web-e2e (one Playwright shard) and more-e2e (Playwright with multi-tenancy on, then mobile). server
// and web-e2e need --shard (1/1: one run; a server shard never checks the thresholds, --part coverage
// does). The Playwright runs and the server specs that start dist need the server build only.
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
/** the server step's per-file wall times (scripts/vitest-file-times.mjs), for the summary */
const fileTimes = join(tmpdir(), 'qw-ci-local-server-files.json')

// the uni-app client: its steps skip without it; PC-only: remove with mobile/ (docs/mobile.md)
const MOBILE = existsSync(join(root, 'mobile/package.json')) ? undefined : 'no mobile/'

// [name, shell command, skip reason or undefined]
const install = ['install', 'pnpm i --frozen-lockfile']
// the shared package exports its types from dist and a fresh checkout has none: verify's
// typecheck of the web e2e specs (tsconfig.node.json reads dist) would not resolve @qiwu/shared
const sharedBuild = ['shared build', 'pnpm --filter @qiwu/shared build']
const mobileInstall = ['mobile install', 'pnpm mobile:install', MOBILE]
const before = [
  install,
  sharedBuild,
  ['verify', 'pnpm verify'],
  ['build', 'pnpm -r build'],
  // the arch run inside verify precedes the build: scan the fresh apps/web/dist
  ['web bundle', 'node scripts/arch/run.mjs --only web-bundle'],
  // Playwright only sees the build: import every .vue module and lazy dep under the Vite dev server,
  // then render the form designer
  ['web dev smoke', 'pnpm smoke:web-dev'],
  ['test (non-server)', 'pnpm -r --fail-if-no-match --filter "!@qiwu/server" test'],
  mobileInstall,
  ['mobile verify', 'pnpm mobile:verify', MOBILE],
  ['mobile test', 'pnpm mobile:test', MOBILE],
  ['mobile build h5', 'pnpm mobile:build:h5', MOBILE],
  // + the WeChat package size check (main package ≤ 2 MB)
  ['mobile build mp-weixin', 'pnpm mobile:build:mp-weixin', MOBILE],
]
// a shard (`i/n`) also writes its results and coverage as a blob report for the merge
const serverTest = (shard) =>
  `pnpm --filter @qiwu/server exec vitest run${shard ? ` --shard=${shard}` : ''} --coverage --reporter=default${shard ? ' --reporter=blob' : ''} --reporter=../../scripts/vitest-file-times.mjs`
// G0 modules = what the generator renders from their seeded config (.env.test: qiwu_test);
// the server dist is the build step's
const golden = ['gen:check-golden', 'pnpm gen:check-golden --skip-build']
const playwrightTenant = ['playwright tenant', 'pnpm --filter @qiwu/web e2e:tenant']
const mobileE2e = ['mobile e2e', 'pnpm mobile:e2e', MOBILE]
// --parallel runs these two side by side: server tests + golden use .env.test (qiwu_test, Redis db
// 15), Playwright .env.e2e (qiwu_e2e, db 14) and its own ports
const lanes = [
  [['test server + coverage', serverTest()], golden],
  // runs the dist of the build step (server: .env.e2e, qiwu_e2e + Redis db 14; web: vite build +
  // preview under the SPA CSP); the global setup prints the browser channel. Then the same with
  // multi-tenancy on (e2e-tenant/: qiwu_tenant_e2e, 1, 3203/4176) and the mobile H5 suite on its own
  // database, Redis db and ports (qiwu_mobile_e2e, 9, 3201/4175): one Playwright run at a time
  [['playwright', 'pnpm --filter @qiwu/web e2e'], playwrightTenant, mobileE2e],
]
const after = [['smoke:boot', 'pnpm smoke:boot']]

// --part <name> → (i, n) => its steps; the Playwright web servers build the web app and the H5 client
// themselves, so the e2e parts build the server only
const serverBuild = ['build (server)', 'pnpm --filter @qiwu/server build']
const PARTS = {
  // smoke:boot boots against qiwu_test: only the server part has it migrated and seeded
  checks: () => [...before],
  // a shard alone never reaches the coverage thresholds (vitest.config.ts): the merge checks them
  server: (i, n) => [
    install,
    sharedBuild,
    serverBuild,
    [`test server ${i}/${n} + coverage`, serverTest(`${i}/${n}`)],
    ...(i === 1 ? [golden, ...after] : []),
  ],
  coverage: () => [
    install,
    [
      'coverage (merged shards)',
      'pnpm --filter @qiwu/server exec vitest run --merge-reports --coverage',
    ],
  ],
  'web-e2e': (i, n) => [
    install,
    sharedBuild,
    serverBuild,
    [`playwright ${i}/${n}`, `pnpm --filter @qiwu/web e2e --shard=${i}/${n}`],
  ],
  'more-e2e': () => [install, sharedBuild, serverBuild, playwrightTenant, mobileInstall, mobileE2e],
}
const SHARDED = ['server', 'web-e2e']

/** The steps of `--part <name> [--shard <i>/<n>]`, or undefined without --part. */
function partSteps(argv) {
  const joined = argv.find((arg) => /^--(part|shard)=/.test(arg))
  if (joined)
    throw new Error(
      `write ${joined.replace('=', ' ')}: --part and --shard take their value as the next argument`,
    )
  const at = argv.indexOf('--part')
  const shardAt = argv.indexOf('--shard')
  if (at < 0) {
    if (shardAt >= 0) throw new Error('--shard needs --part server or --part web-e2e')
    return undefined
  }
  const part = argv[at + 1]
  if (!Object.hasOwn(PARTS, part ?? ''))
    throw new Error(`--part takes one of ${Object.keys(PARTS).join(', ')}, got ${part}`)
  if (argv.includes('--parallel'))
    throw new Error('--part runs its steps in order: drop --parallel')
  // one server shard alone never checks the coverage thresholds: run every shard, then --part coverage
  if (shardAt < 0 && SHARDED.includes(part))
    throw new Error(`--part ${part} needs --shard <i>/<n> (1/1 for one run)`)
  if (shardAt < 0) return PARTS[part](1, 1)
  if (!SHARDED.includes(part)) throw new Error(`--part ${part} has no shards`)
  const [, i, n] = /^(\d+)\/(\d+)$/.exec(argv[shardAt + 1] ?? '') ?? []
  if (!(Number(i) >= 1 && Number(i) <= Number(n)))
    throw new Error(`--shard takes <i>/<n> with 1 <= i <= n, got ${argv[shardAt + 1]}`)
  return PARTS[part](Number(i), Number(n))
}

/** Signals the process group of `kid` (detached: its own group); false once the group is gone. */
const group = (kid, sig) => {
  try {
    return process.kill(-kid.pid, sig)
  } catch {
    return false
  }
}

/**
 * Ctrl-C to the whole group, as a terminal would (Playwright then tears down its web servers), and
 * SIGKILL to whatever of it is still running 10 s later.
 */
function stop(kid) {
  kid.stopped = true
  group(kid, 'SIGINT')
  const deadline = Date.now() + 10_000
  const poll = setInterval(() => {
    if (group(kid, 0) && Date.now() < deadline) return
    group(kid, 'SIGKILL')
    clearInterval(poll)
  }, 200)
}

/**
 * Runs each lane's steps in order and the lanes side by side, every step in its own process group with
 * stdout + stderr in `<logDir>/qw-ci-local-<step>.log`. The first failure (or a SIGINT/SIGTERM/SIGHUP
 * of this process) stops the other lanes; their later steps do not run. Returns [name, status, secs]
 * per step, in lane order.
 * A SIGKILL of ci:local itself leaves the running groups behind (they are not its group).
 */
export async function runLanes(lanes, { logDir = tmpdir(), env = process.env } = {}) {
  const running = new Set()
  let failed = false
  const stopAll = () => {
    failed = true
    for (const kid of running) if (!kid.stopped) stop(kid)
  }
  const lane = async (steps) => {
    const out = []
    for (const [name, cmd, skip] of steps) {
      if (skip) {
        console.log(`\n▶ ${name}: SKIP (${skip})`)
        out.push([name, 'SKIP', ''])
        continue
      }
      if (failed) {
        out.push([name, 'not run', ''])
        continue
      }
      const log = join(logDir, `qw-ci-local-${name.replace(/\W+/g, '-')}.log`)
      console.log(`\n▶ ${name}: ${cmd}\n  log: ${log}`)
      const fd = openSync(log, 'w')
      const started = Date.now()
      const kid = spawn(cmd, {
        cwd: root,
        shell: true,
        detached: true,
        env,
        stdio: ['ignore', fd, fd],
      })
      closeSync(fd)
      running.add(kid)
      const [code, signal] = await once(kid, 'exit')
      running.delete(kid)
      const secs = ((Date.now() - started) / 1000).toFixed(1)
      const status = code === 0 ? 'PASS' : kid.stopped ? 'stopped' : `FAIL (${code ?? signal})`
      console.log(`\n${code === 0 ? '✓' : '✗'} ${name}: ${status} ${secs}s`)
      out.push([name, status, secs])
      if (code !== 0 && !kid.stopped) {
        console.log(readFileSync(log, 'utf8').split('\n').slice(-40).join('\n'))
        stopAll()
      }
    }
    return out
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const s of signals) process.on(s, stopAll)
  try {
    return (await Promise.all(lanes.map(lane))).flat()
  } finally {
    for (const s of signals) process.off(s, stopAll)
  }
}

/** One step in this terminal: [name, status, secs]. */
function runStep([name, cmd, skip], dry, env) {
  if (skip) {
    console.log(`\n▶ ${name}: SKIP (${skip})`)
    return [name, 'SKIP', '']
  }
  if (dry) {
    console.log(`\n▶ ${name}: RUN  ${cmd}`)
    return [name, 'planned', '']
  }
  console.log(`\n▶ ${name}: ${cmd}`)
  const started = Date.now()
  const r = spawnSync(cmd, { cwd: root, shell: true, stdio: 'inherit', env })
  return [
    name,
    r.status === 0 ? 'PASS' : `FAIL (${r.status ?? r.signal})`,
    ((Date.now() - started) / 1000).toFixed(1),
  ]
}

async function main(argv) {
  const dry = argv.includes('--dry')
  const part = partSteps(argv)
  const parallel = argv.includes('--parallel') && !argv.includes('--serial')
  if (process.platform === 'win32' && parallel) throw new Error('use --serial on Windows')
  if (!dry) rmSync(fileTimes, { force: true })
  // 完整闸门每次重建测试库：本地快速模式的开关即使留在终端环境里也不带进去
  const { QW_TEST_REUSE_DB: _reuse, ...inherited } = process.env
  const env = { ...inherited, QW_FILE_TIMES: fileTimes }
  const results = []
  const failed = () => results.some(([, status]) => !['PASS', 'SKIP', 'planned'].includes(status))
  const serial = (steps) => {
    for (const step of steps)
      results.push(failed() ? [step[0], 'not run', ''] : runStep(step, dry, env))
  }

  if (part) serial(part)
  else if (!parallel) serial([...before, ...lanes.flat(), ...after])
  else {
    serial(before)
    if (failed()) serial(lanes.flat())
    else if (dry)
      lanes.forEach((steps, i) => {
        for (const [name, cmd, skip] of steps) {
          console.log(
            `\n▶ ${name}: ${skip ? `SKIP (${skip})` : `RUN  ${cmd}`}  (parallel lane ${i + 1})`,
          )
          results.push([name, skip ? 'SKIP' : 'planned', ''])
        }
      })
    else results.push(...(await runLanes(lanes, { env })))
    serial(after)
  }

  const w = Math.max(...results.map(([n]) => n.length))
  console.log(`\nci:local summary${dry ? ' (dry run)' : ''}${parallel ? ' (parallel)' : ''}`)
  for (const [name, status, secs] of results)
    console.log(`  ${name.padEnd(w)}  ${status.padEnd(12)} ${secs && `${secs}s`}`)
  if (!dry && existsSync(fileTimes)) {
    console.log('\nslowest server test files (import + setup + hooks + tests)')
    for (const [file, ms] of JSON.parse(readFileSync(fileTimes, 'utf8')).slice(0, 10))
      console.log(`  ${(ms / 1000).toFixed(1).padStart(6)}s  ${file}`)
  }
  console.log(failed() ? '\nci:local FAILED' : dry ? '' : '\nci:local PASSED')
  process.exitCode = failed() ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
