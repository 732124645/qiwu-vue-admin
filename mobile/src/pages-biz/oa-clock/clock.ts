import { reactive, watch } from 'vue'
import { z } from 'zod'
import {
  attendanceSiteOptionQuery,
  attendanceSiteSnapshot,
  clockMyQuery,
  clockPunch,
  clockRecordVo,
  clockTodayVo,
  type AttendanceSiteSnapshot,
  type ClockAction,
  type ClockPunch,
  type ClockRecordVo,
  type ClockTodayVo,
} from '@qiwu/shared'
import { FEATURE, hasFeature } from '@/core/features'
import { locale, t } from '@/core/i18n'
import { ApiError, api, currentSessionVersion, errorText, sessionVersion } from '@/core/request'

const BASE = '/oa/clock-records'
const PAGE_SIZE = 20
const recordPage = z.strictObject({
  items: clockRecordVo.strict().array().max(200),
  total: z.number().int().nonnegative(),
})
const sitePage = z.strictObject({
  items: attendanceSiteSnapshot.strict().array().max(200),
  total: z.number().int().nonnegative(),
})
const nonce = () =>
  `clock_${Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`

/** 只从服务器工作日推导日历范围，不使用设备当前日期决定考勤归属。 */
export function clockRange(month: string, day?: string) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error(t('clock.invalidMonth'))
  const last = new Date(`${month}-01T00:00:00.000Z`)
  last.setUTCMonth(last.getUTCMonth() + 1)
  last.setUTCDate(0)
  const end = last.toISOString().slice(0, 10)
  if (day) {
    if (!z.iso.date().safeParse(day).success || !day.startsWith(`${month}-`))
      throw new Error(t('clock.invalidMonth'))
    return { workDateFrom: day, workDateTo: day }
  }
  return { workDateFrom: `${month}-01`, workDateTo: end }
}

/** 时间按记录的规则时区显示；旧运行时不支持 IANA 时区时明确回退 UTC。 */
export function clockTime(record: ClockRecordVo | null) {
  if (!record) return t('clock.noRecord')
  try {
    return new Intl.DateTimeFormat(locale(), {
      timeZone: record.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(record.punchedAt))
  } catch {
    return record.punchedAt.replace('T', ' ').replace('Z', ' UTC')
  }
}

/** 近端校验改善反馈，服务端仍会按锁内最新规则重新校验距离与精度。 */
export function validateClockPosition(
  site: AttendanceSiteSnapshot,
  result: Pick<UniApp.GetLocationSuccess, 'latitude' | 'longitude' | 'accuracy'> & {
    horizontalAccuracy?: number
  },
) {
  const accuracyM =
    Number.isFinite(result.horizontalAccuracy) && result.horizontalAccuracy! > 0
      ? result.horizontalAccuracy!
      : result.accuracy
  const { latitude, longitude } = result
  if (
    ![latitude, longitude, accuracyM].every(Number.isFinite) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    accuracyM <= 0
  )
    throw new Error(t('clock.locationInvalid'))
  if (accuracyM > site.maxAccuracyM)
    throw new Error(t('clock.locationAccuracy', { max: site.maxAccuracyM }))
  const rad = (value: number) => (value * Math.PI) / 180
  const lat = rad(latitude - Number(site.latitude))
  const lng = rad(longitude - Number(site.longitude))
  const hav =
    Math.sin(lat / 2) ** 2 +
    Math.cos(rad(latitude)) * Math.cos(rad(Number(site.latitude))) * Math.sin(lng / 2) ** 2
  const distance =
    6371000 * 2 * Math.atan2(Math.sqrt(Math.min(1, hav)), Math.sqrt(Math.max(0, 1 - hav)))
  if (distance > site.radiusM) throw new Error(t('clock.locationOutside'))
  return clockPunch.shape.position
    .unwrap()
    .parse({ siteId: site.id, latitude, longitude, accuracyM })
}

/** 定位只从用户的打卡动作触发，既不监听后台位置，也不保存坐标。 */
async function locate(site: AttendanceSiteSnapshot) {
  if (typeof uni.getLocation !== 'function') throw new Error(t('clock.locationUnavailable'))
  const result = await new Promise<UniApp.GetLocationSuccess>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('clock.locationUnavailable'))), 20_000)
    uni.getLocation({
      type: 'wgs84',
      isHighAccuracy: true,
      highAccuracyExpireTime: 8000,
      success: (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      fail: (error: unknown) => {
        clearTimeout(timer)
        const message = String((error as { errMsg?: string })?.errMsg ?? '')
        reject(
          new Error(
            t(
              /deny|denied|permission|authorize/i.test(message)
                ? 'clock.locationDenied'
                : 'clock.locationUnavailable',
            ),
          ),
        )
      },
    })
  })
  return validateClockPosition(site, result)
}

