// One zod for the app and @qiwu/shared (vite.config.ts alias), switched to jitless by the
// first import of main.ts, so no parser ever reaches `new Function` (forbidden on mp-weixin).
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import mainSource from '../main.ts?raw'

it('main.ts imports the jitless switch before anything else', () => {
  expect(mainSource.match(/^import .*$/m)?.[0]).toBe("import './core/jitless'")
})

it('switches the one zod of the app and @qiwu/shared to jitless', async () => {
  expect(z.config().jitless).toBeFalsy()
  await import('@/core/jitless')
  expect(z.config().jitless).toBe(true)
  const { loginBody } = await import('@qiwu/shared')
  // one zod copy (a second one would double it in every bundle); zod 4 keeps its config on globalThis and
  // answers instanceof by traits across copies, so only the constructor tells them apart
  expect(loginBody.constructor).toBe(z.ZodObject)
  vi.stubGlobal('Function', () => {
    throw new Error('eval is blocked')
  })
  try {
    expect(z.object({ a: z.string() }).safeParse({ a: 'x' }).success).toBe(true)
    expect(loginBody.safeParse({ username: 'a', password: 'b' }).success).toBe(true)
  } finally {
    vi.unstubAllGlobals()
  }
})
