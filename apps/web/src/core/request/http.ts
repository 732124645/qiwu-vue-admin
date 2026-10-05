import axios, {
  AxiosError,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
// service APIs are not in templates, so the on-demand resolver does not add their styles
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import { Err, type ApiOk, type Page, type TokenPayload } from '@qiwu/shared'
import { currentLocale, i18n } from '@/core/i18n'
import router from '@/core/router'

declare module 'axios' {
  interface AxiosRequestConfig {
    /** no error toast and no "session expired" dialog (the caller handles errors itself) */
    silent?: boolean
    /** internal: already replayed after a refresh */
    _retried?: boolean
    /** internal: session epoch the request was sent under */
    _epoch?: number
  }
}

/** Error envelope (see docs/design-notes.md#api-envelope): `msg` is already translated by the server. */
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

/** Access token, memory only (see docs/design-notes.md#auth-sessions); the refresh token is an HttpOnly cookie. */
export const accessToken = ref('')

/** Session epoch: each sign-in / sign-out starts a new one; refreshes and replays of an older one never apply. */
let epoch = 0

/**
 * The server's permission version of this session (permVer; see docs/design-notes.md#permissions): the latest `X-Perm-Ver`
 * of a signed-in answer, '' until the first one. It moves when roles, grants, menus or the user's dept
 * change; the router then reloads `/me` and `/menus` (`reloadOnPermChange`).
 */
export const permVer = ref('')
/** Signed-in answers carrying a version so far: each lets a reload that failed try again. */
export const permVerAnswers = ref(0)

/** `a` is a later `<user>.<all>` version than `b` (both counters only grow). */
function later(a: string, b: string) {
  const [x = 0, y = 0] = a.split('.').map(Number)
  const [u = 0, w = 0] = b.split('.').map(Number)
  return x > u || y > w
}

/** Keeps the latest version seen; an answer of an earlier session or an older in-flight request is ignored. */
function notePermVer(config: InternalAxiosRequestConfig, headers: AxiosResponse['headers']) {
  const ver: unknown = headers?.['x-perm-ver']
  if (typeof ver !== 'string' || !ver || config._epoch !== epoch) return
  if (!permVer.value || later(ver, permVer.value)) permVer.value = ver
  permVerAnswers.value++
}

/** The current session epoch: work started under another one must not apply its results. */
export const sessionEpoch = () => epoch

/** Drops the access token and starts a new session epoch (sign-in, sign-out). */
export function resetSession() {
  epoch++
  accessToken.value = ''
  permVer.value = ''
}

export const http = axios.create({ baseURL: '/api', timeout: 30_000 })

http.interceptors.request.use((config) => {
  config._epoch = epoch
  if (accessToken.value) config.headers.Authorization = `Bearer ${accessToken.value}`
  config.headers['Accept-Language'] = currentLocale()
  config.headers['X-Request-Id'] = crypto.randomUUID()
  config.headers['X-Timezone'] = Intl.DateTimeFormat().resolvedOptions().timeZone
  return config
})

/**
 * Non-secret hint that this browser may hold a refresh cookie: set on sign-in, dropped on sign-out and when
 * the server rejects a refresh. Without it the silent refresh is skipped, so a signed-out visit makes no
 * failing call. localStorage outlives the tab like a persistent ("keep me signed in") cookie does.
 */
const HINT = 'qw.auth.session'
export function setSessionHint(on: boolean) {
  try {
    if (on) localStorage.setItem(HINT, '1')
    else localStorage.removeItem(HINT)
  } catch {
    // storage blocked: the refresh is always tried, as without the hint
  }
}
function sessionHint() {
  try {
    return localStorage.getItem(HINT) !== null
  } catch {
    return true
  }
}

/**
 * No answer, throttled or a server/gateway error (the API restarting, a rolling deploy): the session may
 * well live on, so it is no reason to sign in again; only a 401 says the session is over.
 */
export function isTransient(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 429 || e.status >= 500
  return axios.isAxiosError(e) && !e.response && !axios.isCancel(e)
}

let refreshing: Promise<void> | null = null

/** Single-flight in this tab, serialized across tabs (Web Locks) so each refresh sends the latest cookie. */
export function refreshAccessToken(): Promise<void> {
  if (refreshing) return refreshing
  if (!sessionHint())
    return Promise.reject(new ApiError(401, Err.AUTH_REFRESH_REJECTED.code, 'not signed in'))
  const at = epoch
  const run = async () => {
    const res = await http.post<ApiOk<TokenPayload>>('/auth/refresh', null, {
      withCredentials: true,
      silent: true,
    })
    // signed in / out meanwhile: the token belongs to the previous session
    if (epoch === at) accessToken.value = res.data.data.accessToken
  }
  refreshing = (navigator.locks ? navigator.locks.request('qw.auth.refresh', run) : run())
    .catch((e: unknown) => {
      if (epoch === at) {
        accessToken.value = ''
        // the server rejected the cookie (a network error, 429 or 5xx keeps the hint)
        if (e instanceof ApiError && e.status === 401) setSessionHint(false)
      }
      throw e
    })
    .finally(() => (refreshing = null))
  return refreshing
}

/** Sign-in / sign-out first let an in-flight refresh land, so its Set-Cookie never overwrites theirs. */
export async function refreshSettled() {
  await refreshing?.catch(() => undefined)
}

const t = (key: string) => i18n.global.t(key)
/** one toast per text: a burst of failing requests (the API restarting, the guard's retries) shows a count */
const toast = (message: string) => ElMessage.error({ message, grouping: true })
let expiredDialog = false

/** Refresh failed while the user is on a page: keep the page (unsaved form) or sign in and come back. */
async function sessionExpired() {
  const { matched, meta } = router.currentRoute.value
  // first load (nothing matched yet) and public pages: the router guard sends the user to /login
  if (expiredDialog || !matched.length || meta.public) return
  expiredDialog = true
  try {
    await ElMessageBox.confirm(t('common.session.expired'), t('common.session.expiredTitle'), {
      type: 'warning',
      confirmButtonText: t('common.session.signInAgain'),
      cancelButtonText: t('common.session.stay'),
    })
    await router.push({ path: '/login', query: { redirect: router.currentRoute.value.fullPath } })
  } catch {
    // "stay": keep the page as it is
  } finally {
    expiredDialog = false
  }
}

const NO_REFRESH = /^\/auth\/(login|refresh)$/
const TOAST = new Set([403, 409, 422, 429])

async function bodyOf(data: unknown): Promise<ErrorBody> {
  // blob requests (download/fetchBlob) carry JSON error envelopes as Blob
  if (data instanceof Blob) {
    try {
      return JSON.parse(await data.text()) as ErrorBody
    } catch {
      return {}
    }
  }
  return (data ?? {}) as ErrorBody
}

http.interceptors.response.use(
  (res) => {
    notePermVer(res.config, res.headers)
    return res
  },
  async (error: AxiosError) => {
    const { config, response } = error
    if (!config || !response) {
      if (!axios.isCancel(error) && !config?.silent) toast(t('common.error.network'))
      throw error
    }
    // a 403 of a perm just taken away carries the new version too
    notePermVer(config, response.headers)
    const body = await bodyOf(response.data)
    const err = new ApiError(
      response.status,
      body.code ?? response.status,
      // no envelope: a proxy or gateway answered (502 while the API restarts), not the API
      body.msg ?? t('common.error.network'),
      body.errors,
      body.traceId,
    )

    // a request of an earlier session (signed out, or in as someone else since) is never refreshed or replayed
    if (
      response.status === 401 &&
      !config._retried &&
      !NO_REFRESH.test(config.url ?? '') &&
      config._epoch === epoch
    ) {
      // a request sent with an older token only needs the replay; the refresh already happened
      const sent = config.headers.Authorization
      try {
        if (!accessToken.value || sent === `Bearer ${accessToken.value}`) await refreshAccessToken()
      } catch (e) {
        // the refresh got no answer: the session may live on, so say that, not "signed out" (a 401)
        if (isTransient(e)) {
          if (!config.silent) toast(t('common.error.network'))
          throw e
        }
        // silent callers handle an ended session themselves (sign-out, the lock screen)
        if (!config.silent) void sessionExpired()
        throw err
      }
      if (config._epoch === epoch) return http.request({ ...config, _retried: true })
    }

    if (err.code === Err.AUTH_PASSWORD_CHANGE_REQUIRED.code) {
      if (router.currentRoute.value.path !== '/password-change')
        void router.push('/password-change')
    } else if (!config.silent && (TOAST.has(err.status) || err.status >= 500)) {
      toast(err.message)
    }
    throw err
  },
)

async function unwrap<T>(p: Promise<AxiosResponse<ApiOk<T>>>): Promise<T> {
  const { data: body, status } = await p
  if (body.code !== 0) {
    const e = body as unknown as ErrorBody
    throw new ApiError(status, e.code ?? status, e.msg ?? '', e.errors, e.traceId)
  }
  return body.data
}

/** JSON API calls: resolve to the envelope's `data`, reject with `ApiError`. */
export const api = {
  get: <T>(url: string, config?: AxiosRequestConfig) => unwrap<T>(http.get(url, config)),
  delete: <T>(url: string, config?: AxiosRequestConfig) => unwrap<T>(http.delete(url, config)),
  post: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    unwrap<T>(http.post(url, data, config)),
  put: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    unwrap<T>(http.put(url, data, config)),
}

/** Authenticated binary GET, e.g. private file previews: `URL.createObjectURL(await fetchBlob(url))`. */
export async function fetchBlob(
  url: string,
  params?: Record<string, unknown>,
  config?: AxiosRequestConfig,
): Promise<Blob> {
  return (await http.get<Blob>(url, { ...config, params, responseType: 'blob' })).data
}

/** Authenticated file download (exports, templates) saved as `filename`; `config` e.g. a longer timeout. */
export async function download(
  url: string,
  params: Record<string, unknown>,
  filename: string,
  config?: AxiosRequestConfig,
) {
  saveBlob(await fetchBlob(url, params, config), filename)
}

/** Hands `blob` to the browser as a download named `filename` (e.g. a JSON built in the page). */
export function saveBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(href), 10_000)
}

