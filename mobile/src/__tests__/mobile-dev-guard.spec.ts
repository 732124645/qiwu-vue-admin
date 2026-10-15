// The H5 dev server and preview guard (vite.config.ts): foreign hosts, cross-site requests and foreign
// origins are refused, on plain requests and on socket upgrades (HMR, the proxied realtime socket).
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { devGuard, foreignRequest } from '../../vite.config'

it('refuses another host, a cross-site request or a foreign origin; more hosts only by the list', () => {
  expect(foreignRequest({ host: 'localhost:5173' })).toBe(false)
  expect(foreignRequest({ host: '192.168.1.5:5173', origin: 'http://192.168.1.5:5173' })).toBe(
    false,
  )
  expect(foreignRequest({ host: 'evil.example' })).toBe(true)
  expect(foreignRequest({ host: 'localhost:5173', origin: 'https://evil.example' })).toBe(true)
  expect(foreignRequest({ host: 'localhost:5173', 'sec-fetch-site': 'cross-site' })).toBe(true)
  const phone = { host: 'phone.local:5173', origin: 'http://phone.local:5173' }
  expect(foreignRequest(phone)).toBe(true)
  expect(foreignRequest(phone, ['phone.local'])).toBe(false)
  expect(foreignRequest({ ...phone, origin: 'http://evil.example' }, ['phone.local'])).toBe(true)
})

it('the dev server and the preview answer a foreign request 403 and drop its socket upgrade before Vite sees it', () => {
  for (const hook of ['configureServer', 'configurePreviewServer'] as const) {
    const httpServer = new EventEmitter()
    const vite = vi.fn()
    httpServer.on('upgrade', vite)
    let handler: (req: unknown, res: unknown, next: () => void) => void = () => {}
    const middlewares = { use: (fn: typeof handler) => (handler = fn) }
    ;(devGuard[hook] as (server: unknown) => void)({ middlewares, httpServer })

    const res = { statusCode: 200, end: vi.fn() }
    const next = vi.fn()
    handler({ headers: { host: 'evil.example' } }, res, next)
    expect([res.statusCode, next.mock.calls.length]).toEqual([403, 0])
    handler({ headers: { host: 'localhost:5173' } }, res, next)
    expect(next).toHaveBeenCalledOnce()

    const upgrade = (origin: string) => {
      const socket = { destroy: vi.fn() }
      httpServer.emit('upgrade', { headers: { host: 'localhost:5173', origin } }, socket)
      return socket.destroy.mock.calls.length
    }
    expect(upgrade('https://evil.example')).toBe(1)
    expect(upgrade('http://localhost:5173')).toBe(0)
    // the guard's listener runs first
    expect(httpServer.listeners('upgrade')).toHaveLength(2)
    expect(httpServer.listeners('upgrade')[1]).toBe(vite)
  }
})
