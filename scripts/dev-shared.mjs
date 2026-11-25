// 共享包保留 TypeScript 自带的增量 watch；通过 IPC 报告真实编译完成与输入快照。
import { createHash } from 'node:crypto'
import { resolve, sep } from 'node:path'
import ts from 'typescript'

const config = resolve('tsconfig.json')
const source = `${resolve('src')}${sep}`
const callbacks = new Map()
let started = performance.now()
let errors = 0
const send = (value) => process.send?.(value)
const digest = (text) =>
  createHash('sha256')
    .update(text.replace(/^\uFEFF/, ''))
    .digest('hex')
const host = ts.createWatchCompilerHost(
  config,
  { noEmitOnError: true, incremental: true, tsBuildInfoFile: resolve('dist/.dev.tsbuildinfo') },
  ts.sys,
  ts.createEmitAndSemanticDiagnosticsBuilderProgram,
  (diagnostic) => {
    console.error(
      ts
        .formatDiagnostics([diagnostic], {
          getCurrentDirectory: ts.sys.getCurrentDirectory,
          getCanonicalFileName: (name) => name,
          getNewLine: () => ts.sys.newLine,
        })
        .trimEnd(),
    )
  },
  (diagnostic, _newline, _options, errorCount) => {
    if ([6031, 6032].includes(diagnostic.code)) {
      started = performance.now()
      send({ type: 'qw:shared-start' })
    } else if (errorCount !== undefined) errors = errorCount
  },
)

// 保存编译器自己的失效回调：新建文件重读配置，现有文件复用其原生增量路径。
const watchFile = host.watchFile
host.watchFile = (file, callback, ...args) => {
  const key = resolve(file)
  callbacks.set(key, callback)
  const watcher = watchFile(file, callback, ...args)
  return {
    close: () => {
      callbacks.delete(key)
      watcher.close()
    },
  }
}
const compile = host.afterProgramCreate
host.afterProgramCreate = (builder) => {
  errors = 0
  // 原生回调包含语法、类型和写盘诊断，不能只按语义检查成功就宣告产物可用。
  compile(builder)
  const inputs = builder
    .getProgram()
    .getSourceFiles()
    .filter(
      (file) =>
        resolve(file.fileName).startsWith(source) &&
        file.fileName.endsWith('.ts') &&
        !file.fileName.endsWith('.spec.ts'),
    )
    .map((file) => [resolve(file.fileName), digest(file.text)])
  // 配置与源码一样必须取本轮 Program 的输入，不能用 emit 结束后的磁盘配置冒充。
  const actualConfig = builder.getProgram().getCompilerOptions().configFile
  const configuration = [resolve(actualConfig.fileName), digest(actualConfig.text)]
  send({ type: 'qw:shared-done', errors, ms: performance.now() - started, inputs, configuration })
}
const compiler = ts.createWatchProgram(host)
process.on('message', (message) => {
  if (message?.type !== 'qw:invalidate-shared') return
  for (const file of message.files) {
    const callback = callbacks.get(resolve(file))
    if (callback) callback(file, ts.FileWatcherEventKind.Changed)
    else callbacks.get(config)?.(config, ts.FileWatcherEventKind.Changed)
  }
})
const stop = () => {
  compiler.close()
  if (process.connected) process.disconnect()
}
process.once('SIGINT', stop).once('SIGTERM', stop)
