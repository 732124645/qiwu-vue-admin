import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AxiosError } from 'axios'
import { ElMessage, ElMessageBox } from 'element-plus'
import { setLocale } from '@/core/i18n'
import {
  accessToken,
  api,
  ApiError,
  download,
  fetchBlob,
  http,
  setSessionHint,
} from '@/core/request/http'
import { fail, mockApi, ok } from './mock-api'

const nav = vi.hoisted(() => ({
  route: { path: '/iam/users', fullPath: '/iam/users?page=2', matched: [{}], meta: {} },
  push: vi.fn<(to: unknown) => void>(),
}))
vi.mock('@/core/router', () => ({
  default: {
    currentRoute: {
      get value() {
        return nav.route
      },
    },
    push: nav.push,
  },
}))
vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn<(o: { message: string; grouping: boolean }) => void>() },
  ElMessageBox: { confirm: vi.fn<(...args: unknown[]) => Promise<string>>() },
}))

/** an error toast with this text, grouped (one toast per text) */
const toasted = (message: string) =>
  expect(ElMessage.error).toHaveBeenCalledWith({ message, grouping: true })
const bearer = (c: { headers: Record<string, unknown> }) => c.headers.Authorization

beforeEach(() => {
  accessToken.value = 'old'
  setSessionHint(true)
  nav.route = { path: '/iam/users', fullPath: '/iam/users?page=2', matched: [{}], meta: {} }
})
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('http client', () => {
  it('sends auth, language, request-id and timezone headers and unwraps data', async () => {
    setLocale('en-US')
    const calls = mockApi({ 'GET /x': ok({ a: 1 }) })
    await expect(api.get('/x')).resolves.toEqual({ a: 1 })
    const h = calls[0]!.headers
    expect(calls[0]!.baseURL).toBe('/api')
    expect(h.Authorization).toBe('Bearer old')
    expect(h['Accept-Language']).toBe('en-US')
    expect(h['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(h['X-Timezone']).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    setLocale('zh-CN')
  })

  it('refreshes once for concurrent 401s and replays each request once', async () => {
    const calls = mockApi({
      'POST /auth/refresh': () => ok({ accessToken: 'new', expiresIn: 900 }),
      'GET /a': (c) => (bearer(c) === 'Bearer new' ? ok('a') : fail(401, 'A0410')),
      'GET /b': (c) => (bearer(c) === 'Bearer new' ? ok('b') : fail(401, 'A0410')),
    })
    await expect(Promise.all([api.get('/a'), api.get('/b')])).resolves.toEqual(['a', 'b'])
    const refreshes = calls.filter((c) => c.url === '/auth/refresh')
    expect(refreshes).toHaveLength(1)
    expect(refreshes[0]!.withCredentials).toBe(true)
    expect(accessToken.value).toBe('new')
    expect(calls).toHaveLength(5)
  })

  it('replays only once when the replay is rejected again', async () => {
    const calls = mockApi({
      'POST /auth/refresh': ok({ accessToken: 'new', expiresIn: 900 }),
      'GET /a': fail(401, 'A0410'),
    })
    await expect(api.get('/a')).rejects.toMatchObject({ status: 401 })
    expect(calls.map((c) => c.url)).toEqual(['/a', '/auth/refresh', '/a'])
  })

  it('serializes the refresh across tabs with navigator.locks when available', async () => {
    const request = vi.fn<(name: string, fn: () => Promise<void>) => Promise<void>>((_n, fn) =>
      fn(),
    )
    vi.spyOn(navigator, 'locks', 'get').mockReturnValue({ request } as never)
    mockApi({
      'POST /auth/refresh': ok({ accessToken: 'new', expiresIn: 900 }),
      'GET /a': (c) => (bearer(c) === 'Bearer new' ? ok('a') : fail(401, 'A0410')),
    })
    await expect(api.get('/a')).resolves.toBe('a')
    expect(request).toHaveBeenCalledWith('qw.auth.refresh', expect.any(Function))
  })

  it('refresh failure on a page → session-expired dialog; "sign in again" goes to /login and back', async () => {
    vi.mocked(ElMessageBox.confirm).mockResolvedValue({ action: 'confirm' } as never)
    mockApi({ 'POST /auth/refresh': fail(401, 'A1006'), 'GET /a': fail(401, 'A0410') })
    await expect(api.get('/a')).rejects.toBeInstanceOf(ApiError)
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalled())
    expect(ElMessageBox.confirm).toHaveBeenCalledOnce()
    expect(nav.push).toHaveBeenCalledWith({
      path: '/login',
      query: { redirect: '/iam/users?page=2' },
    })
    expect(accessToken.value).toBe('')
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it('"stay on this page" keeps the route', async () => {
    vi.mocked(ElMessageBox.confirm).mockRejectedValue('cancel')
    mockApi({ 'POST /auth/refresh': fail(401, 'A1006'), 'GET /a': fail(401, 'A0410') })
    await expect(api.get('/a')).rejects.toMatchObject({ status: 401 })
    await vi.waitFor(() => expect(ElMessageBox.confirm).toHaveBeenCalledOnce())
    expect(nav.push).not.toHaveBeenCalled()
  })

  it('no dialog when the refresh fails during the first navigation (the guard redirects)', async () => {
    nav.route = { path: '/', fullPath: '/', matched: [], meta: {} }
    mockApi({ 'POST /auth/refresh': fail(401, 'A1006'), 'GET /a': fail(401, 'A0410') })
    await expect(api.get('/a')).rejects.toMatchObject({ status: 401 })
    expect(ElMessageBox.confirm).not.toHaveBeenCalled()
  })

  it('a refresh that gets no answer is no sign-out: no dialog, a network toast, the hint kept', async () => {
    setLocale('en-US')
    mockApi({ 'POST /auth/refresh': fail(502, 'B0001'), 'GET /a': fail(401, 'A0410') })
    // the refresh's own error, so callers that end the session on a 401 (the lock screen) keep it
    await expect(api.get('/a')).rejects.toMatchObject({ status: 502 })
    expect(ElMessageBox.confirm).not.toHaveBeenCalled()
    toasted('Network error. Please try again later.')
    expect(localStorage.getItem('qw.auth.session')).toBe('1')
    setLocale('zh-CN')
  })

  it('no dialog for silent requests (the lock screen goes to /login itself)', async () => {
    mockApi({ 'POST /auth/refresh': fail(401, 'A1006'), 'POST /a': fail(401, 'A1005') })
    await expect(api.post('/a', {}, { silent: true })).rejects.toMatchObject({ status: 401 })
    expect(ElMessageBox.confirm).not.toHaveBeenCalled()
  })

  it('does not refresh on a failed login', async () => {
    const calls = mockApi({ 'POST /auth/login': fail(401, 'A1001', 'bad credentials') })
    await expect(api.post('/auth/login', {})).rejects.toMatchObject({ code: 'A1001' })
    expect(calls).toHaveLength(1)
  })

  it('routes AUTH_PASSWORD_CHANGE_REQUIRED to /password-change without a toast', async () => {
    mockApi({ 'GET /a': fail(403, 'A1004') })
    await expect(api.get('/a')).rejects.toMatchObject({ code: 'A1004' })
    expect(nav.push).toHaveBeenCalledWith('/password-change')
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it.each([403, 409, 422, 429, 500, 503])('toasts the server message on %i', async (status) => {
    mockApi({ 'GET /a': fail(status, 'A0000', 'translated msg') })
    await expect(api.get('/a')).rejects.toMatchObject({ status, message: 'translated msg' })
    toasted('translated msg')
  })

  it('a gateway answer without an envelope (502 while the API restarts) reads as a network error', async () => {
    setLocale('en-US')
    mockApi({ 'GET /a': [502, ''] })
    const message = 'Network error. Please try again later.'
    await expect(api.get('/a')).rejects.toMatchObject({ status: 502, message })
    toasted(message)
    setLocale('zh-CN')
  })

  it.each([400, 404])('leaves %i to the caller', async (status) => {
    mockApi({ 'GET /a': fail(status, 'A0400') })
    await expect(api.get('/a')).rejects.toMatchObject({ status })
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it('silent requests do not toast', async () => {
    mockApi({ 'GET /a': fail(409, 'A0491') })
    await expect(api.get('/a', { silent: true })).rejects.toMatchObject({ code: 'A0491' })
    expect(ElMessage.error).not.toHaveBeenCalled()
  })

  it('fetchBlob returns the blob and parses JSON error bodies inside blob responses', async () => {
    const file = new Blob(['png'], { type: 'image/png' })
    const err = new Blob([JSON.stringify({ code: 'A0430', msg: 'no access', data: null })], {
      type: 'application/json',
    })
    mockApi({ 'GET /f/1': [200, file], 'GET /f/2': [403, err] })
    await expect(fetchBlob('/f/1')).resolves.toBe(file)
    await expect(fetchBlob('/f/2')).rejects.toMatchObject({ code: 'A0430', message: 'no access' })
    toasted('no access')
  })

  it('download saves the blob under the given filename', async () => {
    const calls = mockApi({ 'GET /iam/users/export': [200, new Blob(['x'])] })
    URL.createObjectURL = vi.fn<() => string>(() => 'blob:1')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('users.xlsx')
      expect(this.href).toBe('blob:1')
    })
    await download('/iam/users/export', { status: 'on' }, 'users.xlsx')
    expect(click).toHaveBeenCalledOnce()
    expect(calls[0]!.params).toEqual({ status: 'on' })
    expect(calls[0]!.responseType).toBe('blob')
  })

  it('shows a network error when there is no response', async () => {
    http.defaults.adapter = async (config) => {
      throw new AxiosError('down', 'ERR_NETWORK', config)
    }
    await expect(api.get('/a')).rejects.toThrow('down')
    expect(ElMessage.error).toHaveBeenCalledOnce()
  })
})
