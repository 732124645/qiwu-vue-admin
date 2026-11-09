import Recorder from 'recorder-core'
import 'recorder-core/src/engine/wav.js'
import type { ImOutboxFile } from '../client/cache.js'
import { ImMediaError, type ImMediaFailure } from './types.js'

interface RecorderInstance {
  open(success: () => void, failure: (message: string, denied?: boolean) => void): void
  start(): void
  stop(success: (blob: Blob, duration: number) => void, failure: () => void): void
  close(): void
}
interface RecorderFactory {
  (options: { type: 'wav'; sampleRate: number; bitRate: number }): RecorderInstance
  CLog: (...args: unknown[]) => void
  ConnectEnableWorklet: boolean
}
const factory = Recorder as unknown as RecorderFactory
// 录音库共用底层麦克风；旧授权尚未返回时不能让另一个实例先取得同一条流。
let owner: RecorderInstance | null = null
export interface ImVoiceRecorderOptions {
  maxSeconds: number
  onStop(file: ImOutboxFile): void
  onError(failure: ImMediaFailure): void
}

interface VoiceOperation {
  recorder: RecorderInstance
  generation: number
  options: ImVoiceRecorderOptions
  ready: boolean
  stopping: boolean
  closed: boolean
  timer?: ReturnType<typeof setTimeout>
  reject?: (error: ImMediaError) => void
}

/** 复用成熟 WAV 编码；正文随 outbox 持久化，页面离开会退役未返回的权限/编码回调。 */
export function createBrowserVoiceRecorder() {
  let generation = 0
  let active: VoiceOperation | null = null
  function close(operation: VoiceOperation) {
    if (operation.closed) return
    const recorder = operation.recorder
    try {
      recorder.close()
      operation.closed = true
      if (owner === recorder) owner = null
    } catch {
      /* 未确认释放时保持麦克风占用，不启动新录音。 */
    }
  }
  function cancel() {
    generation++
    const operation = active
    active = null
    if (!operation) return
    clearTimeout(operation.timer)
    operation.reject?.(new ImMediaError('CANCELLED', 'record'))
    // getUserMedia 无法取消；未返回的 open 回调会在真正返回后关闭，而不是关闭后来实例。
    if (operation.ready) close(operation)
  }
  function stop() {
    const operation = active
    if (!operation?.ready || operation.stopping) return
    operation.stopping = true
    clearTimeout(operation.timer)
    const { recorder, options } = operation
    const finish = () => {
      close(operation)
      if (active === operation) active = null
    }
    try {
      recorder.stop(
        (blob) => {
          const current = active === operation && generation === operation.generation
          finish()
          if (!current) return
          if (!blob.size) {
            options.onError({ code: 'SDK_ERROR', operation: 'record' })
            return
          }
          options.onStop({
            name: 'voice.wav',
            size: blob.size,
            mime: 'audio/wav',
            localRef: `v:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`,
            body: blob,
          })
        },
        () => {
          const current = active === operation && generation === operation.generation
          finish()
          if (current) options.onError({ code: 'SDK_ERROR', operation: 'record' })
        },
      )
    } catch {
      const current = active === operation && generation === operation.generation
      finish()
      if (current) options.onError({ code: 'SDK_ERROR', operation: 'record' })
    }
  }
  async function start(options: ImVoiceRecorderOptions): Promise<void> {
    if (active || owner) throw new ImMediaError('BUSY', 'record')
    if (
      !globalThis.navigator?.mediaDevices?.getUserMedia ||
      typeof AudioContext === 'undefined' ||
      !AudioContext.prototype.createScriptProcessor
    )
      throw new ImMediaError('UNSUPPORTED', 'record')
    factory.CLog = () => undefined
    factory.ConnectEnableWorklet = false
    const recorder = factory({ type: 'wav', sampleRate: 16000, bitRate: 16 })
    owner = recorder
    const operation = {
      recorder,
      generation: ++generation,
      options,
      ready: false,
      stopping: false,
      closed: false,
    } as VoiceOperation
    active = operation
    return new Promise<void>((resolve, reject) => {
      operation.reject = reject
      try {
        recorder.open(
          () => {
            if (active !== operation || generation !== operation.generation) {
              close(operation)
              reject(new ImMediaError('CANCELLED', 'record'))
              return
            }
            try {
              recorder.start()
              operation.ready = true
              operation.reject = undefined
              operation.timer = setTimeout(
                stop,
                Math.max(1, Math.min(options.maxSeconds, 300)) * 1000,
              )
              resolve()
            } catch {
              active = null
              close(operation)
              reject(new ImMediaError('SDK_ERROR', 'record'))
            }
          },
          (_message, denied) => {
            if (active === operation) active = null
            close(operation)
            reject(new ImMediaError(denied ? 'PERMISSION_DENIED' : 'SDK_ERROR', 'record'))
          },
        )
      } catch {
        active = null
        close(operation)
        reject(new ImMediaError('SDK_ERROR', 'record'))
      }
    })
  }
  return { start, stop, cancel }
}
