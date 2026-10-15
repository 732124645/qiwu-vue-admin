// Server dev loop (criterion ③ of docs/adr/001-module-format.md): `nest start --watch` does not restart when @qiwu/shared's dist
// changes, so run tsc -w for the server and `node --watch` on both dist dirs. Locale JSON is read straight
// from src/i18n + packages/shared/src/i18n (I18N_DIR, see src/core/paths.ts) because tsc copies no assets; the
// generator's templates likewise from codegen-templates (CODEGEN_TEMPLATES). Env files (.env, then
// .env.local) are loaded by the app itself (CoreConfigModule).
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('../apps/server/', import.meta.url))
const tscArgs = ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '-w']
const tsc = spawn(process.execPath, [...tscArgs, '--preserveWatchOutput'], {
  cwd,
  stdio: ['ignore', 'pipe', 'inherit'],
})
let app

// QW_INSPECT=1 (or a port) opens the Node inspector on the app process only, never on tsc or Vite (a
// global NODE_OPTIONS=--inspect would make every process of `pnpm dev` fight over the port); loopback
// only. `node --watch` restarts the app on the same port, so a debugger set to reattach follows it.
const flag = process.env.QW_INSPECT ?? ''
const port = Number(flag)
const inspectPort = ['1', 'true'].includes(flag)
  ? 9229
  : Number.isInteger(port) && port >= 1024 && port <= 65535
    ? port
    : undefined
if (flag && inspectPort === undefined && !['0', 'false'].includes(flag))
  console.warn(`QW_INSPECT=${flag} ignored: use 1, true or a port from 1024 to 65535`)
const inspect =
  inspectPort === undefined ? [] : [`--inspect=127.0.0.1:${inspectPort}`, '--enable-source-maps']

// start the app after tsc's first build, so dist/main.js exists
tsc.stdout.on('data', (chunk) => {
  process.stdout.write(chunk)
  if (app || !String(chunk).includes('Watching for file changes')) return
  const watched = [
    'dist',
    'src/i18n',
    '../../packages/shared/dist',
    '../../packages/shared/src/i18n',
  ]
  const watch = watched.map((p) => `--watch-path=${p}`)
  app = spawn(process.execPath, [...inspect, ...watch, 'dist/main.js'], {
    cwd,
    stdio: 'inherit',
    env: { I18N_DIR: 'src/i18n', CODEGEN_TEMPLATES: 'codegen-templates', ...process.env },
  })
})

const stop = () => {
  tsc.kill()
  app?.kill()
}
process.once('SIGINT', stop).once('SIGTERM', stop)
tsc.once('exit', (code) => {
  app?.kill()
  process.exitCode = code ?? 0
})
