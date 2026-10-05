// Boot the built server, poll GET /api/health (code===0) for up to 20 s, always kill it (see docs/design-notes.md#layering).
// --cjs: the CommonJS insurance probe of docs/adr/001-module-format.md — recompile src as CommonJS into apps/server/.cjs-probe and boot that.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const serverDir = fileURLToPath(new URL('../apps/server/', import.meta.url))
const probeDir = join(serverDir, '.cjs-probe')
const cjs = process.argv.includes('--cjs')
const TIMEOUT_MS = 20_000

const loadEnv = (file) => {
  const path = join(serverDir, file)
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {}
}

// Same sources and tsconfig.build.json, only the emitted module format changes.
function buildCjs() {
  rmSync(probeDir, { recursive: true, force: true })
  mkdirSync(probeDir)
  writeFileSync(join(probeDir, 'package.json'), '{ "type": "commonjs" }\n')
  const tsc = join(serverDir, 'node_modules/typescript/bin/tsc')
  const args = [
    '-p',
    'tsconfig.build.json',
    '--module',
    'commonjs',
    '--moduleResolution',
    'bundler',
  ]
  args.push('--outDir', '.cjs-probe/dist', '--incremental', 'false', '--declaration', 'false')
  const r = spawnSync(process.execPath, [tsc, ...args], { cwd: serverDir, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`tsc --module commonjs exited ${r.status ?? r.signal}`)
  return '.cjs-probe/dist/main.js'
}

// null when healthy, otherwise a short reason.
async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    const body = await res.text()
    if (res.status === 200 && JSON.parse(body).code === 0) return null
    return `HTTP ${res.status}: ${body.slice(0, 200)}`
  } catch (err) {
    return err.cause?.code ?? err.message
  }
}

async function boot(entry) {
  if (!existsSync(join(serverDir, entry)))
    throw new Error(`${entry} not found — run pnpm --filter @qiwu/server build`)
  // ENV_FILE: the server's own env loading (CoreConfigModule) uses the same mode file
  const env = {
    ...process.env,
    ...loadEnv('.env.local'),
    ...loadEnv('.env.test'),
    ENV_FILE: '.env.test',
  }
  if (!env.PORT) throw new Error('PORT missing from apps/server/.env.test')
  const url = `http://127.0.0.1:${env.PORT}/api/health`
  if ((await probe(url)) === null) throw new Error(`something already serves ${url}; stop it first`)

  const child = spawn(process.execPath, [entry], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  let exitInfo = null
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve((exitInfo = signal ?? code))),
  )
  const kill = () => child.kill('SIGKILL')
  process.once('SIGINT', kill).once('SIGTERM', kill)

  const started = Date.now()
  let reason = 'no response'
  try {
    while (exitInfo === null && Date.now() - started < TIMEOUT_MS) {
      reason = await probe(url)
      if (reason === null) return `${entry} healthy at ${url} after ${Date.now() - started} ms`
      await delay(250)
    }
    reason =
      exitInfo !== null
        ? `server exited (${exitInfo})`
        : `timeout ${TIMEOUT_MS} ms, last: ${reason}`
    throw new Error(`${reason}\n--- server stderr ---\n${stderr.trim() || '(empty)'}`)
  } finally {
    child.kill('SIGTERM')
    const force = setTimeout(kill, 5000)
    await exited
    clearTimeout(force)
  }
}

try {
  console.log(
    `smoke:boot OK (${cjs ? 'cjs' : 'esm'}): ${await boot(cjs ? buildCjs() : 'dist/main.js')}`,
  )
} catch (err) {
  console.error(`smoke:boot FAIL (${cjs ? 'cjs' : 'esm'}): ${err.message}`)
  process.exitCode = 1
} finally {
  if (cjs) rmSync(probeDir, { recursive: true, force: true })
}