/**
 * The standard endpoints of one resource (see docs/design-notes.md#api-envelope) under `base`, e.g. `crudApi<PositionVo>('/iam/positions')`:
 * list `GET base` → `{ items, total }`, `GET base/:id`, `POST base`, `PUT base/:id`, and remove = one id →
 * `DELETE base/:id`, several → `POST base/batch-delete { ids }`, `GET base/export` (.xlsx). Module-specific
 * actions sit next to it.
 */
export interface CrudApi<T, C = Partial<T>> {
  page: (params: Record<string, unknown>) => Promise<Page<T>>
  get: (id: number) => Promise<T>
  create: (dto: C) => Promise<unknown>
  update: (id: number, dto: C) => Promise<unknown>
  remove: (ids: number[]) => Promise<unknown>
  /** `GET base/export` with the list's filters and sort, saved as `filename` (.xlsx) */
  exportFile: (params: Record<string, unknown>, filename: string) => Promise<void>
}

export function crudApi<T, C = Partial<T>>(base: string): CrudApi<T, C> {
  return {
    page: (params) => api.get<Page<T>>(base, { params }),
    get: (id) => api.get<T>(`${base}/${id}`),
    create: (dto) => api.post(base, dto),
    update: (id, dto) => api.put(`${base}/${id}`, dto),
    remove: (ids) =>
      ids.length === 1
        ? api.delete(`${base}/${ids[0]}`)
        : api.post(`${base}/batch-delete`, { ids }),
    exportFile: (params, filename) => download(`${base}/export`, params, filename),
  }
}

