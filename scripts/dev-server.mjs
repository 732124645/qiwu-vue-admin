// 后端只在一轮编译成功并完成写盘后重启，避免监听 dist 把半份产物当作新版本。
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync, watch } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('../apps/server/', import.meta.url))

/** 让开发者看到本轮耗时和上一成功轮的差值，首次不虚构基准。 */
export function duration(ms, previous) {
  const value = `${Math.round(ms)} ms`
  if (previous === undefined) return value
  const delta = Math.round(ms - previous)
  return `${value} (${delta >= 0 ? '+' : ''}${delta} ms vs previous)`
}

/** 只给实际应用打开调试端口，编译器与前端不会抢占同一端口。 */
export function inspectorArgs(flag = '') {
  const port = Number(flag)
  const inspectPort = ['1', 'true'].includes(flag)
    ? 9229
    : Number.isInteger(port) && port >= 1024 && port <= 65535
      ? port
      : undefined
  if (flag && inspectPort === undefined && !['0', 'false'].includes(flag))
    console.warn(`QW_INSPECT=${flag} ignored: use 1, true or a port from 1024 to 65535`)
  return inspectPort === undefined
    ? []
    : [`--inspect=127.0.0.1:${inspectPort}`, '--enable-source-maps']
}

/** 统一协调共享编译、后端增量编译和应用重启，只有成功且输入仍匹配的产物可启动。 */
export function runDevServer({
  cwd = serverDir,
  sharedCwd = resolve(cwd, '../../packages/shared'),
  compiler = [
    'node_modules/typescript/bin/tsc',
    '-p',
    'tsconfig.build.json',
    '--pretty',
    'false',
    '--noEmitOnError',
  ],
  sharedCompiler = [fileURLToPath(new URL('./dev-shared.mjs', import.meta.url))],
  entry = 'dist/main.js',
  env = process.env,
  write = (line) => console.log(line),
  inspect = inspectorArgs(env.QW_INSPECT),
} = {}) {
  const runnerStarted = performance.now()
  // macOS 临时目录等路径可能含符号链接，需与编译器的真实路径使用同一输入键。
  cwd = realpathSync(cwd)
  sharedCwd = realpathSync(sharedCwd)
  let app,
    serverCompiler,
    sharedProcess,
    restarting = false,
    stopped = false
  let sharedBusy = true,
    sharedDirty = true,
    sharedFailed = false,
    sharedConfigDirty = false
  let serverDirty = true,
    serverFailed = false,
    serverRevision = 0,
    generation = 0,
    applied = -1
  let firstChange,
    serverMs,
    sharedMs,
    previousServer,
    previousShared,
    previousTotal,
    completed = false
  let sharedSignature, stopping
  const changed = new Set()
  const pendingShared = new Map()
  const seen = new Map()
  const watchers = []
  const children = new Set()
  const readers = new Set()
  const root = resolve(cwd, '../..')

  /** 使用与 TypeScript SourceFile.text 相同的文本归一化，忽略同内容的重复文件事件。 */
  function fingerprint(file) {
    try {
      return createHash('sha256')
        .update(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
        .digest('hex')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
  function invalidShared(files) {
    if (sharedProcess?.connected) sharedProcess.send({ type: 'qw:invalidate-shared', files })
  }
  function failureState() {
    return !restarting && app?.pid && app.exitCode === null && app.signalCode === null
      ? 'keeping the previous process'
      : 'waiting for a successful build'
  }
  /** 完整读取诊断；进程退出不是编译成功，必须检查其最终退出码。 */
  function child(args, directory, ipc = false) {
    const processChild = spawn(process.execPath, args, {
      cwd: directory,
      env,
      stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
    })
    children.add(processChild)
    for (const stream of [processChild.stdout, processChild.stderr]) {
      const reader = createInterface({ input: stream })
      readers.add(reader)
      reader.on('line', (line) => {
        if (line.trim()) write(line)
      })
      reader.once('close', () => readers.delete(reader))
    }
    processChild.once('close', () => children.delete(processChild))
    return processChild
  }
  /** 旧应用先释放连接和端口，退出卡住也有明确上限。 */
  async function terminate(processChild) {
    if (!processChild?.pid || processChild.exitCode !== null || processChild.signalCode !== null)
      return
    await new Promise((done) => {
      const force = setTimeout(() => processChild.kill('SIGKILL'), 5000)
      processChild.once('exit', () => {
        clearTimeout(force)
        done()
      })
      processChild.kill('SIGTERM')
    })
  }
  /** 不猜测另一个 watcher 何时看到声明变化：共享成功后显式串行运行后端增量编译。 */
  function compileServer() {
    const revision = serverRevision
    const started = performance.now()
    serverDirty = false
    serverFailed = false
    const processChild = (serverCompiler = child(compiler, cwd))
    let finished = false
    const finish = (code) => {
      if (finished) return
      finished = true
      serverCompiler = undefined
      serverMs = performance.now() - started
      if (stopped) return
      serverFailed = code !== 0
      if (serverFailed)
        write(`[server] compile failed: exit ${code}, ${duration(serverMs)}; ${failureState()}`)
      if (revision !== serverRevision) serverDirty = true
      progress()
    }
    processChild.once('error', (error) => {
      write(`[server] compiler failed to start: ${error.message}`)
      finish(1)
    })
    processChild.once('close', (code) => finish(code ?? 1))
  }
  /** 每个源码代次只启动一次；编译期间的新变化先补编译，不运行混合代次。 */
  function progress() {
    if (stopped || sharedBusy || sharedDirty || sharedFailed) return
    if (serverDirty && !serverCompiler) {
      compileServer()
      return
    }
    if (serverCompiler || serverFailed || restarting || applied === generation) return
    void restart()
  }
  async function restart() {
    restarting = true
    const started = performance.now()
    const since = completed ? (firstChange ?? started) : runnerStarted
    write(
      `[server] ${changed.size ? `changed ${changed.size} file(s): ${[...changed].sort().join(', ')}` : 'initial build'}; restarting…`,
    )
    await terminate(app)
    // 停旧期间也允许编译继续；未完成或失败时等下一份稳定产物，成功时直接消费最新代次。
    if (
      stopped ||
      sharedBusy ||
      sharedDirty ||
      sharedFailed ||
      serverDirty ||
      serverCompiler ||
      serverFailed
    ) {
      restarting = false
      progress()
      return
    }
    const launch = generation
    const cold = !completed
    const thisServer = serverMs,
      thisShared = sharedMs
    applied = launch
    changed.clear()
    firstChange = undefined
    serverMs = sharedMs = undefined
    const processChild = (app = spawn(process.execPath, [...inspect, entry], {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { I18N_DIR: 'src/i18n', CODEGEN_TEMPLATES: 'codegen-templates', ...env, QW_DEV: '1' },
    }))
    let ready = false
    const timeout = setTimeout(() => {
      if (!ready && app === processChild && !stopped)
        write('[server] startup is still pending after 30 s; see warnings/errors above')
    }, 30_000)
    processChild.on('message', (message) => {
      if (
        message?.type !== 'qw:dev-ready' ||
        ready ||
        app !== processChild ||
        stopped ||
        launch !== generation
      )
        return
      ready = true
      clearTimeout(timeout)
      const total = performance.now() - since
      const timing = (value, previous) =>
        value === undefined ? 'not required' : duration(value, cold ? undefined : previous)
      write(
        `[server] ${cold ? 'cold start' : 'reload'} ready ${message.url} | shared compile ${timing(thisShared, previousShared)} | server compile ${timing(thisServer, previousServer)} | restart ${duration(performance.now() - started)} | total ${duration(total, cold ? undefined : previousTotal)}`,
      )
      if (!cold) {
        if (thisServer !== undefined) previousServer = thisServer
        if (thisShared !== undefined) previousShared = thisShared
        previousTotal = total
      }
      completed = true
    })
    processChild.once('error', (error) => {
      clearTimeout(timeout)
      write(`[server] failed to start: ${error.message}`)
    })
    processChild.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (!stopped && app === processChild && !restarting)
        write(`[server] exited (${signal ?? code}); waiting for a successful change`)
    })
    restarting = false
    progress()
  }

  /** 监听实际输入而非 dist 写盘；shared 一有变化就置脏，不等其延迟的编译开始事件。 */
  function input(file, kind) {
    const hash = fingerprint(file)
    if (seen.get(file) === hash) return
    seen.set(file, hash)
    changed.add(relative(root, file).split('\\').join('/'))
    firstChange ??= performance.now()
    generation++
    if (kind === 'shared') {
      pendingShared.set(file, hash)
      sharedDirty = true
      invalidShared([file])
    } else if (kind === 'shared-config') {
      sharedConfigDirty = sharedDirty = true
      invalidShared([file])
    } else if (kind === 'server') {
      serverRevision++
      serverDirty = true
    }
    progress()
  }
  const roots = [
    [resolve(cwd, 'src'), 'server'],
    [resolve(sharedCwd, 'src'), 'shared'],
  ]
  try {
    for (const [dir, kind] of roots) {
      for (const name of readdirSync(dir, { recursive: true })) {
        const file = resolve(dir, String(name))
        if (/\.(ts|json)$/.test(file)) seen.set(file, fingerprint(file))
      }
      const watcher = watch(dir, { recursive: true }, (_event, name) => {
        if (!name) return
        const file = resolve(dir, String(name))
        if (file.endsWith('spec.ts')) return
        const locale = /[\\/]i18n[\\/].+\.json$/.test(file)
        if (!file.endsWith('.ts') && !locale) return
        try {
          input(file, locale ? 'locale' : kind)
        } catch (error) {
          write(`[server] watcher failed: ${error.message}`)
          void stop(1)
        }
      })
      watcher.on('error', (error) => {
        write(`[server] watcher failed: ${error.message}`)
        void stop(1)
      })
      watchers.push(watcher)
    }
    // 监听配置的父目录，编辑器原子替换配置文件后仍能继续收到下一次保存。
    for (const [dir, files] of [
      [
        cwd,
        new Map([
          ['tsconfig.json', 'server'],
          ['tsconfig.build.json', 'server'],
        ]),
      ],
      [sharedCwd, new Map([['tsconfig.json', 'shared-config']])],
    ]) {
      for (const file of files.keys()) seen.set(resolve(dir, file), fingerprint(resolve(dir, file)))
      const watcher = watch(dir, (_event, name) => {
        const kind = files.get(String(name))
        if (!kind) return
        try {
          input(resolve(dir, String(name)), kind)
        } catch (error) {
          write(error.message)
          void stop(1)
        }
      })
      watcher.on('error', (error) => {
        write(error.message)
        void stop(1)
      })
      watchers.push(watcher)
    }
    sharedProcess = child(sharedCompiler, sharedCwd, true)
  } catch (error) {
    watchers.forEach((watcher) => watcher.close())
    throw error
  }

  sharedProcess.on('message', (message) => {
    if (stopped) return
    if (message?.type === 'qw:shared-start') sharedBusy = true
    if (message?.type !== 'qw:shared-done') return
    sharedBusy = false
    sharedFailed = message.errors > 0
    if (sharedFailed) {
      write(
        `[shared] compile failed: ${message.errors} error(s), ${duration(message.ms)}; ${failureState()}`,
      )
      return
    }
    // 旧轮次 emit 时配置也可能变化，必须先等待编译器使用当前配置完成下一轮。
    if (fingerprint(message.configuration[0]) !== message.configuration[1]) {
      sharedConfigDirty = sharedDirty = true
      invalidShared([message.configuration[0]])
      return
    }
    const inputs = new Map(message.inputs)
    // 即使文件事件尚未到达，也不能接受与磁盘当前输入不一致的编译快照。
    for (const file of new Set([...inputs.keys(), ...pendingShared.keys()])) {
      const actual = fingerprint(file)
      if ((inputs.get(file) ?? null) === actual) pendingShared.delete(file)
      else pendingShared.set(file, actual)
    }
    sharedDirty = pendingShared.size > 0
    if (sharedDirty) {
      invalidShared([...pendingShared.keys()])
      return
    }
    const signature = JSON.stringify([
      message.configuration,
      ...[...inputs].sort(([a], [b]) => a.localeCompare(b)),
    ])
    if (sharedSignature !== signature || sharedConfigDirty) {
      sharedSignature = signature
      sharedConfigDirty = false
      sharedMs = message.ms
      generation++
      serverRevision++
      serverDirty = true
    }
    progress()
  })
  sharedProcess.once('error', (error) => {
    write(`[shared] compiler failed to start: ${error.message}`)
    void stop(1)
  })
  sharedProcess.once('exit', (code, signal) => {
    if (!stopped) {
      write(`[shared] compiler exited (${signal ?? code})`)
      void stop(code || 1)
    }
  })
  /** 关闭监听和所有编译器、应用；重复 stop 调用等待同一份清理结果。 */
  function stop(code = 0) {
    if (stopping) return stopping
    stopped = true
    watchers.forEach((watcher) => watcher.close())
    readers.forEach((reader) => reader.close())
    stopping = Promise.all([...children, app].map(terminate)).then(() => {
      process.exitCode = code
      process.off('SIGINT', onSignal).off('SIGTERM', onSignal)
    })
    return stopping
  }
  const onSignal = () => void stop()
  process.once('SIGINT', onSignal).once('SIGTERM', onSignal)
  return { stop, compilerPid: sharedProcess.pid }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runDevServer()
