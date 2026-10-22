import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ClockPunch, ClockRecordVo, ClockTodayVo, MePayload } from '@qiwu/shared'
import { FEATURE, visibleShortcuts } from '@/core/features'
import { setLocale } from '@/core/i18n'
import { currentSessionVersion, setSession } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'
import { useCountsStore } from '@/core/stores/counts'
import { clockRange, useClock, validateClockPosition } from '../pages-biz/oa-clock/clock'
import pages from '../pages.json'
import manifestText from '../manifest.json?raw'

type Reply = { status?: number; data?: unknown; fail?: boolean }
const at = '2001-02-03T01:02:03.000Z'
const site = {
  id: 5,
  name: 'Office',
  latitude: '30.000000',
  longitude: '120.000000',
  radiusM: 200,
  maxAccuracyM: 50,
}
const position = { latitude: 30, longitude: 120, accuracy: 10, horizontalAccuracy: 10 }
let today: ClockTodayVo
let responses: Map<string, ClockRecordVo>
let calls: { url: string; method: string; data: unknown }[]
let post: ((body: ClockPunch) => Reply) | undefined
const controllers: ReturnType<typeof useClock>[] = []
const controller = () => {
  const out = useClock()
  controllers.push(out)
  return out
}
const record = (body: ClockPunch, extra: Partial<ClockRecordVo> = {}): ClockRecordVo => ({
  id: 1,
  userId: 3,
  deptId: 2,
  workDate: today.workDate,
  action: body.action,
  punchedAt: at,
  timezone: today.policy.timezone,
  policyId: 1,
  policySnapshot: {
    enabled: true,
    timezone: today.policy.timezone,
    locationMode: today.policy.locationMode,
    retentionDays: 180,
  },
  siteId: body.position?.siteId ?? null,
  siteName: body.position ? 'Office' : null,
  siteSnapshot: body.position ? site : null,
  distanceM: body.position ? 0 : null,
  accuracyM: body.position ? '10.00' : null,
  validationResult: body.position ? 'passed' : 'not_required',
  source: 'native',
  requestId: body.requestId,
  ...extra,
})
const writes = () => calls.filter((call) => call.method === 'POST')
function respond(options: UniApp.RequestOptions, reply: Reply) {
  if (reply.fail) options.fail?.({ errMsg: 'timeout' } as never)
  else
    options.success?.({
      statusCode: reply.status ?? 200,
      data: {
        code: reply.status && reply.status >= 400 ? reply.status : 0,
        msg: reply.status ? `Server ${reply.status}` : 'ok',
        data: reply.data ?? null,
      },
    } as never)
}
function normal(options: UniApp.RequestOptions) {
  const path = options.url.replace(/^\/api/, '')
  const body = options.data as ClockPunch
  calls.push({
    url: path,
    method: options.method ?? 'GET',
    data: options.data === undefined ? undefined : JSON.parse(JSON.stringify(options.data)),
  })
  let reply: Reply
  if (path.endsWith('/today')) reply = { data: today }
  else if (path.includes('/requests/'))
    reply = responses.has(path.split('/').pop()!)
      ? { data: responses.get(path.split('/').pop()!) }
      : { status: 404 }
  else if (path === '/oa/attendance-sites/options') reply = { data: { items: [site], total: 1 } }
  else if (path.endsWith('/mine'))
    reply = { data: { items: [...responses.values()], total: responses.size } }
  else if (path.endsWith('/punch')) {
    if (post) reply = post(body)
    else {
      const made = record(body)
      responses.set(body.requestId, made)
      if (body.action === 'check_in') today = { ...today, checkIn: made }
      else today = { ...today, checkOut: made }
      reply = { status: 201, data: made }
    }
  } else reply = { data: { unread: 0, items: [], total: 0 } }
  respond(options, reply)
  return {} as UniApp.RequestTask
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  setLocale('en-US')
  setSession({ accessToken: 'a', refreshToken: 'r', expiresIn: 1800 })
  useAuthStore().me = { features: ['oa'], perms: [], user: { id: 3 } } as unknown as MePayload
  today = {
    serverAt: at,
    workDate: '2001-02-03',
    policy: { id: 1, enabled: true, timezone: 'Asia/Shanghai', locationMode: 'none' },
    checkIn: null,
    checkOut: null,
  }
  responses = new Map()
  calls = []
  post = undefined
  vi.mocked(uni.request).mockImplementation(normal)
  vi.mocked(uni.getLocation).mockImplementation((options) =>
    options!.success?.(position as UniApp.GetLocationSuccess),
  )
})
afterEach(() => {
  for (const item of controllers.splice(0)) item.dispose()
  setLocale('zh-CN')
})

