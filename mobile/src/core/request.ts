// uni.request wrapped (no request library). Envelope {code:0,msg,data} → data; failures → ApiError
// with the server's translated msg. The access token lives in memory only, the refresh token of the
// `mobile` session in uni storage (no HttpOnly cookie on mp/App) and travels in the /auth/refresh body. One
// refresh at a time with the web's rotation semantics (see docs/design-notes.md#auth-sessions); a rejected refresh sends the user to sign in.
import { Err, type ApiOk, type TokenPayload } from '@qiwu/shared'
import { locale, t } from './i18n'

/** Sign-in and refresh answers of a `mobile` session carry the refresh token too. */
export interface MobileTokens extends TokenPayload {
  refreshToken: string
}

export const LOGIN_PAGE = '/pages/login/index'
/** Where a session that must change its password goes (server 403 A1004; see docs/design-notes.md#auth-sessions). */
export const PASSWORD_PAGE = '/pages-sys/password/index'
/** Every request names the first-party client, so the server issues and rotates `mobile` sessions. */
export const CLIENT_HEADER = { 'X-Client-Id': 'mobile' }
/** H5 goes through the dev/preview proxy; mp-weixin and App need the full origin (`VITE_API_BASE=https://…/api`). */
const BASE: string = import.meta.env.VITE_API_BASE || '/api'
/** The API's origin ('' on H5: the page's own, through its proxy); also the realtime socket's. */
export const ORIGIN = BASE.match(/^https?:\/\/[^/]+/)?.[0] ?? ''
const TIMEOUT = 30_000
const RT_KEY = 'qw.auth.rt'
const NO_REFRESH = /^\/auth\/(login|refresh|sms\/login|wx-mp\/(login|bind))$/
// as on the web: a 400 belongs to the form, a 401 to the refresh / sign-in flow, a 404 to the page
const TOAST = new Set([403, 409, 422, 429])

interface ErrorBody {
  code?: string | number
  msg?: string
  errors?: { path: string; msg: string }[]
  traceId?: string
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | number,
    message: string,
    readonly errors?: ErrorBody['errors'],
    readonly traceId?: string,
  ) {
    super(message)
  }
}

/** What a form shows for a failed call: the server's translated message, else the network error. */
export const errorText = (e: unknown) =>
  e instanceof ApiError && e.status ? e.message : t('common.error.network')

/**
 * A server path (`/files/…`: the local storage's public objects, e.g. avatars) as the app loads it: H5 through
 * its proxy, mp-weixin and App from the API's origin. Full URLs (a CDN, S3) stay as they are.
 */
export const assetUrl = (url: string) => (url.startsWith('/') ? ORIGIN + url : url)

export interface RequestOptions {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** the body, or a GET's query */
  data?: string | object | ArrayBuffer
  /** no error toast and no redirect to sign-in: the caller handles errors (sign-in, sign-out, polling) */
  silent?: boolean
}
type Options = Pick<RequestOptions, 'silent'>

/** What uni.request and uni.uploadFile both answer. */
interface Raw {
  statusCode: number
  data: unknown
}

let accessToken = ''
/** Each sign-in / sign-out starts a new epoch: a refresh or replay of an older one never applies. */
let epoch = 0
let refreshing: Promise<void> | null = null
let redirecting = false

const storedRt = (): string => uni.getStorageSync(RT_KEY) || ''

/** Starts the session of a sign-in's tokens, or ends the session (null). */
export function setSession(tokens: MobileTokens | null) {
  epoch++
  accessToken = tokens?.accessToken ?? ''
  if (tokens) uni.setStorageSync(RT_KEY, tokens.refreshToken)
  else uni.removeStorageSync(RT_KEY)
}

/** The access token the next call sends ('' until a sign-in or refresh): the realtime handshake's. */
export const currentAccessToken = () => accessToken

/** A refresh token is stored: the session can resume without signing in. */
export const hasSession = () => !!storedRt()

function headers(): Record<string, string> {
  const h: Record<string, string> = { ...CLIENT_HEADER, 'Accept-Language': locale() }
  if (accessToken) h.Authorization = `Bearer ${accessToken}`
  const tz = globalThis.Intl?.DateTimeFormat().resolvedOptions().timeZone
  if (tz) h['X-Timezone'] = tz
  return h
}

const toast = (title: string) => uni.showToast({ title, icon: 'none' })

/** Once, and not from that page itself (several requests may fail together). */
function relaunch(url: string) {
  const pages = getCurrentPages()
  if (redirecting || `/${pages[pages.length - 1]?.route ?? ''}` === url) return
  redirecting = true
  uni.reLaunch({ url, complete: () => (redirecting = false) })
}
const toLogin = () => relaunch(LOGIN_PAGE)
/**
 * A must-change / expired password: the server answers only /auth/me, /auth/menus, the change and sign-out
 * (A1004), so the app waits on the change page (the auth store after /auth/me, the tab pages, any 403 A1004).
 */
