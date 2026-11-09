import type { ImOutboxFile } from '@qiwu/shared/im-client'
import type { ImMediaFailure, ImVoiceRecorderOptions } from '@qiwu/shared/im-media'

export type AppVoiceState = 'idle' | 'requesting' | 'recording' | 'saving' | 'stopping'
/** 只替换平台端口，生产始终使用同一份全局 RecorderManager。 */
export interface AppRecorderManager {
  onStart(callback: () => void): void
  onStop(callback: (result: { tempFilePath: string }) => void): void
  onError(callback: () => void): void
  start(options: { duration: number; sampleRate: 16000; numberOfChannels: 1; format: 'wav' }): void
  stop(): void
}

interface Attempt {
  generation: number
  options: ImVoiceRecorderOptions
  captureIssued: boolean
  cancelled: boolean
  stopping: boolean
  resolve?: () => void
  reject?: (error: ImMediaFailure) => void
}
const failure = (code: string): ImMediaFailure => ({ code, operation: 'record' })

/**
 * App 录音监听只注册一套；旧采集终局未返回前不复用槽位，迟到 stop/error 才不会归到下一条录音。
 * 授权先于 start，取消授权等待时从未启动采集。
 */
export function createAppVoiceRecorder(host: {
  manager: AppRecorderManager
  permission(): Promise<boolean>
  keep(path: string): Promise<ImOutboxFile>
  remove(path: string): Promise<void>
  state?(state: AppVoiceState): void
}) {
  let generation = 0
  let active: Attempt | null = null
  const idleWaiters = new Set<{ resolve(): void; reject(error: ImMediaFailure): void }>()
  const alive = (operation: Attempt) =>
    active === operation && !operation.cancelled && operation.generation === generation
  const changed = (state: AppVoiceState) => host.state?.(state)
  const releaseWaiters = () => {
    if (active?.captureIssued) return
    for (const waiter of idleWaiters) waiter.resolve()
    idleWaiters.clear()
  }
  const remove = (path: string) => {
    if (path) void host.remove(path).catch(() => {})
  }
  function report(operation: Attempt, code: string) {
    operation.reject?.(failure(code))
    operation.reject = undefined
    operation.resolve = undefined
    if (alive(operation)) operation.options.onError(failure(code))
  }
  host.manager.onStart(() => {
    const operation = active
    if (!operation?.captureIssued || !alive(operation)) return
    operation.resolve?.()
    operation.resolve = undefined
    operation.reject = undefined
    changed('recording')
  })
  host.manager.onStop(({ tempFilePath }) => {
    const operation = active
    if (!operation?.captureIssued) {
      remove(tempFilePath)
      return
    }
    operation.captureIssued = false
    operation.resolve?.()
    operation.resolve = undefined
    operation.reject = undefined
    releaseWaiters()
    if (!alive(operation)) {
      active = null
      remove(tempFilePath)
      changed('idle')
      return
    }
    changed('saving')
    void (async () => {
      let file: ImOutboxFile | undefined
      try {
        file = await host.keep(tempFilePath)
        if (!alive(operation)) {
          remove(file.localRef)
          return
        }
        if (!Number.isSafeInteger(file.size) || file.size <= 0) throw failure('SDK_ERROR')
        active = null
        operation.options.onStop(file)
      } catch (error) {
        if (file) remove(file.localRef)
        if (alive(operation)) {
          report(
            operation,
            (error as ImMediaFailure | null)?.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'SDK_ERROR',
          )
          active = null
        }
      } finally {
        remove(tempFilePath)
        if (!active && generation === operation.generation) changed('idle')
        releaseWaiters()
      }
    })()
  })
  host.manager.onError(() => {
    const operation = active
    if (!operation?.captureIssued) return
    operation.captureIssued = false
    if (alive(operation)) report(operation, 'SDK_ERROR')
    active = null
    changed('idle')
    releaseWaiters()
  })

  /** 用户已授权并且代次仍活跃时才发起真正的系统录音。 */
  function start(options: ImVoiceRecorderOptions): Promise<void> {
    if (active) return Promise.reject(failure('BUSY'))
    const seconds = Math.max(
      1,
      Math.min(Number.isSafeInteger(options.maxSeconds) ? options.maxSeconds : 60, 300),
    )
    const operation: Attempt = {
      generation: ++generation,
      options,
      captureIssued: false,
      cancelled: false,
      stopping: false,
    }
    active = operation
    changed('requesting')
    return new Promise<void>((resolve, reject) => {
      operation.resolve = resolve
      operation.reject = reject
      void (async () => {
        try {
          const granted = await host.permission()
          if (!alive(operation)) return
          if (!granted) {
            report(operation, 'PERMISSION_DENIED')
            active = null
            changed('idle')
            releaseWaiters()
            return
          }
          operation.captureIssued = true
          host.manager.start({
            duration: seconds * 1000,
            sampleRate: 16000,
            numberOfChannels: 1,
            format: 'wav',
          })
        } catch {
          if (!alive(operation)) return
          report(operation, 'SDK_ERROR')
          operation.cancelled = true
          generation++
          // start 抛出不能证明底层没有打开设备，仍请求 stop 并等终局确认。
          if (operation.captureIssued) requestStop(operation)
          else {
            active = null
            changed('idle')
            releaseWaiters()
          }
        }
      })()
    })
  }
  function requestStop(operation: Attempt) {
    if (!operation.captureIssued || operation.stopping) return
    operation.stopping = true
    changed('stopping')
    try {
      host.manager.stop()
    } catch {
      operation.stopping = false
      for (const waiter of idleWaiters) waiter.reject(failure('SDK_ERROR'))
      idleWaiters.clear()
      if (alive(operation)) operation.options.onError(failure('SDK_ERROR'))
      operation.cancelled = true
      generation++
    }
  }
  /** 正常结束会保留一条结果；取消/切后台会退役结果并仅停止自己的采集。 */
  function stop() {
    if (active && alive(active)) requestStop(active)
  }
  function cancel() {
    generation++
    const operation = active
    if (!operation) return
    operation.cancelled = true
    operation.reject?.(failure('CANCELLED'))
    operation.reject = undefined
    operation.resolve = undefined
    if (operation.captureIssued) requestStop(operation)
    else {
      active = null
      changed('idle')
      releaseWaiters()
    }
  }
  /** 通话等待旧录音停止，超时不释放采集槽，避免把未确认关闭当成空闲。 */
  function whenIdle(): Promise<void> {
    if (!active?.captureIssued) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (error: ImMediaFailure) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      const timer = setTimeout(() => {
        idleWaiters.delete(waiter)
        reject(failure('BUSY'))
      }, 3000)
      idleWaiters.add(waiter)
    })
  }
  return { start, stop, cancel, whenIdle }
}