/** 页面控制器保存一次待确认请求，只有明确的用户动作才可能发起写操作。 */
export function useClock() {
  const state = reactive({
    today: null as ClockTodayVo | null,
    sites: [] as AttendanceSiteSnapshot[],
    siteTotal: 0,
    sitePage: 1,
    siteId: 0,
    busy: false,
    loadingRecords: false,
    error: '',
    message: '',
    unresolved: false,
    retryable: false,
    pendingAction: null as ClockAction | null,
    month: '',
    day: '',
    page: 1,
    items: [] as ClockRecordVo[],
    total: 0,
  })
  let pending: { body: ClockPunch; workDate: string } | null = null
  let operation = 0
  let recordsSequence = 0
  let sitesSequence = 0
  const current = (session: number, mine: number) =>
    session === currentSessionVersion() && mine === operation
  function clearPending() {
    if (pending) delete pending.body.position
    pending = null
    state.unresolved = false
    state.retryable = false
    state.pendingAction = null
  }
  /** 换身份立即清理位置、nonce 和旧页面；网络/定位的迟到回调不能恢复它们。 */
  function reset() {
    operation++
    recordsSequence++
    sitesSequence++
    clearPending()
    Object.assign(state, {
      today: null,
      sites: [],
      siteTotal: 0,
      sitePage: 1,
      siteId: 0,
      busy: false,
      loadingRecords: false,
      error: '',
      message: '',
      month: '',
      day: '',
      page: 1,
      items: [],
      total: 0,
    })
  }
  const stop = watch(sessionVersion, reset, { flush: 'sync' })
  function allowed(action: ClockAction) {
    const today = state.today
    return (
      hasFeature(FEATURE.oa) &&
      !state.busy &&
      !state.unresolved &&
      !!today?.policy.enabled &&
      (action === 'check_in' ? !today.checkIn : !!today.checkIn && !today.checkOut)
    )
  }
  async function readToday(session: number, mine: number) {
    const today = clockTodayVo
      .strict()
      .parse(await api.get(`${BASE}/today`, undefined, { silent: true }))
    if (!current(session, mine)) return null
    if (
      (today.checkIn &&
        (today.checkIn.action !== 'check_in' || today.checkIn.workDate !== today.workDate)) ||
      (today.checkOut &&
        (today.checkOut.action !== 'check_out' || today.checkOut.workDate !== today.workDate))
    )
      throw new Error(t('clock.unavailable'))
    state.today = today
    if (!state.month) state.month = today.workDate.slice(0, 7)
    return today
  }
  async function loadSites(page = 1) {
    if (!hasFeature(FEATURE.oa) || state.today?.policy.locationMode !== 'site') return
    const session = currentSessionVersion()
    const seq = ++sitesSequence
    const query = { page, pageSize: 200 }
    attendanceSiteOptionQuery.parse(query)
    const result = sitePage.parse(
      await api.get('/oa/attendance-sites/options', query, { silent: true }),
    )
    if (session !== currentSessionVersion() || seq !== sitesSequence) return
    state.sites = page === 1 ? result.items : [...state.sites, ...result.items]
    state.siteTotal = result.total
    state.sitePage = page
    if (!state.sites.some((site) => site.id === state.siteId)) state.siteId = 0
  }
  async function records(page = 1) {
    if (!hasFeature(FEATURE.oa) || !state.month) return
    const session = currentSessionVersion()
    const seq = ++recordsSequence
    state.loadingRecords = true
    try {
      const query = {
        page,
        pageSize: PAGE_SIZE,
        ...clockRange(state.month, state.day || undefined),
        sort: '-punchedAt,-id',
      }
      clockMyQuery.parse(query)
      const result = recordPage.parse(await api.get(`${BASE}/mine`, query, { silent: true }))
      if (session !== currentSessionVersion() || seq !== recordsSequence) return
      state.items = result.items
      state.total = result.total
      state.page = page
    } catch (cause) {
      if (session === currentSessionVersion() && seq === recordsSequence) {
        state.items = []
        state.total = 0
        state.error = cause instanceof ApiError ? errorText(cause) : t('clock.invalidMonth')
      }
    } finally {
      if (session === currentSessionVersion() && seq === recordsSequence)
        state.loadingRecords = false
    }
  }
  async function load() {
    if (state.busy) return
    if (!hasFeature(FEATURE.oa)) {
      reset()
      state.error = t('clock.unavailable')
      return
    }
    const session = currentSessionVersion()
    const mine = ++operation
    state.busy = true
    state.error = ''
    try {
      if (!(await readToday(session, mine))) return
      await loadSites()
      await records()
    } catch (cause) {
      if (current(session, mine)) {
        state.today = null
        state.error = errorText(cause)
      }
    } finally {
      if (current(session, mine)) state.busy = false
    }
  }
  /** 不确定结果先查本人请求，再刷新今日；任何查询失败都不开放新动作。 */
  async function reconcile(session: number, mine: number) {
    const original = pending
    if (!original) return false
    state.retryable = false
    let found: ClockRecordVo | null = null
    try {
      found = clockRecordVo
        .strict()
        .parse(
          await api.get(`${BASE}/requests/${original.body.requestId}`, undefined, { silent: true }),
        )
      if (found.requestId !== original.body.requestId || found.action !== original.body.action)
        throw new Error(t('clock.unavailable'))
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 404)) throw cause
    }
    if (!current(session, mine) || pending !== original) return false
    const today = await readToday(session, mine)
    if (!today || pending !== original) return false
    if (found) {
      clearPending()
      state.message = t('clock.confirmed', { date: found.workDate, time: clockTime(found) })
      await records()
      return false
    }
    if (today.workDate !== original.workDate) {
      clearPending()
      state.error = t('clock.dayChanged')
      return false
    }
    const existing = original.body.action === 'check_in' ? today.checkIn : today.checkOut
    if (existing) {
      clearPending()
      state.message = t('clock.confirmed', { date: existing.workDate, time: clockTime(existing) })
      await records()
      return false
    }
    state.retryable = true
    return true
  }
  async function send(session: number, mine: number) {
    const original = pending
    if (!original) return
    try {
      const record = clockRecordVo
        .strict()
        .parse(await api.post(`${BASE}/punch`, original.body, { silent: true, retryAuth: false }))
      if (!current(session, mine) || pending !== original) return
      if (record.requestId !== original.body.requestId || record.action !== original.body.action)
        throw new Error(t('clock.unavailable'))
      clearPending()
      state.message = t('clock.confirmed', { date: record.workDate, time: clockTime(record) })
      state.today = null
      await readToday(session, mine)
      await records()
    } catch (cause) {
      if (!current(session, mine)) return
      state.error = cause instanceof ApiError ? errorText(cause) : t('clock.uncertain')
      if (!pending) return
      try {
        const absent = await reconcile(session, mine)
        if (absent && cause instanceof ApiError && [400, 403, 404, 422].includes(cause.status))
          clearPending()
      } catch {
        if (current(session, mine)) state.error = t('clock.uncertain')
      }
    }
  }
  async function punch(action: ClockAction) {
    if (!allowed(action)) return
    const session = currentSessionVersion()
    const mine = ++operation
    state.busy = true
    state.error = ''
    state.message = ''
    try {
      const today = await readToday(session, mine)
      if (
        !today ||
        !today.policy.enabled ||
        (action === 'check_in' ? !!today.checkIn : !today.checkIn || !!today.checkOut)
      )
        return
      let position: ClockPunch['position']
      if (today.policy.locationMode === 'site') {
        const site = state.sites.find((entry) => entry.id === state.siteId)
        if (!site) throw new Error(t('clock.siteRequired'))
        position = await locate(site)
        if (!current(session, mine)) return
        const fresh = await readToday(session, mine)
        if (!fresh || fresh.workDate !== today.workDate) throw new Error(t('clock.dayChanged'))
      }
      if (!current(session, mine)) return
      const body = clockPunch.parse({
        action,
        requestId: nonce(),
        ...(position ? { position } : {}),
      })
      pending = { body, workDate: today.workDate }
      state.unresolved = true
      state.pendingAction = action
      await send(session, mine)
    } catch (cause) {
      if (current(session, mine))
        state.error = cause instanceof ApiError ? errorText(cause) : (cause as Error).message
    } finally {
      if (current(session, mine)) state.busy = false
    }
  }
  /** 重查不写；人工重试也先重查，再使用同一 nonce 和原始参数，不重新定位。 */
  async function resolve(retry = false) {
    if (state.busy || !pending || !hasFeature(FEATURE.oa)) return
    const session = currentSessionVersion()
    const mine = ++operation
    state.busy = true
    state.error = ''
    try {
      if ((await reconcile(session, mine)) && retry && current(session, mine))
        await send(session, mine)
    } catch {
      if (current(session, mine)) state.error = t('clock.uncertain')
    } finally {
      if (current(session, mine)) state.busy = false
    }
  }
  return {
    state,
    allowed,
    load,
    loadSites,
    records,
    punch,
    resolve,
    dispose: () => {
      stop()
      reset()
    },
  }
}
