import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { duration, inspectorArgs, runDevServer } from './dev-server.mjs'

const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const typescript = fileURLToPath(
  new URL('../node_modules/typescript/lib/typescript.js', import.meta.url),
)
const sharedRunner = fileURLToPath(new URL('./dev-shared.mjs', import.meta.url))

/** 有界等待真实编译器与子进程，不触及数据库、网络或项目源码。 */
async function until(check, label) {
  const end = Date.now() + 20_000
  while (Date.now() < end) {
    const value = check()
    if (value) return value
    await delay(25)
  }
  throw new Error(`timeout: ${label}`)
}
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const pidOf = (line) => Number(line.match(/fixture:[^:]+:(\d+)/)[1])

/** 两个实际 TypeScript 项目：后端从共享包的已编译声明校验、从 JS 运行，绝不直读共享源码。 */
function fixture({ slowStop = 0, preload } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qw-dev-loop-'))
  const cwd = join(root, 'apps/server')
  const shared = join(root, 'packages/shared')
  for (const path of [cwd, shared]) {
    mkdirSync(join(path, 'src'), { recursive: true })
    writeFileSync(join(path, 'package.json'), '{"type":"module"}')
  }
  const options = {
    target: 'ES2023',
    module: 'NodeNext',
    types: [],
    lib: ['ES2023'],
    outDir: 'dist',
    rootDir: 'src',
    strict: true,
    declaration: true,
    incremental: true,
    tsBuildInfoFile: 'dist/.tsbuildinfo',
  }
  writeFileSync(
    join(cwd, 'tsconfig.build.json'),
    JSON.stringify({ compilerOptions: options, include: ['src/*.ts'] }),
  )
  writeFileSync(
    join(shared, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: options,
      include: ['src/*.ts'],
      exclude: ['src/**/*.spec.ts'],
    }),
  )
  const main = join(cwd, 'src/main.ts'),
    index = join(shared, 'src/index.ts')
  const source = (version, value = "'ok'") => `
import { readMarker } from '../../../packages/shared/dist/index.js';
declare const process: { pid: number; send: (value: unknown) => void; on: (event: string, fn: () => void) => void; exit: (code: number) => never };
declare function setInterval(fn: () => void, ms: number): void;
declare function setTimeout(fn: () => void, ms: number): void;
const value: string = ${value};
process.send({ type: 'qw:dev-ready', url: 'fixture:${version}-' + readMarker() + ':' + process.pid });
${slowStop ? `process.on('SIGTERM', () => setTimeout(() => process.exit(0), ${slowStop}));` : ''}
setInterval(() => {}, 1000);
`
  const marker = (text) => `export function readMarker(): string { return ${text} }`
  writeFileSync(main, source('one'))
  writeFileSync(index, marker("'initial'"))
  const output = []
  const ready = () => output.filter((line) => line.includes(' ready fixture:'))
  let loop
  return {
    root,
    cwd,
    shared,
    main,
    index,
    source,
    marker,
    output,
    ready,
    start() {
      const preloadFile = join(root, 'preload.mjs')
      if (preload) writeFileSync(preloadFile, preload(root))
      loop = runDevServer({
        cwd,
        compiler: [tsc, '-p', 'tsconfig.build.json', '--pretty', 'false', '--noEmitOnError'],
        sharedCompiler: [...(preload ? ['--import', preloadFile] : []), sharedRunner],
        write: (line) => output.push(line),
        inspect: [],
      })
      return loop
    },
    async close() {
      await loop?.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('timings and inspector retain real values without a fabricated initial baseline', () => {
  assert.equal(duration(101.4), '101 ms')
  assert.equal(duration(101, 130), '101 ms (-29 ms vs previous)')
  assert.deepEqual(inspectorArgs('1'), ['--inspect=127.0.0.1:9229', '--enable-source-maps'])
  assert.deepEqual(inspectorArgs('9231'), ['--inspect=127.0.0.1:9231', '--enable-source-maps'])
  assert.deepEqual(inspectorArgs('false'), [])
})

test(
  'real shared and server compilers retain the old app on either type error, then recover once',
  { timeout: 40_000 },
  async () => {
    const f = fixture(),
      loop = f.start()
    try {
      const first = await until(() => f.ready()[0], 'cold ready')
      let current = pidOf(first)
      assert.match(first, /cold start/)
      assert.doesNotMatch(first, /vs previous/)
      const timings = first.match(
        /shared compile (\d+) ms \| server compile (\d+) ms.*\| total (\d+) ms/,
      )
      assert.ok(Number(timings[3]) >= Number(timings[1]) + Number(timings[2]), first)
      const declaration = readFileSync(join(f.shared, 'dist/index.d.ts'), 'utf8')
      writeFileSync(f.index, f.marker("'body'"))
      const body = await until(
        () => f.ready().find((line) => line.includes('fixture:one-body:')),
        'body-only shared reload',
      )
      assert.equal(readFileSync(join(f.shared, 'dist/index.d.ts'), 'utf8'), declaration)
      assert.equal(alive(current), false)
      current = pidOf(body)
      await delay(500)
      assert.equal(f.ready().length, 2)

      writeFileSync(f.main, f.source('broken', '123'))
      await until(
        () => f.output.some((line) => line.startsWith('[server] compile failed:')),
        'server type error',
      )
      assert.equal(alive(current), true)
      assert.equal(f.ready().length, 2)
      writeFileSync(f.main, f.source('two'))
      const server = await until(
        () => f.ready().find((line) => line.includes('fixture:two-body:')),
        'server repaired',
      )
      current = pidOf(server)
      assert.match(server, /server compile \d+ ms/)
      assert.match(server, /vs previous/)

      writeFileSync(f.index, f.marker('123'))
      await until(
        () => f.output.some((line) => line.startsWith('[shared] compile failed:')),
        'shared type error',
      )
      assert.equal(alive(current), true)
      assert.equal(f.ready().length, 3)
      assert.match(f.output.join('\n'), /TS2322/)
      writeFileSync(f.index, f.marker("'fixed'"))
      const fixed = await until(
        () => f.ready().find((line) => line.includes('fixture:two-fixed:')),
        'shared repaired',
      )
      current = pidOf(fixed)
      await delay(600)
      assert.equal(f.ready().length, 4)

      writeFileSync(f.main, readFileSync(f.main))
      writeFileSync(f.index, readFileSync(f.index))
      writeFileSync(join(f.shared, 'src/ignored.spec.ts'), 'const bad: string = 123;')
      await delay(700)
      assert.equal(f.ready().length, 4, f.output.join('\n'))
      const locale = join(f.shared, 'src/i18n/en-US/validation.json')
      mkdirSync(join(f.shared, 'src/i18n/en-US'), { recursive: true })
      writeFileSync(locale, '{}')
      const translated = await until(() => f.ready()[4], 'locale reload')
      assert.match(translated, /shared compile not required \| server compile not required/)
      current = pidOf(translated)
      await loop.stop()
      assert.equal(alive(current), false)
      assert.equal(alive(loop.compilerPid), false)
    } finally {
      await f.close()
    }
  },
)

test(
  'shared outputs written over 900ms and a newer input during emit never start mixed or duplicate generations',
  { timeout: 35_000 },
  async () => {
    const f = fixture({
      preload: () => `
import ts from ${JSON.stringify(typescript)};
const write = ts.sys.writeFile;
let outputs = 0;
ts.sys.writeFile = (file, data, bom) => {
  write(file, data, bom);
  if (file.endsWith('.js') && ++outputs % 2 === 1) {
    console.log('fixture shared first output');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
  }
};
`,
    })
    const extra = join(f.shared, 'src/extra.ts')
    writeFileSync(extra, "export function extra(): string { return 'a0' }")
    writeFileSync(
      f.index,
      "import { extra } from './extra.js'; export function readMarker(): string { return extra() + '-b0' }",
    )
    f.start()
    try {
      await until(() => f.ready()[0], 'slow shared cold ready')
      const before = f.output.length
      writeFileSync(extra, "export function extra(): string { return 'a1' }")
      writeFileSync(
        f.index,
        "import { extra } from './extra.js'; export function readMarker(): string { return extra() + '-b1' }",
      )
      writeFileSync(f.main, f.source('two'))
      await until(
        () => f.output.slice(before).some((line) => line === 'fixture shared first output'),
        'first shared output written',
      )
      await delay(350)
      assert.equal(f.ready().length, 1, f.output.join('\n'))
      writeFileSync(
        f.index,
        "import { extra } from './extra.js'; export function readMarker(): string { return extra() + '-b2' }",
      )
      await until(
        () => f.ready().some((line) => line.includes('fixture:two-a1-b2:')),
        'latest complete shared generation',
      )
      await delay(900)
      assert.equal(f.ready().length, 2, f.output.join('\n'))
      assert.doesNotMatch(f.ready().slice(1).join('\n'), /a1-b0|a0-b1|a1-b1/)
    } finally {
      await f.close()
    }
  },
)

test(
  'a shared emit failure is not reported as success and keeps the old application alive',
  { timeout: 25_000 },
  async () => {
    const f = fixture({
      preload: (root) => `
import ts from ${JSON.stringify(typescript)};
import { existsSync } from 'node:fs';
const write = ts.sys.writeFile;
ts.sys.writeFile = (file, data, bom) => {
  if (file.endsWith('.js') && existsSync(${JSON.stringify(join(root, 'fail-emit'))})) throw new Error('fixture emit failed');
  write(file, data, bom);
};
`,
    })
    f.start()
    try {
      const initial = await until(() => f.ready()[0], 'emit fixture cold ready')
      writeFileSync(join(f.root, 'fail-emit'), '')
      writeFileSync(f.index, f.marker("'bad-emit'"))
      await until(
        () => f.output.some((line) => line.startsWith('[shared] compile failed:')),
        'emit error',
      )
      assert.match(f.output.join('\n'), /fixture emit failed/)
      assert.equal(alive(pidOf(initial)), true)
      assert.equal(f.ready().length, 1)
      rmSync(join(f.root, 'fail-emit'))
      writeFileSync(f.index, f.marker("'recovered'"))
      await until(
        () => f.ready().some((line) => line.includes('fixture:one-recovered:')),
        'emit repaired',
      )
      assert.equal(f.ready().length, 2)
    } finally {
      await f.close()
    }
  },
)

test(
  'successful newer server compilation during slow shutdown is consumed once; a failed one waits for repair',
  {
    timeout: 30_000,
    skip:
      process.platform === 'win32'
        ? 'Windows terminates child processes immediately instead of running SIGTERM handlers'
        : false,
  },
  async () => {
    const f = fixture({ slowStop: 900 })
    f.start()
    try {
      await until(() => f.ready()[0], 'overlap cold ready')
      const starts = () =>
        f.output.filter((line) => line.includes('changed') && line.includes('main.ts')).length
      let before = starts()
      writeFileSync(f.main, f.source('two'))
      await until(() => starts() > before, 'first slow shutdown')
      writeFileSync(f.main, f.source('latest'))
      await until(
        () => f.ready().some((line) => line.includes('fixture:latest-initial:')),
        'latest server ready',
      )
      await delay(1600)
      assert.equal(f.ready().length, 2, f.output.join('\n'))
      before = starts()
      writeFileSync(f.main, f.source('three'))
      await until(() => starts() > before, 'second slow shutdown')
      writeFileSync(f.main, f.source('broken', '123'))
      await until(
        () => f.output.some((line) => line.startsWith('[server] compile failed:')),
        'overlap type error',
      )
      assert.match(
        f.output.find((line) => line.startsWith('[server] compile failed:')),
        /waiting for a successful build/,
      )
      await delay(1100)
      assert.equal(f.ready().length, 2)
      writeFileSync(f.main, f.source('repaired'))
      await until(
        () => f.ready().some((line) => line.includes('fixture:repaired-initial:')),
        'overlap repaired',
      )
      assert.equal(f.ready().length, 3)
    } finally {
      await f.close()
    }
  },
)

test(
  'new and deleted shared source files settle through the compiler snapshot',
  { timeout: 20_000 },
  async () => {
    const f = fixture()
    f.start()
    try {
      await until(() => f.ready()[0], 'source lifecycle cold ready')
      const added = join(f.shared, 'src/added.ts')
      writeFileSync(added, "export const value = 'added'")
      writeFileSync(
        f.index,
        "import { value } from './added.js'; export function readMarker(): string { return value }",
      )
      await until(
        () => f.ready().some((line) => line.includes('fixture:one-added:')),
        'new shared source compiled',
      )
      rmSync(added)
      writeFileSync(f.index, f.marker("'removed'"))
      await until(
        () => f.ready().some((line) => line.includes('fixture:one-removed:')),
        'deleted shared source settled',
      )
      await delay(600)
      assert.equal(f.ready().length, 3, f.output.join('\n'))
      const config = join(f.cwd, 'tsconfig.build.json')
      const options = JSON.parse(readFileSync(config, 'utf8'))
      for (const sourceMap of [true, false]) {
        const before = f.ready().length
        options.compilerOptions.sourceMap = sourceMap
        writeFileSync(`${config}.next`, JSON.stringify(options))
        renameSync(`${config}.next`, config)
        await until(() => f.ready()[before], 'atomically replaced configuration compiled')
      }
      assert.equal(f.ready().length, 5, f.output.join('\n'))
    } finally {
      await f.close()
    }
  },
)

test(
  'a configuration changed during shared emit cannot be cleared by the older successful program',
  { timeout: 30_000 },
  async () => {
    const f = fixture({
      preload: () => `
import ts from ${JSON.stringify(typescript)};
const write = ts.sys.writeFile;
let outputs = 0;
ts.sys.setTimeout = (callback, ms, ...args) => setTimeout(callback, Math.max(ms, 1500), ...args);
ts.sys.writeFile = (file, data, bom) => {
  write(file, data, bom);
  if (file.endsWith('.js') && ++outputs === 2) {
    console.log('fixture configuration emit paused');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
  }
};
`,
    })
    const unused = (value) =>
      `export function readMarker(): string { const unused = 1; return '${value}' }`
    writeFileSync(f.index, unused('initial'))
    f.start()
    try {
      const first = await until(() => f.ready()[0], 'configuration race cold ready')
      writeFileSync(f.index, unused('after'))
      await until(
        () => f.output.includes('fixture configuration emit paused'),
        'old configuration emit in progress',
      )
      const config = join(f.shared, 'tsconfig.json')
      const options = JSON.parse(readFileSync(config, 'utf8'))
      options.compilerOptions.noUnusedLocals = true
      writeFileSync(config, JSON.stringify(options))
      await until(
        () => f.output.some((line) => line.startsWith('[shared] compile failed:')),
        'new configuration rejects unused local',
      )
      assert.match(f.output.join('\n'), /TS6133/)
      assert.equal(f.ready().length, 1, f.output.join('\n'))
      assert.equal(alive(pidOf(first)), true)
      options.compilerOptions.noUnusedLocals = false
      writeFileSync(config, JSON.stringify(options))
      await until(
        () => f.ready().some((line) => line.includes('fixture:one-after:')),
        'valid configuration recovered',
      )
      assert.equal(f.ready().length, 2)
    } finally {
      await f.close()
    }
  },
)

test(
  'source reload recovers after an external build deletes and reconstructs server dist',
  { timeout: 20_000 },
  async () => {
    const f = fixture()
    f.start()
    try {
      const first = await until(() => f.ready()[0], 'external build cold ready')
      rmSync(join(f.cwd, 'dist'), { recursive: true, force: true })
      await delay(80)
      assert.equal(f.ready().length, 1)
      assert.equal(alive(pidOf(first)), true)
      const build = spawn(
        process.execPath,
        [tsc, '-p', 'tsconfig.build.json', '--incremental', 'false'],
        { cwd: f.cwd, stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(10_000) },
      )
      let diagnostics = ''
      build.stdout.on('data', (chunk) => (diagnostics += chunk))
      build.stderr.on('data', (chunk) => (diagnostics += chunk))
      const code = await new Promise((resolve, reject) => {
        build.once('error', reject)
        build.once('exit', resolve)
      })
      assert.equal(code, 0, diagnostics)
      writeFileSync(f.main, f.source('after-build'))
      const restored = await until(
        () => f.ready().find((line) => line.includes('fixture:after-build-initial:')),
        'source reload after external build',
      )
      assert.notEqual(pidOf(restored), pidOf(first))
      assert.equal(alive(pidOf(first)), false)
      await delay(600)
      assert.equal(f.ready().length, 2, f.output.join('\n'))
      assert.doesNotMatch(f.output.join('\n'), /MODULE_NOT_FOUND/)
    } finally {
      await f.close()
    }
  },
)