export const toPasswordChange = () => relaunch(PASSWORD_PAGE)

/** Single-flight: concurrent 401s share one refresh, then each replays with the new access token. */
export function refreshAccessToken(): Promise<void> {
  if (refreshing) return refreshing
  const at = epoch
  const rt = storedRt()
  const run = rt
    ? request<MobileTokens>({
        url: '/auth/refresh',
        method: 'POST',
        data: { refreshToken: rt },
        silent: true,
      })
    : Promise.reject(new ApiError(401, Err.AUTH_REFRESH_REJECTED.code, 'not signed in'))
  refreshing = run
    .then((tokens) => {
      // signed in / out meanwhile: the tokens belong to the previous session
      if (at !== epoch) return
      accessToken = tokens.accessToken
      uni.setStorageSync(RT_KEY, tokens.refreshToken)
    })
    .catch((e: unknown) => {
      // the server rejected the refresh token (a network error, 429 or 5xx keeps it)
      if (at === epoch && e instanceof ApiError && e.status === 401) setSession(null)
      throw e
    })
    .finally(() => (refreshing = null))
  return refreshing
}

async function exchange<T>(o: RequestOptions, send: () => Promise<Raw>, replay = false): Promise<T> {
  const at = epoch
  const sent = accessToken
  let res: Raw
  try {
    res = await send()
  } catch (e) {
    if (!o.silent) toast(t('common.error.network'))
    throw new ApiError(0, 'network', (e as { errMsg?: string } | null)?.errMsg ?? String(e))
  }
  const body = (res.data && typeof res.data === 'object' ? res.data : {}) as ErrorBody &
    Partial<ApiOk<T>>
  if (res.statusCode < 300 && body.code === 0) return body.data as T
  const err = new ApiError(
    res.statusCode,
    body.code ?? res.statusCode,
    body.msg || `HTTP ${res.statusCode}`,
    body.errors,
    body.traceId,
  )
  // a request of an earlier session (signed out, or in as someone else since) is never refreshed or replayed
  if (res.statusCode === 401 && !replay && !NO_REFRESH.test(o.url) && at === epoch) {
    try {
      // sent with an older token: that refresh already happened, only replay
      if (!accessToken || sent === accessToken) await refreshAccessToken()
    } catch (e) {
      if (!o.silent) {
        if (e instanceof ApiError && e.status === 401) toLogin()
        else toast(t('common.error.network'))
      }
      throw err
    }
    if (at === epoch) return exchange<T>(o, send, true)
  }
  if (!o.silent && err.code === Err.AUTH_PASSWORD_CHANGE_REQUIRED.code) {
    // not for a late answer of an earlier session
    if (at === epoch) toPasswordChange()
  } else if (!o.silent && (TOAST.has(err.status) || err.status >= 500)) toast(err.message)
  throw err
}

/** A JSON API call: resolves to the envelope's `data`, rejects with ApiError (status 0 = no answer). */
export const request = <T>(o: RequestOptions) =>
  exchange<T>(
    o,
    () =>
      new Promise<Raw>((resolve, reject) =>
        uni.request({
          url: BASE + o.url,
          method: o.method ?? 'GET',
          data: o.data,
          header: headers(),
          timeout: TIMEOUT,
          success: resolve,
          fail: reject,
        }),
      ),
  )

export const api = {
  get: <T>(url: string, query?: object, o?: Options) => request<T>({ ...o, url, data: query }),
  post: <T>(url: string, data?: object, o?: Options) =>
    request<T>({ ...o, url, method: 'POST', data }),
  put: <T>(url: string, data?: object, o?: Options) =>
    request<T>({ ...o, url, method: 'PUT', data }),
  delete: <T>(url: string, o?: Options) => request<T>({ ...o, url, method: 'DELETE' }),
}

function json(text: unknown): unknown {
  try {
    return typeof text === 'string' ? JSON.parse(text) : text
  } catch {
    return null
  }
}

/** An upload has no form: its 400 / 404 / 413 (over storage.max_size_mb) / 415 are toasted too, as on the web. */
const UPLOAD_TOAST = new Set([400, 404, 413, 415])

/** Upload through the backend (uni.uploadFile, no presigned direct upload); field `file`. */
export const upload = <T>(url: string, filePath: string, formData?: object, o?: Options) =>
  exchange<T>(
    { ...o, url, method: 'POST' },
    () =>
      new Promise<Raw>((resolve, reject) =>
        uni.uploadFile({
          url: BASE + url,
          filePath,
          name: 'file',
          formData,
          header: headers(),
          timeout: TIMEOUT,
          success: (r) => resolve({ statusCode: r.statusCode, data: json(r.data) }),
          fail: reject,
        }),
      ),
  ).catch((e: unknown) => {
    if (!o?.silent && e instanceof ApiError && UPLOAD_TOAST.has(e.status)) toast(e.message)
    throw e
  })
