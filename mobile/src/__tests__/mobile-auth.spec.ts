// Auth store: permission checks (hasPerm / QwPerm) and the session a sign-in starts.
import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { MePayload } from '@qiwu/shared'
import { PASSWORD_PAGE, hasSession } from '@/core/request'
import { hasPerm, useAuthStore } from '@/core/stores/auth'

beforeEach(() => setActivePinia(createPinia()))

const signedInWith = (perms: string[]) => (useAuthStore().me = { perms } as MePayload)

it('hasPerm: any of the points; root "*" passes everything; nobody signed in has none', () => {
  expect(hasPerm('iam.user.browse')).toBe(false)
  signedInWith(['iam.user.browse'])
  expect(hasPerm('iam.user.browse')).toBe(true)
  expect(hasPerm(['iam.user.delete', 'iam.user.browse'])).toBe(true)
  expect(hasPerm('iam.user.delete')).toBe(false)
  expect(hasPerm([])).toBe(false)
  signedInWith(['*'])
  expect(hasPerm('wf.task.approve')).toBe(true)
})

it('a sign-in stores the mobile session; sign-out ends it', async () => {
  vi.mocked(uni.request).mockImplementation((o) => {
    const data =
      o.url === '/api/auth/login'
        ? { accessToken: 'a1', refreshToken: 'r1', expiresIn: 1800 }
        : null
    o.success?.({ statusCode: 200, data: { code: 0, msg: 'ok', data } } as never)
    return {} as UniApp.RequestTask
  })
  const auth = useAuthStore()
  await auth.login({ username: 'admin', password: 'x' })
  expect(hasSession()).toBe(true)
  // a `mobile` session: the refresh token comes back in the body
  expect(vi.mocked(uni.request).mock.calls.at(-1)![0].data).toEqual({
    username: 'admin',
    password: 'x',
    clientId: 'mobile',
    keepSignedIn: true,
  })
  await auth.logout()
  const logout = vi.mocked(uni.request).mock.calls.at(-1)![0]
  expect(logout).toMatchObject({ url: '/api/auth/logout', header: { Authorization: 'Bearer a1' } })
  expect(hasSession()).toBe(false)
  expect(auth.me).toBeNull()
})

it('an initial or expired password sends the session to the change page after /auth/me', async () => {
  const flags = { mustChangePassword: false, passwordExpired: false }
  vi.mocked(uni.request).mockImplementation((o) => {
    const data = { perms: [], flags: { ...flags } }
    o.success?.({ statusCode: 200, data: { code: 0, msg: 'ok', data } } as never)
    return {} as UniApp.RequestTask
  })
  const auth = useAuthStore()
  vi.mocked(uni.reLaunch).mockClear()
  await auth.fetchMe()
  expect(auth.passwordChangeDue).toBe(false)
  expect(uni.reLaunch).not.toHaveBeenCalled()
  for (const due of [{ mustChangePassword: true }, { passwordExpired: true }]) {
    Object.assign(flags, { mustChangePassword: false, passwordExpired: false }, due)
    await auth.fetchMe()
    expect(auth.passwordChangeDue).toBe(true)
    expect(uni.reLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ url: PASSWORD_PAGE }))
    // let the navigation complete
    await new Promise((r) => setTimeout(r))
  }
  expect(uni.reLaunch).toHaveBeenCalledTimes(2)
})
