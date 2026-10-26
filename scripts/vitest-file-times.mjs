// Vitest reporter for ci:local's server step: writes every test file's wall time
// (import, setup files, hooks and tests: what the json reporter's per-file times leave out but
// beforeAll boots of the whole AppModule cost) to $QW_FILE_TIMES as JSON [[file, ms], …], slowest first.
import { writeFileSync } from 'node:fs'
import { relative } from 'node:path'

export default class FileTimes {
  /** 失败立即留堆栈，避免后续文件卡住或运行被中断后丢失最初原因；成功保持安静。 */
  onTestCaseResult(test) {
    const result = test.result()
    if (result.state !== 'failed') return
    const errors = result.errors ?? []
    process.stderr.write(
      `\nTest failed: ${test.module.moduleId} > ${test.fullName}\n${errors.map((error) => error.stack ?? error.message).join('\n')}\n`,
    )
  }

  onTestRunEnd(modules) {
    const times = modules.map((m) => {
      const d = m.diagnostic()
      return [
        relative(process.cwd(), m.moduleId),
        Math.round(d.collectDuration + d.setupDuration + d.duration),
      ]
    })
    writeFileSync(process.env.QW_FILE_TIMES, JSON.stringify(times.sort((a, b) => b[1] - a[1])))
  }
}
