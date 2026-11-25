import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { canWriteImCall, imCallApi } from '../core/im/call-api'
const state = vi.hoisted(() => ({
  leader: false,
  post: vi.fn<() => Promise<object>>(async () => ({})),
}))
vi.mock('../core/request', () => ({ api: { post: state.post, get: vi.fn<() => void>() } }))
vi.mock('../core/im/client', () => ({ imCurrent: () => state }))
beforeEach(() => {
  vi.stubEnv('UNI_PLATFORM', 'h5')
  vi.stubGlobal('navigator', { locks: {} })
  state.leader = false
  state.post.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
const writes = [
  () => imCallApi.create(10, { clientCallId: 'draft', mode: 'audio' }),
  () => imCallApi.accept(1),
  () => imCallApi.decline(1),
  () => imCallApi.join(1),
  () => imCallApi.leave(1),
  () => imCallApi.end(1),
  () => imCallApi.heartbeat(1),
]
it.each(writes.map((action, index) => ({ action, index })))(
  'guards write operation $index after ownership changes',
  async ({ action }) => {
    await expect(action()).rejects.toEqual({ code: 'NOT_LEADER', operation: 'call' })
    expect(state.post).not.toHaveBeenCalled()
    state.leader = true
    await action()
    expect(state.post).toHaveBeenCalledTimes(1)
    state.leader = false
    await expect(action()).rejects.toEqual({ code: 'NOT_LEADER', operation: 'call' })
    expect(state.post).toHaveBeenCalledTimes(1)
  },
)
it('requires Web Locks even if an old H5 context still marks itself as leader', () => {
  state.leader = true
  vi.stubGlobal('navigator', {})
  expect(canWriteImCall()).toBe(false)
})
