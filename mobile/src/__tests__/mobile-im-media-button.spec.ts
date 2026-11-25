import { expect, it, vi } from 'vitest'
import { activateImMediaButton } from '../core/im/media-button'

it.each(['Enter', ' '])(
  'activates an enabled media button once with %s and prevents scrolling or duplicate native activation',
  (key) => {
    const action = vi.fn<() => void>(),
      preventDefault = vi.fn<() => void>()
    activateImMediaButton({ key, preventDefault }, false, action)
    expect(action).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    activateImMediaButton({ key, repeat: true, preventDefault }, false, action)
    activateImMediaButton({ key, preventDefault }, true, action)
    expect(action).toHaveBeenCalledTimes(1)
  },
)

it('leaves other keys and an already handled event to their original owner', () => {
  const action = vi.fn<() => void>(),
    preventDefault = vi.fn<() => void>()
  for (const key of ['Tab', 'Escape', 'ArrowDown', 'a'])
    activateImMediaButton({ key, preventDefault }, false, action)
  activateImMediaButton({ key: 'Enter', defaultPrevented: true, preventDefault }, false, action)
  expect(action).not.toHaveBeenCalled()
  expect(preventDefault).not.toHaveBeenCalled()
})

it('reuses the action pending guard and returns its promise to the existing event error handler', async () => {
  let pending = false
  const result = Promise.resolve('done')
  const action = vi.fn<() => Promise<string>>(() => {
    pending = true
    return result
  })
  expect(activateImMediaButton({ key: 'Enter' }, pending, action)).toBe(result)
  activateImMediaButton({ key: ' ' }, pending, action)
  expect(action).toHaveBeenCalledTimes(1)
  await expect(result).resolves.toBe('done')
})
