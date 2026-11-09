import { afterEach, expect, it, vi } from 'vitest'
import type { ImOutboxFile } from '@qiwu/shared/im-client'
import { createAppVoiceRecorder, type AppRecorderManager } from '../core/im/voice-recorder'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const file = (path: string): ImOutboxFile => ({
  localRef: path,
  name: 'voice.wav',
  mime: 'audio/wav',
  size: 100,
})
function setup() {
  let started!: () => void,
    stopped!: (value: { tempFilePath: string }) => void,
    errored!: () => void
  const manager: AppRecorderManager = {
    onStart: vi.fn((fn) => {
      started = fn
    }),
    onStop: vi.fn((fn) => {
      stopped = fn
    }),
    onError: vi.fn((fn) => {
      errored = fn
    }),
    start: vi.fn(),
    stop: vi.fn(),
  }
  const permission = vi.fn(async () => true),
    keep = vi.fn(async () => file('_doc/im-outbox/voice.wav')),
    remove = vi.fn(async () => {}),
    state = vi.fn()
  const recorder = createAppVoiceRecorder({ manager, permission, keep, remove, state })
  const onStop = vi.fn(),
    onError = vi.fn(),
    options = { maxSeconds: 60, onStop, onError }
  const begin = async () => {
    const promise = recorder.start(options)
    await flush()
    started()
    await promise
  }
  return {
    recorder,
    manager,
    permission,
    keep,
    remove,
    state,
    options,
    onStop,
    onError,
    begin,
    started: () => started(),
    stopped: (path = '/temp.wav') => stopped({ tempFilePath: path }),
    errored: () => errored(),
  }
}
afterEach(() => vi.useRealTimers())

it('one RecorderManager listener set is retained across recordings and WAV options are explicit', async () => {
  const h = setup()
  await h.begin()
  expect(h.manager.start).toHaveBeenCalledWith({
    duration: 60_000,
    sampleRate: 16000,
    numberOfChannels: 1,
    format: 'wav',
  })
  h.recorder.stop()
  h.stopped()
  await flush()
  expect(h.onStop).toHaveBeenCalledTimes(1)
  expect(h.onStop).toHaveBeenCalledWith(file('_doc/im-outbox/voice.wav'))
  expect(h.remove).toHaveBeenCalledWith('/temp.wav')
  await h.begin()
  h.recorder.cancel()
  h.stopped()
  await flush()
  for (const name of ['onStart', 'onStop', 'onError'] as const)
    expect(h.manager[name]).toHaveBeenCalledTimes(1)
  expect(h.onStop).toHaveBeenCalledTimes(1)
})

it('cancel while permission is pending never starts the old capture after a newer request', async () => {
  const h = setup(),
    oldPermission = deferred<boolean>()
  h.permission.mockReturnValueOnce(oldPermission.promise)
  const old = h.recorder.start(h.options).catch((error: unknown) => error)
  h.recorder.cancel()
  await h.begin()
  oldPermission.resolve(true)
  await flush()
  expect(await old).toEqual({ code: 'CANCELLED', operation: 'record' })
  expect(h.manager.start).toHaveBeenCalledTimes(1)
  expect(h.manager.stop).not.toHaveBeenCalled()
  h.recorder.cancel()
  h.stopped()
  await flush()
})

it('permission rejection is controlled and creates neither a native capture nor a file', async () => {
  const h = setup()
  h.permission.mockResolvedValueOnce(false)
  const denied = h.recorder.start(h.options).catch((error: unknown) => error)
  await flush()
  expect(h.manager.start).not.toHaveBeenCalled()
  expect(await denied).toEqual({ code: 'PERMISSION_DENIED', operation: 'record' })
  expect(h.manager.start).not.toHaveBeenCalled()
  expect(h.keep).not.toHaveBeenCalled()
  expect(h.onError).toHaveBeenCalledWith({ code: 'PERMISSION_DENIED', operation: 'record' })
})

it('a cancelled capture quarantines its slot until stop arrives and never becomes a new recording', async () => {
  const h = setup()
  await h.begin()
  h.recorder.cancel()
  const blocked = h.recorder.start(h.options).catch((error: unknown) => error)
  await flush()
  expect(h.manager.start).toHaveBeenCalledTimes(1)
  expect(await blocked).toEqual({ code: 'BUSY', operation: 'record' })
  const idle = h.recorder.whenIdle()
  h.stopped('/cancelled.wav')
  await idle
  await flush()
  expect(h.keep).not.toHaveBeenCalled()
  expect(h.onStop).not.toHaveBeenCalled()
  expect(h.remove).toHaveBeenCalledWith('/cancelled.wav')
  await h.begin()
  expect(h.manager.start).toHaveBeenCalledTimes(2)
  h.recorder.cancel()
  h.stopped()
  await flush()
})

it('cancel while copying removes only the retired draft and preserves the newer capture', async () => {
  const h = setup(),
    copying = deferred<ImOutboxFile>()
  h.keep.mockReturnValueOnce(copying.promise)
  await h.begin()
  h.stopped('/old-temp.wav')
  await flush()
  h.recorder.cancel()
  await h.begin()
  copying.resolve(file('_doc/im-outbox/old.wav'))
  await flush()
  expect(h.onStop).not.toHaveBeenCalled()
  expect(h.remove).toHaveBeenCalledWith('_doc/im-outbox/old.wav')
  expect(h.state).toHaveBeenLastCalledWith('recording')
  h.recorder.cancel()
  h.stopped()
  await flush()
})

it('a terminal recorder error releases waiters without publishing a voice message', async () => {
  const h = setup()
  await h.begin()
  h.recorder.cancel()
  const idle = h.recorder.whenIdle()
  h.errored()
  await idle
  expect(h.onStop).not.toHaveBeenCalled()
  await h.begin()
  h.recorder.cancel()
  h.stopped()
  await flush()
})

it('failed native stop and a timeout cannot pretend the microphone was released', async () => {
  vi.useFakeTimers()
  const h = setup()
  await h.begin()
  vi.mocked(h.manager.stop).mockImplementation(() => {
    throw new Error('private device detail')
  })
  h.recorder.cancel()
  const idle = h.recorder.whenIdle().catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(3000)
  expect(await idle).toEqual({ code: 'BUSY', operation: 'record' })
  await expect(h.recorder.start(h.options)).rejects.toEqual({ code: 'BUSY', operation: 'record' })
  vi.mocked(h.manager.stop).mockReset()
  h.recorder.cancel()
  h.stopped()
  await flush()
  await h.recorder.whenIdle()
  expect(h.onStop).not.toHaveBeenCalled()
})

it('copy failures discard the temporary file and report a controlled result only once', async () => {
  const h = setup()
  h.keep.mockRejectedValueOnce(new Error('private local path'))
  await h.begin()
  h.stopped()
  await flush()
  h.errored()
  expect(h.onError).toHaveBeenCalledTimes(1)
  expect(h.onError).toHaveBeenCalledWith({ code: 'SDK_ERROR', operation: 'record' })
  expect(h.remove).toHaveBeenCalledWith('/temp.wav')
  expect(h.onStop).not.toHaveBeenCalled()
})