describe('mobile native clocking', () => {
  it('uses the server work date, supports OA without workflow and never requests location in none mode', async () => {
    const clock = controller()
    expect(FEATURE.oa).toBe('oa')
    expect(visibleShortcuts([{ name: 'clock' }, { name: 'start' }])).toEqual([{ name: 'clock' }])
    const group = pages.subPackages.find((item) => item.root === 'pages-biz')!
    expect(group.pages.some((item) => item.path === 'oa-clock/index')).toBe(true)
    useCountsStore().load()
    await clock.load()
    expect(calls.some((call) => call.url.startsWith('/wf/'))).toBe(false)
    expect(clock.state.month).toBe('2001-02')
    expect(clock.allowed('check_in')).toBe(true)
    expect(clock.allowed('check_out')).toBe(false)
    await clock.punch('check_in')
    expect(uni.getLocation).not.toHaveBeenCalled()
    expect(writes()).toHaveLength(1)
    expect(writes()[0].data).toEqual({
      action: 'check_in',
      requestId: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/),
    })
    expect(clock.state.today?.workDate).toBe('2001-02-03')
    expect(clock.state.today?.checkIn).toBeTruthy()
    expect(clock.allowed('check_in')).toBe(false)
    expect(clock.allowed('check_out')).toBe(true)
    await clock.punch('check_out')
    expect(writes()).toHaveLength(2)
    expect((writes()[1].data as ClockPunch).requestId).not.toBe(
      (writes()[0].data as ClockPunch).requestId,
    )
    expect(clock.allowed('check_out')).toBe(false)
  })

  it('refuses missing OA, disabled policy and checkout without check-in', async () => {
    useAuthStore().me = { features: ['workflow'] } as MePayload
    const clock = controller()
    await clock.load()
    await clock.punch('check_in')
    expect(calls).toHaveLength(0)
    useAuthStore().me = { features: ['oa'] } as MePayload
    today.policy.enabled = false
    await clock.load()
    expect(clock.allowed('check_in')).toBe(false)
    expect(clock.allowed('check_out')).toBe(false)
    today = {
      ...today,
      checkIn: record({ action: 'check_in', requestId: 'existing-disabled-1234' }),
    }
    await clock.load()
    expect(clock.allowed('check_out')).toBe(false)
    await clock.punch('check_in')
    await clock.punch('check_out')
    expect(writes()).toHaveLength(0)
  })

  it('loads private site options without GPS and requires an explicit valid site choice', async () => {
    today.policy.locationMode = 'site'
    const clock = controller()
    await clock.load()
    expect(clock.state.sites).toEqual([site])
    expect(uni.getLocation).not.toHaveBeenCalled()
    await clock.punch('check_in')
    expect(clock.state.error).toMatch(/Choose/)
    expect(writes()).toHaveLength(0)
    clock.state.siteId = 5
    await clock.punch('check_in')
    expect(vi.mocked(uni.getLocation).mock.calls[0][0]).toMatchObject({
      type: 'wgs84',
      isHighAccuracy: true,
    })
    expect(writes()[0].data).toEqual({
      action: 'check_in',
      requestId: expect.any(String),
      position: { siteId: 5, latitude: 30, longitude: 120, accuracyM: 10 },
    })
    expect(clock.state.unresolved).toBe(false)
  })

  it('disables both actions for the entire location and write duration', async () => {
    today.policy.locationMode = 'site'
    const clock = controller()
    await clock.load()
    clock.state.siteId = 5
    let gps: UniApp.GetLocationOptions | undefined
    let write: UniApp.RequestOptions | undefined
    vi.mocked(uni.getLocation).mockImplementation((options) => {
      gps = options
    })
    vi.mocked(uni.request).mockImplementation((options) => {
      if (options.method === 'POST') {
        write = options
        return {} as UniApp.RequestTask
      }
      return normal(options)
    })
    const pending = clock.punch('check_in')
    await vi.waitFor(() => expect(gps).toBeDefined())
    expect(clock.state.busy).toBe(true)
    expect(clock.allowed('check_in')).toBe(false)
    expect(clock.allowed('check_out')).toBe(false)
    await clock.punch('check_in')
    gps!.success?.(position as UniApp.GetLocationSuccess)
    await vi.waitFor(() => expect(write).toBeDefined())
    expect(clock.state.busy).toBe(true)
    respond(write!, { status: 201, data: record(write!.data as ClockPunch) })
    await pending
    expect(clock.state.busy).toBe(false)
    expect(uni.getLocation).toHaveBeenCalledTimes(1)
  })

  it.each(['getLocation:fail auth deny', 'getLocation:fail unavailable'])(
    'explains location failures without falling back to an unlocated write: %s',
    async (errMsg) => {
      today.policy.locationMode = 'site'
      const clock = controller()
      await clock.load()
      clock.state.siteId = 5
      vi.mocked(uni.getLocation).mockImplementation((options) => options!.fail?.({ errMsg }))
      await clock.punch('check_in')
      expect(clock.state.error).toMatch(errMsg.includes('deny') ? /denied/ : /unavailable/)
      expect(writes()).toHaveLength(0)
      expect(clock.state.busy).toBe(false)
    },
  )

  it('explains an unavailable runtime location API', async () => {
    today.policy.locationMode = 'site'
    const clock = controller()
    await clock.load()
    clock.state.siteId = 5
    const existing = uni.getLocation
    Object.assign(uni, { getLocation: undefined })
    try {
      await clock.punch('check_in')
      expect(clock.state.error).toMatch(/unavailable/)
      expect(writes()).toHaveLength(0)
    } finally {
      Object.assign(uni, { getLocation: existing })
    }
  })

  it.each([
    { latitude: 91 },
    { longitude: -181 },
    { latitude: NaN },
    { accuracy: NaN, horizontalAccuracy: NaN },
    { accuracy: 0, horizontalAccuracy: 0 },
    { accuracy: -1, horizontalAccuracy: -1 },
    { accuracy: Infinity, horizontalAccuracy: Infinity },
    { accuracy: 51, horizontalAccuracy: 51 },
    { latitude: 31 },
  ])('rejects invalid, inaccurate or out-of-range coordinates before POST: %j', async (over) => {
    today.policy.locationMode = 'site'
    const clock = controller()
    await clock.load()
    clock.state.siteId = 5
    vi.mocked(uni.getLocation).mockImplementation((options) =>
      options!.success?.({ ...position, ...over } as UniApp.GetLocationSuccess),
    )
    await clock.punch('check_in')
    expect(clock.state.error).toBeTruthy()
    expect(writes()).toHaveLength(0)
    expect(clock.state.busy).toBe(false)
  })

  it('accepts accuracy at the configured boundary and uses horizontal accuracy when available', () => {
    expect(
      validateClockPosition(site, {
        latitude: 30,
        longitude: 120,
        accuracy: 1,
        horizontalAccuracy: 50,
      }),
    ).toEqual({ siteId: 5, latitude: 30, longitude: 120, accuracyM: 50 })
    expect(
      validateClockPosition(site, { latitude: 30, longitude: 120, accuracy: 10 }),
    ).toMatchObject({ accuracyM: 10 })
  })

  it('queries uncertain results before refreshing today, never automatically replays, and preserves nonce and original location for manual retry', async () => {
    today.policy.locationMode = 'site'
    const clock = controller()
    await clock.load()
    clock.state.siteId = 5
    post = () => ({ fail: true })
    await clock.punch('check_in')
    const original = writes()[0].data
    const sequence = calls
      .slice(calls.findIndex((call) => call.method === 'POST'))
      .map((call) => call.url)
    expect(sequence).toEqual([
      '/oa/clock-records/punch',
      `/oa/clock-records/requests/${(original as ClockPunch).requestId}`,
      '/oa/clock-records/today',
    ])
    expect(clock.state.unresolved).toBe(true)
    expect(clock.state.retryable).toBe(true)
    expect(clock.allowed('check_in')).toBe(false)
    expect(writes()).toHaveLength(1)
    post = undefined
    await clock.resolve(true)
    expect(writes()).toHaveLength(2)
    expect(writes()[1].data).toEqual(original)
    expect(uni.getLocation).toHaveBeenCalledTimes(1)
    expect(clock.state.unresolved).toBe(false)
    expect(clock.state.message).toMatch(/Confirmed/)
  })

  it('keeps unresolved state when result lookup fails and rechecks before an explicit retry', async () => {
    const clock = controller()
    await clock.load()
    post = () => ({ fail: true })
    let unavailable = true
    vi.mocked(uni.request).mockImplementation((options) => {
      if (options.url.includes('/requests/') && unavailable) {
        respond(options, { status: 503 })
        return {} as UniApp.RequestTask
      }
      return normal(options)
    })
    await clock.punch('check_in')
    expect(clock.state.retryable).toBe(false)
    expect(clock.state.unresolved).toBe(true)
    await clock.resolve(true)
    expect(writes()).toHaveLength(1)
    unavailable = false
    await clock.resolve()
    expect(clock.state.retryable).toBe(true)
    expect(writes()).toHaveLength(1)
  })

  it('resolves an old-day result after midnight without writing or locating again', async () => {
    const clock = controller()
    await clock.load()
    post = (body) => {
      responses.set(body.requestId, record(body))
      today = { ...today, workDate: '2001-02-04', serverAt: '2001-02-04T01:00:00.000Z' }
      return { fail: true }
    }
    await clock.punch('check_in')
    expect(writes()).toHaveLength(1)
    expect(clock.state.message).toContain('2001-02-03')
    expect(clock.state.today?.workDate).toBe('2001-02-04')
    expect(clock.state.unresolved).toBe(false)
    expect(uni.getLocation).not.toHaveBeenCalled()
  })

  it('never turns an absent old-day request into a new-day punch on retry', async () => {
    const clock = controller()
    await clock.load()
    post = () => ({ fail: true })
    await clock.punch('check_in')
    expect(clock.state.retryable).toBe(true)
    today = { ...today, workDate: '2001-02-04' }
    await clock.resolve(true)
    expect(writes()).toHaveLength(1)
    expect(clock.state.error).toMatch(/work date changed/)
    expect(clock.state.unresolved).toBe(false)
  })

  it('does not write after the server date changes during GPS', async () => {
    today.policy.locationMode = 'site'
    const clock = controller()
    await clock.load()
    clock.state.siteId = 5
    vi.mocked(uni.getLocation).mockImplementation((options) => {
      today = { ...today, workDate: '2001-02-04' }
      options!.success?.(position as UniApp.GetLocationSuccess)
    })
    await clock.punch('check_in')
    expect(writes()).toHaveLength(0)
    expect(clock.state.error).toMatch(/work date changed/)
  })

  it.each([400, 409, 429])(
    'shows server %s feedback and refreshes state before allowing another decision',
    async (status) => {
      const clock = controller()
      await clock.load()
      post = () => {
        if (status === 409)
          today = {
            ...today,
            checkIn: record({ action: 'check_in', requestId: 'other-request-123456' }),
          }
        return { status }
      }
      await clock.punch('check_in')
      expect(clock.state.error).toBe(`Server ${status}`)
      expect(writes()).toHaveLength(1)
      const afterWrite = calls.slice(calls.findIndex((call) => call.method === 'POST') + 1)
      expect(afterWrite[0]?.url).toMatch(/\/requests\//)
      expect(afterWrite[1]?.url).toBe('/oa/clock-records/today')
      expect(clock.allowed('check_in')).toBe(status === 400)
    },
  )

  it('does not automatically replay a punch on 401', async () => {
    const clock = controller()
    await clock.load()
    post = () => ({ status: 401 })
    await clock.punch('check_in')
    expect(writes()).toHaveLength(1)
    expect(calls.some((call) => call.url === '/auth/refresh')).toBe(false)
    expect(clock.state.unresolved).toBe(true)
  })

  it('drops a pending GPS result and all visible state immediately on account change', async () => {
    today.policy.locationMode = 'site'
    const clock = controller()
    await clock.load()
    clock.state.siteId = 5
    let gps: UniApp.GetLocationOptions | undefined
    vi.mocked(uni.getLocation).mockImplementation((options) => {
      gps = options
    })
    const pending = clock.punch('check_in')
    await vi.waitFor(() => expect(gps).toBeDefined())
    setSession({ accessToken: 'new', refreshToken: 'new-r', expiresIn: 1800 })
    expect(clock.state.today).toBeNull()
    expect(clock.state.siteId).toBe(0)
    expect(clock.state.unresolved).toBe(false)
    gps!.success?.(position as UniApp.GetLocationSuccess)
    await pending
    expect(writes()).toHaveLength(0)
    expect(clock.state.today).toBeNull()
  })

  it('drops a late write response and does not carry its nonce into the next session', async () => {
    const clock = controller()
    await clock.load()
    let write: UniApp.RequestOptions | undefined
    vi.mocked(uni.request).mockImplementation((options) => {
      if (options.method === 'POST') {
        write = options
        return {} as UniApp.RequestTask
      }
      return normal(options)
    })
    const pending = clock.punch('check_in')
    await vi.waitFor(() => expect(write).toBeDefined())
    setSession(null)
    expect(clock.state.unresolved).toBe(false)
    respond(write!, { status: 201, data: record(write!.data as ClockPunch) })
    await pending
    expect(clock.state.today).toBeNull()
    expect(clock.state.message).toBe('')
    await clock.resolve(true)
    expect(calls.some((call) => call.url.includes('/requests/'))).toBe(false)
  })

  it('requests only my day or month range with pagination, including leap years', async () => {
    const clock = controller()
    await clock.load()
    expect(clockRange('2024-02')).toEqual({ workDateFrom: '2024-02-01', workDateTo: '2024-02-29' })
    clock.state.month = '2024-02'
    await clock.records(2)
    expect(calls.at(-1)?.data).toEqual({
      page: 2,
      pageSize: 20,
      workDateFrom: '2024-02-01',
      workDateTo: '2024-02-29',
      sort: '-punchedAt,-id',
    })
    clock.state.day = '2024-02-03'
    await clock.records(1)
    expect(calls.at(-1)?.data).toMatchObject({
      page: 1,
      workDateFrom: '2024-02-03',
      workDateTo: '2024-02-03',
    })
    const size = calls.length
    clock.state.day = '2024-03-01'
    await clock.records()
    expect(calls).toHaveLength(size)
    expect(clock.state.error).toMatch(/valid month/)
  })

  it('rejects malformed responses rather than trusting a partial today or private site payload', async () => {
    const clock = controller()
    vi.mocked(uni.request).mockImplementation((options) => {
      respond(options, { data: { workDate: '2001-02-03' } })
      return {} as UniApp.RequestTask
    })
    await clock.load()
    expect(clock.allowed('check_in')).toBe(false)
    expect(clock.state.today).toBeNull()
    expect(clock.state.error).toBeTruthy()
  })

  it('declares only foreground location permissions and platform privacy purposes', () => {
    const manifest = JSON.parse(manifestText.replace(/\/\*[\s\S]*?\*\//g, ''))
    expect(manifest['mp-weixin'].requiredPrivateInfos).toEqual(['getLocation'])
    expect(manifest['mp-weixin'].permission['scope.userLocation'].desc).toMatch(/\S/)
    expect(manifest['app-plus'].modules.Geolocation).toEqual({})
    const android = manifest['app-plus'].distribute.android.permissions.join(' ')
    expect(android).toContain('ACCESS_FINE_LOCATION')
    expect(android).toContain('ACCESS_COARSE_LOCATION')
    expect(android).not.toMatch(/BACKGROUND_LOCATION/)
    const ios = manifest['app-plus'].distribute.ios.privacyDescription
    expect(ios.NSLocationWhenInUseUsageDescription).toMatch(/\S/)
    expect(Object.keys(ios).some((name) => name.includes('Always'))).toBe(false)
  })

  it('bounds a GPS call that never answers without submitting or keeping a busy button forever', async () => {
    today.policy.locationMode = 'site'
    const clock = controller()
    await clock.load()
    clock.state.siteId = 5
    vi.useFakeTimers()
    let gps: UniApp.GetLocationOptions | undefined
    let settled = false
    vi.mocked(uni.getLocation).mockImplementation((options) => {
      gps = options
    })
    const pending = clock.punch('check_in').then(() => {
      settled = true
    })
    try {
      await vi.advanceTimersByTimeAsync(20_001)
      expect(clock.state.busy).toBe(false)
      expect(settled).toBe(true)
      await pending
      expect(clock.state.error).toMatch(/unavailable/)
      expect(writes()).toHaveLength(0)
    } finally {
      clock.dispose()
      gps?.success?.(position as UniApp.GetLocationSuccess)
      await pending
      vi.useRealTimers()
    }
  })

  it('keeps position and the unresolved request only in memory', async () => {
    today.policy.locationMode = 'site'
    const clock = controller()
    await clock.load()
    clock.state.siteId = 5
    const storage = vi.spyOn(uni, 'setStorageSync')
    post = () => ({ fail: true })
    try {
      await clock.punch('check_in')
      expect(clock.state.unresolved).toBe(true)
      expect(storage).not.toHaveBeenCalled()
      setSession(null)
      expect(clock.state.siteId).toBe(0)
      expect(clock.state.pendingAction).toBeNull()
      expect(clock.state.unresolved).toBe(false)
    } finally {
      storage.mockRestore()
    }
  })

  it('drops an old history response after account switching', async () => {
    const clock = controller()
    await clock.load()
    let delayed: UniApp.RequestOptions | undefined
    vi.mocked(uni.request).mockImplementation((options) => {
      if (options.url.endsWith('/mine')) {
        delayed = options
        return {} as UniApp.RequestTask
      }
      return normal(options)
    })
    const pending = clock.records(2)
    setSession(null)
    respond(delayed!, {
      data: {
        items: [record({ action: 'check_in', requestId: 'history-request-1234' })],
        total: 1,
      },
    })
    await pending
    expect(clock.state.items).toEqual([])
    expect(clock.state.total).toBe(0)
    expect(clock.state.loadingRecords).toBe(false)
  })

  it('blocks actions when OA is removed after a successful load', async () => {
    const clock = controller()
    await clock.load()
    useAuthStore().me = { features: ['workflow'] } as MePayload
    expect(clock.allowed('check_in')).toBe(false)
    await clock.punch('check_in')
    expect(writes()).toHaveLength(0)
  })

  it('rechecks the fresh server state before checkout', async () => {
    today.checkIn = record({ action: 'check_in', requestId: 'existing-request-1234' })
    const clock = controller()
    await clock.load()
    expect(clock.allowed('check_out')).toBe(true)
    today = { ...today, checkIn: null }
    await clock.punch('check_out')
    expect(writes()).toHaveLength(0)
    expect(clock.allowed('check_out')).toBe(false)
  })

  it.each([{ requestId: 'wrong-result-123456' }, { action: 'check_out' as const }])(
    'does not resolve a result for a different request or action: %j',
    async (over) => {
      const clock = controller()
      await clock.load()
      post = (body) => {
        responses.set(body.requestId, record(body, over))
        return { fail: true }
      }
      await clock.punch('check_in')
      expect(clock.state.unresolved).toBe(true)
      expect(clock.state.retryable).toBe(false)
      expect(clock.state.message).toBe('')
      await clock.resolve(true)
      expect(writes()).toHaveLength(1)
    },
  )

  it('rejects invalid history page parameters before the request', async () => {
    const clock = controller()
    await clock.load()
    const count = calls.length
    await clock.records(0)
    expect(calls).toHaveLength(count)
    expect(clock.state.items).toEqual([])
  })

  it('rejects a site option carrying employee data', async () => {
    today.policy.locationMode = 'site'
    const clock = controller()
    vi.mocked(uni.request).mockImplementation((options) => {
      if (options.url.endsWith('/options')) {
        respond(options, {
          data: { items: [{ ...site, employeeCoordinates: [30, 120] }], total: 1 },
        })
        return {} as UniApp.RequestTask
      }
      return normal(options)
    })
    await clock.load()
    expect(clock.state.sites).toEqual([])
    expect(clock.allowed('check_in')).toBe(false)
  })

  it.each(['oa', 'workflow'])(
    'waits for confirmed identity on a %s cold start and reliably loads the first badge once',
    async (feature) => {
      const auth = useAuthStore()
      auth.me = null
      const counts = useCountsStore()
      let identity: UniApp.RequestOptions | undefined
      vi.mocked(uni.request).mockImplementation((options) => {
        if (options.url.endsWith('/auth/me')) {
          identity = options
          calls.push({ url: '/auth/me', method: 'GET', data: undefined })
          return {} as UniApp.RequestTask
        }
        return normal(options)
      })
      counts.load()
      counts.load()
      const homeIdentity = auth.fetchMe()
      expect(calls.map((call) => call.url)).toEqual(['/auth/me'])
      expect([counts.todo, counts.running, counts.unread]).toEqual([null, null, null])
      respond(identity!, {
        data: {
          user: { id: 3 },
          perms: [],
          features: [feature],
          flags: { mustChangePassword: false, passwordExpired: false },
        },
      })
      await homeIdentity
      await vi.waitFor(() => expect(counts.unread).toBe(0))
      expect(calls.filter((call) => call.url === '/auth/me')).toHaveLength(1)
      expect(calls.filter((call) => call.url.startsWith('/wf/'))).toHaveLength(
        feature === 'workflow' ? 2 : 0,
      )
      expect(calls.filter((call) => call.url.includes('/messaging/'))).toHaveLength(1)
      expect([counts.todo, counts.running]).toEqual(feature === 'workflow' ? [0, 0] : [null, null])
    },
  )

  it('does not guess a package or request counts when identity fails; a later successful read restores first badges', async () => {
    const auth = useAuthStore()
    auth.me = null
    const counts = useCountsStore()
    let identity: UniApp.RequestOptions | undefined
    vi.mocked(uni.request).mockImplementation((options) => {
      if (options.url.endsWith('/auth/me')) {
        identity = options
        calls.push({ url: '/auth/me', method: 'GET', data: undefined })
        return {} as UniApp.RequestTask
      }
      return normal(options)
    })
    counts.load()
    const failed = auth.fetchMe()
    respond(identity!, { status: 503 })
    await expect(failed).rejects.toMatchObject({ status: 503 })
    expect(calls.map((call) => call.url)).toEqual(['/auth/me'])
    expect(auth.me).toBeNull()
    expect([counts.todo, counts.running, counts.unread]).toEqual([null, null, null])
    counts.load()
    const recovered = auth.fetchMe()
    respond(identity!, {
      data: {
        user: { id: 3 },
        perms: [],
        features: ['workflow'],
        flags: { mustChangePassword: false, passwordExpired: false },
      },
    })
    await recovered
    await vi.waitFor(() => expect(counts.todo).toBe(0))
    expect(calls.filter((call) => call.url.startsWith('/wf/'))).toHaveLength(2)
  })

  it.each(['old-first', 'new-first'])(
    'discards prior-account identity and navigation while preserving the new account flight: %s',
    async (order) => {
      const auth = useAuthStore()
      auth.me = null
      const counts = useCountsStore()
      const identities: UniApp.RequestOptions[] = []
      vi.mocked(uni.request).mockImplementation((options) => {
        if (options.url.endsWith('/auth/me')) {
          identities.push(options)
          return {} as UniApp.RequestTask
        }
        return normal(options)
      })
      counts.load()
      const old = auth.fetchMe()
      setSession({ accessToken: 'other', refreshToken: 'other-r', expiresIn: 1800 })
      counts.reset()
      counts.load()
      const next = auth.fetchMe()
      expect(identities).toHaveLength(2)
      const oldReply = () =>
        respond(identities[0], {
          data: {
            user: { id: 3 },
            perms: [],
            features: ['workflow'],
            flags: { mustChangePassword: true, passwordExpired: false },
          },
        })
      const newReply = () =>
        respond(identities[1], {
          data: {
            user: { id: 4 },
            perms: [],
            features: ['oa'],
            flags: { mustChangePassword: false, passwordExpired: false },
          },
        })
      if (order === 'old-first') {
        oldReply()
        await old
        const stillPending = auth.fetchMe()
        expect(identities).toHaveLength(2)
        newReply()
        await stillPending
      } else {
        newReply()
        await next
        oldReply()
        await old
      }
      await next
      await vi.waitFor(() => expect(counts.unread).toBe(0))
      expect((auth.me as MePayload | null)?.user.id).toBe(4)
      expect(calls.some((call) => call.url.startsWith('/wf/'))).toBe(false)
      expect(uni.reLaunch).not.toHaveBeenCalled()
    },
  )

  it('ignores old-session count answers even when an independent session end did not reset the store sequence', async () => {
    const auth = useAuthStore()
    auth.me = { features: ['workflow'] } as MePayload
    const counts = useCountsStore()
    const pending: UniApp.RequestOptions[] = []
    vi.mocked(uni.request).mockImplementation((options) => {
      pending.push(options)
      return {} as UniApp.RequestTask
    })
    counts.load()
    expect(pending).toHaveLength(3)
    setSession(null)
    for (const options of pending) respond(options, { data: { items: [], total: 9, unread: 9 } })
    await Promise.resolve()
    await Promise.resolve()
    expect([counts.todo, counts.running, counts.unread, counts.tick]).toEqual([null, null, null, 0])
  })

  it('drops a late GPS result after page disposal within the same session', async () => {
    today.policy.locationMode = 'site'
    const clock = controller()
    await clock.load()
    clock.state.siteId = 5
    const session = currentSessionVersion()
    let gps: UniApp.GetLocationOptions | undefined
    vi.mocked(uni.getLocation).mockImplementation((options) => {
      gps = options
    })
    const pending = clock.punch('check_in')
    try {
      await vi.waitFor(() => expect(gps).toBeDefined())
      clock.dispose()
      expect(currentSessionVersion()).toBe(session)
      expect(clock.state.today).toBeNull()
      expect(clock.state.siteId).toBe(0)
      gps!.success?.(position as UniApp.GetLocationSuccess)
      await pending
      expect(writes()).toHaveLength(0)
      expect(clock.state.today).toBeNull()
      expect(clock.state.siteId).toBe(0)
      expect(clock.state.items).toEqual([])
      expect(clock.state.busy).toBe(false)
      expect(clock.state.unresolved).toBe(false)
      expect(clock.state.message).toBe('')
      expect(clock.state.error).toBe('')
    } finally {
      clock.dispose()
      gps?.success?.(position as UniApp.GetLocationSuccess)
      await pending
    }
  })
})
