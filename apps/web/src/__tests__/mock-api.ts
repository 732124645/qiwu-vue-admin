// Test helper (not a spec): fake backend for the shared axios instance, keyed by "METHOD /url".
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import type { MePayload, MenuNode } from '@qiwu/shared'
import { http } from '@/core/request/http'

type Reply = [status: number, body: unknown, headers?: Record<string, string>]
export type Route = Reply | ((config: InternalAxiosRequestConfig) => Reply | Promise<Reply>)

export const ok = (data: unknown): Reply => [200, { code: 0, msg: 'ok', data }]
export const fail = (status: number, code: string, msg = `error ${code}`): Reply => [
  status,
  { code, msg, data: null, traceId: 't-1' },
]

/** Installs the fake backend; returns the list of requests it received. */
export function mockApi(routes: Record<string, Route>) {
  const calls: InternalAxiosRequestConfig[] = []
  http.defaults.adapter = async (config) => {
    calls.push(config)
    const route = routes[`${config.method?.toUpperCase()} ${config.url}`]
    const [status, data, headers = {}] = !route
      ? fail(404, 'A0440')
      : typeof route === 'function'
        ? await route(config)
        : route
    const response = { data, status, statusText: String(status), headers, config }
    if (status >= 400)
      throw new AxiosError(`status ${status}`, 'ERR_BAD_REQUEST', config, {}, response)
    return response
  }
  return calls
}

export const me = (perms: string[], flags = {}): MePayload => ({
  user: {
    id: 1,
    username: 'admin',
    displayName: 'Admin',
    avatarUrl: null,
    deptId: null,
    deptName: null,
    roleNames: ['seed.role.root'],
    locale: null,
    timezone: null,
  },
  roles: ['root'],
  perms,
  flags: { mustChangePassword: false, passwordExpired: false, ...flags },
  policy: { minLength: 8, charClasses: 2, expireDays: 0 },
  lastSignInAt: null,
})

export const node = (p: Partial<MenuNode> & Pick<MenuNode, 'id' | 'routePath'>): MenuNode => ({
  parentId: 0,
  kind: 'page',
  name: `menu.m${p.id}`,
  nameI18n: null,
  routeName: null,
  component: null,
  componentName: null,
  routeQuery: null,
  linkType: 'route',
  linkUrl: null,
  icon: null,
  visible: true,
  keepAlive: false,
  alwaysShow: false,
  sortNo: 0,
  children: [],
  ...p,
})
