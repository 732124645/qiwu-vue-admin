// Full local gate (see docs/design-notes.md#layering): run steps in order, stop at the first failure, print a summary.
// --dry: only print the planned steps (RUN/SKIP) and exit 0.
// --parallel: after the non-server tests, server test → golden and Playwright (web,
// then mobile when mobile/ exists) run side by side, each step in its own process group with its
// output in its own log file; the first failure stops the other lane. --serial (the default until 3
// green parallel runs in a row) wins over --parallel.
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
const before = [
  ['install', 'pnpm i --frozen-lockfile'],
  ['verify', 'pnpm verify'],
  ['build', 'pnpm -r build'],
  // the arch run inside verify precedes the build: scan the fresh apps/web/dist
  ['web bundle', 'node scripts/arch/run.mjs --only web-bundle'],
  // Playwright only sees the build: import every .vue module and lazy dep under the Vite dev server,
  // then render the form designer
  ['web dev smoke', 'pnpm smoke:web-dev'],
  ['test (non-server)', 'pnpm -r --fail-if-no-match --filter "!@qiwu/server" test'],
  ['mobile install', 'pnpm mobile:install', MOBILE],
  ['mobile verify', 'pnpm mobile:verify', MOBILE],
  ['mobile test', 'pnpm mobile:test', MOBILE],
  ['mobile build h5', 'pnpm mobile:build:h5', MOBILE],
  // + the WeChat package size check (main package ≤ 2 MB)
  ['mobile build mp-weixin', 'pnpm mobile:build:mp-weixin', MOBILE],
]
// --parallel runs these two side by side: server tests + golden use .env.test (qiwu_test, Redis db
// 15), Playwright .env.e2e (qiwu_e2e, db 14) and its own ports
const lanes = [
  [
    [
      'test server + coverage',
      'pnpm --filter @qiwu/server exec vitest run --coverage --reporter=default --reporter=../../scripts/vitest-file-times.mjs',
    ],
    // G0 modules = what the generator renders from their seeded config (.env.test: qiwu_test);
    // the server dist is the build step's
    ['gen:check-golden', 'pnpm gen:check-golden --skip-build'],
  ],
  // runs the dist of the build step (server: .env.e2e, qiwu_e2e + Redis db 14; web: vite build +
  // preview under the SPA CSP); the global setup prints the browser channel. Then the mobile
  // H5 suite on its own database, Redis db and ports (qiwu_mobile_e2e, 9, 3201/4175)
  [
    ['playwright', 'pnpm --filter @qiwu/web e2e'],
    ['mobile e2e', 'pnpm mobile:e2e', MOBILE],
  ],
]
const after = [['smoke:boot', 'pnpm smoke:boot']]

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
  const parallel = argv.includes('--parallel') && !argv.includes('--serial')
  if (process.platform === 'win32' && parallel) throw new Error('use --serial on Windows')
  if (!dry) rmSync(fileTimes, { force: true })
  const env = { ...process.env, QW_FILE_TIMES: fileTimes }
  const results = []
  const failed = () => results.some(([, status]) => !['PASS', 'SKIP', 'planned'].includes(status))
  const serial = (steps) => {
    for (const step of steps)
      results.push(failed() ? [step[0], 'not run', ''] : runStep(step, dry, env))
  }

  if (!parallel) serial([...before, ...lanes.flat(), ...after])
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