/** A tree row as `GET base` of a tree resource answers it: the row plus its children, recursively. */
export type TreeRow<T> = T & { children: TreeRow<T>[] }

/**
 * The endpoints of a tree resource (docs/codegen-golden.md "Tree") under `base`, e.g.
 * `treeApi<DeptVo, DeptCreate>('/iam/depts')`: `GET base` → the whole filtered forest (no paging), `GET base/:id`,
 * `POST base`, `PUT base/:id`, `DELETE base/:id` (one node at a time). Fits `useCrudForm` like `crudApi`.
 */
export interface TreeApi<T, C = Partial<T>> {
  list: (params: Record<string, unknown>) => Promise<TreeRow<T>[]>
  get: (id: number) => Promise<T>
  create: (dto: C) => Promise<unknown>
  update: (id: number, dto: C) => Promise<unknown>
  remove: (id: number) => Promise<unknown>
}

export function treeApi<T, C = Partial<T>>(base: string): TreeApi<T, C> {
  return {
    list: (params) => api.get<TreeRow<T>[]>(base, { params }),
    get: (id) => api.get<T>(`${base}/${id}`),
    create: (dto) => api.post(base, dto),
    update: (id, dto) => api.put(`${base}/${id}`, dto),
    remove: (id) => api.delete(`${base}/${id}`),
  }
}
