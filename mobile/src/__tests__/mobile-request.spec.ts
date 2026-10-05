// Single-flight refresh with the refresh token in the body, replay, 401 → sign-in, toasts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOGIN_PAGE, PASSWORD_PAGE, api, hasSession, setSession, upload } from '@/core/request'

type Answer = { statusCode: number; data: unknown }
const ok = (data: unknown): Answer => ({ statusCode: 200, data: { code: 0, msg: 'ok', data } })
const expired: Answer = { statusCode: 401, data: { code: 'A1001', msg: 'expired' } }
const tokens = (n: number) => ({ accessToken: `a${n}`, refreshToken: `r${n}`, expiresIn: 1800 })

/** A fake backend answering every uni.request asynchronously, as the real one does. */
function backend(answer: (o: UniApp.RequestOptions) => Answer | Promise<Answer>) {
  vi.mocked(uni.request).mockImplementation((o) => {
    void Promise.resolve(answer(o)).then((a) =>
      o.success?.(a as UniApp.RequestSuccessCallbackResult),
    )
    return {} as UniApp.RequestTask
  })
}
const calls = (path: string) =>
  vi.mocked(uni.request).mock.calls.filter(([o]) => o.url === `/api${path}`)
const auth = (o: UniApp.RequestOptions) => (o.header as Record<string, string>).Authorization

beforeEach(async () => {
  // let a previous test's sign-in navigation complete
  await new Promise((r) => setTimeout(r))
  vi.clearAllMocks()
  setSession(tokens(1))
})

describe('refresh', () => {
  it('is single-flight: concurrent 401s share one refresh, then each replays with the new token', async () => {
    backend((o) =>
      o.url === '/api/auth/refresh'
        ? ok(tokens(2))
        : auth(o) === 'Bearer a2'
          ? ok(o.url)
          : expired,
    )
    const out = await Promise.all([api.get('/a'), api.get('/b'), api.post('/c', { x: 1 })])
    expect(out).toEqual(['/api/a', '/api/b', '/api/c'])
    expect(calls('/auth/refresh')).toHaveLength(1)
    // the rotated pair: the old refresh token in the body, the new one stored
    expect(calls('/auth/refresh')[0]![0].data).toEqual({ refreshToken: 'r1' })
    expect(uni.getStorageSync('qw.auth.rt')).toBe('r2')
    const [first] = calls('/a')[0]!
    expect(first.header).toMatchObject({ 'Accept-Language': 'zh-CN', 'X-Client-Id': 'mobile' })
    expect(uni.showToast).not.toHaveBeenCalled()
  })

  it('replays a late 401 of the older token without refreshing again', async () => {
    let release!: () => void
    const late = new Promise<void>((r) => (release = r))
    backend(async (o) => {
      if (o.url === '/api/auth/refresh') return ok(tokens(2))
      if (auth(o) === 'Bearer a2') return ok(o.url)
      if (o.url === '/api/slow') await late
      return expired
    })
    const slow = api.get('/slow')
    await api.get('/a')
    release()
    await expect(slow).resolves.toBe('/api/slow')
    expect(calls('/auth/refresh')).toHaveLength(1)
  })

  it('never refreshes for a 401 of an ended session', async () => {
    let release!: () => void
    const late = new Promise<void>((r) => (release = r))
    backend(async () => {
      await late
      return expired
    })
    const slow = api.get('/slow')
    setSession(null)
    release()
    await expect(slow).rejects.toMatchObject({ status: 401 })
    expect(calls('/auth/refresh')).toHaveLength(0)
    expect(uni.reLaunch).not.toHaveBeenCalled()
  })

  it('drops a refresh that lands after sign-out', async () => {
    let answer!: (a: Answer) => void
    backend((o) =>
      o.url === '/api/auth/refresh' ? new Promise<Answer>((r) => (answer = r)) : expired,
    )
    const pending = api.get('/a')
    await vi.waitFor(() => expect(calls('/auth/refresh')).toHaveLength(1))
    setSession(null)
    answer(ok(tokens(2)))
    await expect(pending).rejects.toMatchObject({ status: 401 })
    expect(hasSession()).toBe(false)
    expect(calls('/a')).toHaveLength(1)
  })
})

