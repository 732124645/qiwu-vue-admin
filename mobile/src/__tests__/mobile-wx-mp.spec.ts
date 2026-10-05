// WeChat mini program sign-in and binding through the auth store: a fresh uni.login code per
// try, a bound account signed in at once, an unbound one bound with a proof and a new ticket.
import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ApiError, hasSession, setSession } from '@/core/request'
import { takeWxLaunch, useAuthStore } from '@/core/stores/auth'

const tokens = { accessToken: 'a1', refreshToken: 'r1', expiresIn: 1800, refreshExpiresIn: 604800 }
type Answer = [status: number, body: unknown]
const ok = (data: unknown): Answer => [200, { code: 0, msg: 'ok', data }]

/** Serves `routes` (url → answers in turn) and hands out codes wx-1, wx-2, … from uni.login. */
function serve(routes: Record<string, Answer[]>) {
  let n = 0
  vi.mocked(uni.login).mockImplementation(((o: { success: (r: { code: string }) => void }) =>
    o.success({ code: `wx-${++n}` })) as never)
  vi.mocked(uni.request).mockImplementation((o) => {
    const [statusCode, data] = routes[o.url]?.shift() ?? [404, { code: 'A0440', msg: 'nf' }]
    o.success?.({ statusCode, data } as never)
    return {} as UniApp.RequestTask
  })
  return () => vi.mocked(uni.request).mock.calls.map(([o]) => [o.url, o.data])
}

beforeEach(() => {
  setActivePinia(createPinia())
  setSession(null)
  vi.mocked(uni.request).mockReset()
  vi.mocked(uni.showToast).mockClear()
})

it('a bound account: signed in with the uni.login code (null), a mobile session is stored', async () => {
  const calls = serve({ '/api/auth/wx-mp/login': [ok({ tokens })] })
  expect(await useAuthStore().wxLogin()).toBeNull()
  expect(calls()).toEqual([['/api/auth/wx-mp/login', { code: 'wx-1' }]])
  expect(uni.login).toHaveBeenCalledWith(expect.objectContaining({ provider: 'weixin' }))
  expect(hasSession()).toBe(true)
})

it('an unbound account: its bind ticket, no session', async () => {
  serve({ '/api/auth/wx-mp/login': [ok({ bindTicket: 't-1' })] })
  expect(await useAuthStore().wxLogin()).toBe('t-1')
  expect(hasSession()).toBe(false)
})

it('binding: every try gets a new ticket; a failed try throws, the next one binds and signs in', async () => {
  const calls = serve({
    '/api/auth/wx-mp/login': [ok({ bindTicket: 't-1' }), ok({ bindTicket: 't-2' })],
    '/api/auth/wx-mp/bind': [[401, { code: 'A1001', msg: 'wrong password' }], ok(tokens)],
  })
  const auth = useAuthStore()
  const proof = { username: 'alice', password: 'x' }
  await expect(auth.wxBind(proof)).rejects.toMatchObject({ status: 401, message: 'wrong password' })
  expect(hasSession()).toBe(false)
  await auth.wxBind({ ...proof, password: 'right' })
  expect(hasSession()).toBe(true)
  // a 401 of a sign-in route is the form's answer: no refresh, no toast
  expect(calls()).toEqual([
    ['/api/auth/wx-mp/login', { code: 'wx-1' }],
    ['/api/auth/wx-mp/bind', { ...proof, ticket: 't-1' }],
    ['/api/auth/wx-mp/login', { code: 'wx-2' }],
    ['/api/auth/wx-mp/bind', { username: 'alice', password: 'right', ticket: 't-2' }],
  ])
  expect(uni.showToast).not.toHaveBeenCalled()
})

it('binding by SMS code; an account bound meanwhile is signed in without binding', async () => {
  const calls = serve({
    '/api/auth/wx-mp/login': [ok({ bindTicket: 't-1' }), ok({ tokens })],
    '/api/auth/wx-mp/bind': [ok(tokens)],
  })
  const auth = useAuthStore()
  await auth.wxBind({ mobile: '13800138000', code: '123456' })
  setSession(null)
  await auth.wxBind({ mobile: '13800138000', code: '654321' })
  expect(hasSession()).toBe(true)
  expect(calls().map(([url]) => url)).toEqual([
    '/api/auth/wx-mp/login',
    '/api/auth/wx-mp/bind',
    '/api/auth/wx-mp/login',
  ])
})

it('switched off (404) or uni.login failing: the error is the caller’s, silently', async () => {
  serve({})
  const off = await useAuthStore()
    .wxLogin()
    .catch((e: unknown) => e)
  expect(off).toBeInstanceOf(ApiError)
  expect(off).toMatchObject({ status: 404 })
  vi.mocked(uni.login).mockImplementation(((o: { fail: (e: unknown) => void }) =>
    o.fail({ errMsg: 'login:fail' })) as never)
  await expect(useAuthStore().wxLogin()).rejects.toEqual({ errMsg: 'login:fail' })
  expect(uni.showToast).not.toHaveBeenCalled()
  expect(hasSession()).toBe(false)
})

it('the sign-in page tries WeChat once per launch, not again after a sign-out', () => {
  expect(takeWxLaunch()).toBe(true)
  expect(takeWxLaunch()).toBe(false)
})

it('a sign-out ends the launch’s WeChat try, also when a stored session skipped the sign-in page', async () => {
  // a fresh launch: new module state, as when the app starts with a stored session
  vi.resetModules()
  const pinia = await import('pinia')
  pinia.setActivePinia(pinia.createPinia())
  const fresh = await import('@/core/stores/auth')
  serve({ '/api/auth/logout': [ok(null)] })
  await fresh.useAuthStore().logout()
  expect(fresh.takeWxLaunch()).toBe(false)
})
