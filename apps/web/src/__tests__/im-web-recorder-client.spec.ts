import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImVoiceRecorderOptions } from '@qiwu/shared/im-media'
import { createBrowserVoiceRecorder } from '../../../../packages/shared/src/platform/im/media/voice.js'

interface RecorderFake {
  opened: (() => void) | null
  rejected: ((message: string, denied?: boolean) => void) | null
  stopped: ((blob: Blob, duration: number) => void) | null
  closes: number
  starts: number
}
const sdk = vi.hoisted(() => ({ records: [] as RecorderFake[] }))
// 编码器由上游独立覆盖，这里只替换设备与编码回调，不执行它的全局插件注册。
vi.mock('../../../../packages/shared/node_modules/recorder-core/src/engine/wav.js', () => ({}))
vi.mock('../../../../packages/shared/node_modules/recorder-core/src/recorder-core.js', () => ({
  default: () => {
    const state: RecorderFake = {
      opened: null,
      rejected: null,
      stopped: null,
      closes: 0,
      starts: 0,
    }
    sdk.records.push(state)
    return {
      open: (ok: () => void, fail: (message: string, denied?: boolean) => void) => {
        state.opened = ok
        state.rejected = fail
      },
      start: () => {
        state.starts++
      },
      close: () => {
        state.closes++
      },
      stop: (ok: (blob: Blob, duration: number) => void) => {
        state.stopped = ok
      },
    }
  },
}))
const ports: ReturnType<typeof createBrowserVoiceRecorder>[] = []
const port = () => {
  const value = createBrowserVoiceRecorder()
  ports.push(value)
  return value
}
beforeEach(() => {
  sdk.records = []
  vi.useFakeTimers()
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => undefined } })
  vi.stubGlobal(
    'AudioContext',
    class {
      createScriptProcessor() {}
    },
  )
})
afterEach(() => {
  for (const recorder of ports.splice(0)) recorder.cancel()
  for (const recorder of sdk.records) recorder.opened?.()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const callbacks = () => ({
  maxSeconds: 60,
  onStop: vi.fn<ImVoiceRecorderOptions['onStop']>(),
  onError: vi.fn<ImVoiceRecorderOptions['onError']>(),
})

describe('voice recorder permissions and lifecycle', () => {
  it('does not start capture after cancellation and waits for the old permission to retire before another recorder', async () => {
    const first = port(),
      second = port(),
      options = callbacks()
    const opening = first.start(options),
      cancelled = opening.catch((error: unknown) => error)
    first.cancel()
    await expect(cancelled).resolves.toMatchObject({ code: 'CANCELLED' })
    const blocked = second.start(callbacks()).catch((error: unknown) => error)
    expect(sdk.records).toHaveLength(1)
    await expect(blocked).resolves.toMatchObject({ code: 'BUSY' })
    sdk.records[0]!.opened?.()
    expect(sdk.records[0]!.starts).toBe(0)
    expect(sdk.records[0]!.closes).toBe(1)
    const ready = second.start(callbacks())
    sdk.records[1]!.opened?.()
    await ready
    expect(sdk.records[1]!.starts).toBe(1)
    expect(options.onStop).not.toHaveBeenCalled()
  })
  it('returns a persistable Blob once and cannot close a later microphone on duplicate SDK callbacks', async () => {
    const first = port(),
      second = port(),
      options = callbacks()
    const ready = first.start(options)
    sdk.records[0]!.opened?.()
    await ready
    first.stop()
    const blob = new Blob(['recorded audio'], { type: 'audio/wav' })
    sdk.records[0]!.stopped?.(blob, 1000)
    expect(options.onStop).toHaveBeenCalledTimes(1)
    const file = options.onStop.mock.calls[0]![0]
    expect(file.body).toBe(blob)
    expect(file.localRef).toMatch(/^v:/)
    expect(file.localRef).not.toMatch(/^blob:/)
    const secondReady = second.start(callbacks())
    sdk.records[1]!.opened?.()
    await secondReady
    sdk.records[0]!.stopped?.(blob, 1000)
    expect(options.onStop).toHaveBeenCalledTimes(1)
    expect(sdk.records[0]!.closes).toBe(1)
    expect(sdk.records[1]!.closes).toBe(0)
  })
  it('turns raw permission failures into a controlled result without keeping the microphone occupied', async () => {
    const recorder = port(),
      options = callbacks()
    const ready = recorder.start(options),
      rejected = ready.catch((error: unknown) => error)
    sdk.records[0]!.rejected?.('private implementation details', true)
    await expect(rejected).resolves.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: 'PERMISSION_DENIED',
    })
    expect(sdk.records[0]!.closes).toBe(1)
    const again = recorder.start(options)
    sdk.records[1]!.opened?.()
    await again
    expect(sdk.records[1]!.starts).toBe(1)
  })
  it('stops at the configured limit and discards encoded content after cancellation', async () => {
    const recorder = port(),
      options = { ...callbacks(), maxSeconds: 2 }
    const ready = recorder.start(options)
    sdk.records[0]!.opened?.()
    await ready
    await vi.advanceTimersByTimeAsync(2000)
    expect(sdk.records[0]!.stopped).not.toBeNull()
    recorder.cancel()
    sdk.records[0]!.stopped?.(new Blob(['discarded']), 2000)
    expect(options.onStop).not.toHaveBeenCalled()
    expect(options.onError).not.toHaveBeenCalled()
    expect(sdk.records[0]!.closes).toBe(1)
  })
})

it('rejects an empty encoded recording before creating an outbox file', async () => {
  const recorder = port(),
    options = callbacks()
  const ready = recorder.start(options)
  sdk.records[0]!.opened?.()
  await ready
  recorder.stop()
  sdk.records[0]!.stopped?.(new Blob([]), 0)
  expect(options.onStop).not.toHaveBeenCalled()
  expect(options.onError).toHaveBeenCalledWith({ code: 'SDK_ERROR', operation: 'record' })
})