describe('401 → sign-in', () => {
  it('a rejected refresh clears the session and relaunches the sign-in page once', async () => {
    backend((o) => (o.url === '/api/auth/refresh' ? { ...expired, data: { code: 'A1006' } } : expired))
    const results = await Promise.allSettled([api.get('/a'), api.get('/b')])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(calls('/auth/refresh')).toHaveLength(1)
    expect(hasSession()).toBe(false)
    expect(uni.reLaunch).toHaveBeenCalledTimes(1)
    expect(uni.reLaunch).toHaveBeenCalledWith(expect.objectContaining({ url: LOGIN_PAGE }))
  })

  it('without a stored refresh token goes straight to sign-in', async () => {
    setSession(null)
    backend(() => expired)
    await expect(api.get('/a')).rejects.toMatchObject({ status: 401 })
    expect(calls('/auth/refresh')).toHaveLength(0)
    expect(uni.reLaunch).toHaveBeenCalledTimes(1)
  })

  it('leaves silent callers and the sign-in route alone', async () => {
    backend(() => expired)
    await expect(api.get('/a', undefined, { silent: true })).rejects.toBeTruthy()
    await expect(api.post('/auth/login', {})).rejects.toMatchObject({ status: 401 })
    expect(calls('/auth/refresh')).toHaveLength(1)
    expect(uni.reLaunch).not.toHaveBeenCalled()
  })
})

describe('errors', () => {
  it('toasts the server message of 403/409/422/429/5xx, not of a 400', async () => {
    backend((o) => ({ statusCode: o.url === '/api/bad' ? 400 : 409, data: { code: 'X', msg: 'taken' } }))
    await expect(api.put('/dup', {})).rejects.toMatchObject({ status: 409, message: 'taken' })
    expect(uni.showToast).toHaveBeenCalledWith({ title: 'taken', icon: 'none' })
    vi.mocked(uni.showToast).mockClear()
    await expect(api.get('/bad')).rejects.toMatchObject({ status: 400 })
    expect(uni.showToast).not.toHaveBeenCalled()
  })

  it('a 403 A1004 (password change due) relaunches the change page once instead of a toast', async () => {
    backend(() => ({ statusCode: 403, data: { code: 'A1004', msg: 'change your password' } }))
    await Promise.allSettled([api.get('/a'), api.get('/b')])
    expect(uni.reLaunch).toHaveBeenCalledTimes(1)
    expect(uni.reLaunch).toHaveBeenCalledWith(expect.objectContaining({ url: PASSWORD_PAGE }))
    expect(uni.showToast).not.toHaveBeenCalled()
    // silent callers (the badge polling) and the change page itself stay put
    await new Promise((r) => setTimeout(r))
    await expect(api.get('/c', undefined, { silent: true })).rejects.toMatchObject({ status: 403 })
    vi.stubGlobal('getCurrentPages', () => [{ route: PASSWORD_PAGE.slice(1) }])
    await expect(api.get('/d')).rejects.toMatchObject({ code: 'A1004' })
    vi.stubGlobal('getCurrentPages', () => [])
    expect(uni.reLaunch).toHaveBeenCalledTimes(1)
  })

  it('toasts a network failure in the current language', async () => {
    vi.mocked(uni.request).mockImplementation((o) => {
      o.fail?.({ errMsg: 'request:fail timeout' })
      return {} as UniApp.RequestTask
    })
    await expect(api.delete('/a')).rejects.toMatchObject({ status: 0 })
    expect(uni.showToast).toHaveBeenCalledWith({ title: '网络异常，请稍后重试', icon: 'none' })
  })
})

it('uploads through the backend and reads its JSON text answer', async () => {
  vi.mocked(uni.uploadFile).mockImplementation((o) => {
    expect(o).toMatchObject({ url: '/api/files', filePath: 'tmp://a.png', name: 'file' })
    expect(o.header).toMatchObject({ Authorization: 'Bearer a1' })
    o.success?.({ statusCode: 200, data: JSON.stringify(ok({ id: 7 }).data) } as UniApp.UploadFileSuccessCallbackResult)
    return {} as UniApp.UploadTask
  })
  await expect(upload('/files', 'tmp://a.png', { bizTag: 'avatar' })).resolves.toEqual({ id: 7 })
})

it('toasts an upload over the size limit (413), which a JSON call leaves to the page', async () => {
  vi.mocked(uni.uploadFile).mockImplementation((o) => {
    const data = JSON.stringify({ code: 'S4130', msg: 'too large' })
    o.success?.({ statusCode: 413, data } as UniApp.UploadFileSuccessCallbackResult)
    return {} as UniApp.UploadTask
  })
  await expect(upload('/files', 'tmp://a.png')).rejects.toMatchObject({ status: 413 })
  expect(uni.showToast).toHaveBeenCalledWith({ title: 'too large', icon: 'none' })
})

it('loads server paths (avatars under /files) from the API origin on mp-weixin / App', async () => {
  expect((await import('@/core/request')).assetUrl('/files/a.webp')).toBe('/files/a.webp')
  vi.stubEnv('VITE_API_BASE', 'https://api.example.com/api')
  vi.resetModules()
  const { assetUrl } = await import('@/core/request')
  vi.unstubAllEnvs()
  expect(assetUrl('/files/a.webp')).toBe('https://api.example.com/files/a.webp')
  expect(assetUrl('https://cdn.example.com/a.webp')).toBe('https://cdn.example.com/a.webp')
})
