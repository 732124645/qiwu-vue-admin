import { watch, type WatchStopHandle } from 'vue'
import {
  createRouter,
  createWebHistory,
  type RouteLocationNormalized,
  type Router,
  type RouteRecordRaw,
  type RouterHistory,
} from 'vue-router'
import type { I18nText, MePayload, MenuNode } from '@qiwu/shared'
import { i18n, localized } from '@/core/i18n'
import { api, isTransient, permVer, permVerAnswers, sessionEpoch } from '@/core/request/http'
import { appSettings } from '@/core/stores/app'
import { useAuthStore } from '@/core/stores/auth'
import { useMenuStore } from '@/core/stores/menu'
import { useTagsStore } from '@/core/stores/tags'

declare module 'vue-router' {
  interface RouteMeta {
    /** reachable without signing in */
    public?: boolean
    /** i18n key or plain text (admin-created menus); rendered with `localized(titleI18n, title)` */
    title?: string
    titleI18n?: I18nText | null
    icon?: string | null
    /** `visible=0` menu rows: routable but not in the side menu */
    hidden?: boolean
    keepAlive?: boolean
    /** keep-alive cache name: the page component's `name` (menu `component_name`) */
    componentName?: string | null
    /**
     * the menu's view under src/views (`biz/leave/view`): the approval center finds a process's business
     * page by the model's `view_component`
     */
    component?: string | null
    /** permission points, any of (routes outside the menu tree) */
    perm?: string | string[]
    menuId?: number
    /** iframe pages: the framed URL (AppLayout shows it) */
    linkUrl?: string | null
  }
}

export const LAYOUT = 'layout'
const ErrorView = () => import('@/views/error/ErrorView.vue')

export const staticRoutes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/login/index.vue'),
    meta: { public: true, title: 'common.login.title' },
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('@/views/register/index.vue'),
    meta: { public: true, title: 'auth.signup.title' },
  },
  {
    path: '/password-reset',
    name: 'password-reset',
    component: () => import('@/views/password-reset/index.vue'),
    meta: { public: true, title: 'auth.reset.title' },
  },
  {
    path: '/password-change',
    name: 'password-change',
    component: () => import('@/views/password-change/index.vue'),
    meta: { title: 'common.passwordChange.title' },
  },
  // lock screen: outside the layout, needs the session (see docs/design-notes.md#layering)
  {
    path: '/lock',
    name: 'lock',
    component: () => import('@/views/lock/index.vue'),
    meta: { title: 'layout.lock.title' },
  },
  // OAuth2 consent: outside the layout, needs the session; signing in comes back here (?redirect=)
  {
    path: '/sso',
    name: 'sso',
    component: () => import('@/views/sso/index.vue'),
    meta: { title: 'oauth.sso.title' },
  },
  {
    path: '/403',
    name: '403',
    component: ErrorView,
    props: { status: 403 },
    meta: { public: true, title: '403' },
  },
  {
    path: '/404',
    name: '404',
    component: ErrorView,
    props: { status: 404 },
    meta: { public: true, title: '404' },
  },
  // the API did not answer the first load (a restart, a deploy): retry from here, no new sign-in
  {
    path: '/503',
    name: '503',
    component: ErrorView,
    props: { status: 503 },
    meta: { public: true, title: '503' },
  },
  {
    path: '/',
    name: LAYOUT,
    component: () => import('@/core/layout/AppLayout.vue'),
    children: [
      {
        path: '/redirect/:path(.*)',
        name: 'redirect',
        component: () => import('@/views/redirect/index.vue'),
      },
      // personal center: any signed-in user, not a menu page (see docs/design-notes.md#layering)
      {
        path: '/profile',
        name: 'profile',
        component: () => import('@/views/profile/index.vue'),
        meta: { title: 'profile.title', icon: 'lucide:user-round' },
      },
      {
        path: '/inbox',
        name: 'my-inbox',
        component: () => import('@/views/platform/messaging/inbox-mine/index.vue'),
        meta: { title: 'notify.inbox.pageTitle', icon: 'lucide:inbox' },
      },
    ],
  },
  // not public: an unknown path may be a menu route that is registered after sign-in
  { path: '/:pathMatch(.*)*', name: 'not-found', component: ErrorView, meta: { title: '404' } },
]

/**
 * `?redirect=` target, same-site paths only (open redirect; see docs/design-notes.md#security): one leading `/`, no `//` or `/\`,
 * no `\` or control characters (URL parsing drops tabs/newlines: `/\t/evil` → `//evil`), same origin.
 */
export function safeRedirect(target: unknown): string {
  if (
    typeof target !== 'string' ||
    !target.startsWith('/') ||
    target.startsWith('//') ||
    [...target].some((c) => c === '\\' || c < ' ' || c === '\x7f')
  )
    return '/'
  try {
    return new URL(target, location.origin).origin === location.origin ? target : '/'
  } catch {
    return '/'
  }
}

/** `<page> - <app>`; just the app name when the "dynamic title" setting is off. */
function setTitle(to: RouteLocationNormalized) {
  const app = import.meta.env.VITE_APP_TITLE || i18n.global.t('common.app.title')
  document.title =
    to.meta.title && appSettings.value.dynamicTitle
      ? `${localized(to.meta.titleI18n, to.meta.title)} - ${app}`
      : app
}

/**
 * Registers the menu routes `routes` under the layout: a route of the same name is replaced, a menu route
 * no longer among them removed (another user signed in, or a page no longer granted).
 */
export function syncMenuRoutes(router: Router, routes: RouteRecordRaw[]) {
  const names = new Set(routes.map((r) => r.name))
  for (const r of router.getRoutes())
    if (r.meta.menuId !== undefined && r.name && !names.has(r.name)) router.removeRoute(r.name)
  for (const r of routes) router.addRoute(LAYOUT, r)
}

/**
 * Permission reload without a new sign-in: when a signed-in answer carries a later `X-Perm-Ver`
 * (roles, grants, menus or the user's dept changed), `/me` and `/menus` load again and the menu routes
 * are re-registered in place, so new pages, side menu entries and buttons (`v-perm`, `usePerm` in
 * `computed`) appear and revoked ones go (with their open tags). The current page no longer granted then
 * shows 404, like any unknown path; moved to a new path, it follows. A version that moves while the
 * router guard's first load is under way (between its `/me` and `/menus`) is reloaded once that load is
 * done; a reload that fails keeps the version seen and tries again at the next signed-in answer.
 */
export function reloadOnPermChange(router: Router): WatchStopHandle {
  /** the version the loaded `/me` + `/menus` belong to */
  let applied = ''
  let running = false

  /** Fetches `/me` + `/menus` and applies them as version `target` if the same session still lasts. */
  async function load(target: string): Promise<boolean> {
    const at = sessionEpoch()
    try {
      const [me, tree] = await Promise.all([
        api.get<MePayload>('/auth/me'),
        api.get<MenuNode[]>('/auth/menus'),
      ])
      // signed out, or in as someone else, meanwhile: those answers belong to the ended session
      if (at !== sessionEpoch()) return false
      useAuthStore().me = me
      useMenuStore().tree = tree
      applied = target
      return true
    } catch {
      // the session ended (the request layer says so) or the network failed
      return false
    }
  }

  /** Reloads until the latest version seen is applied, one run at a time; only after the first load. */
  async function drain() {
    running = true
    try {
      while (permVer.value && permVer.value !== applied && useMenuStore().loaded) {
        if (!(await load(permVer.value))) return
        syncMenuRoutes(router, useMenuStore().routes)
        // open tags of pages that are gone (or moved) close; the home tag stays
        useTagsStore().close((t) => router.resolve(t.fullPath).matched[0]?.name !== LAYOUT)
        // the current page: gone → 404 like any unknown path; moved (a new path) → there
        const { name, meta, fullPath, params, query, hash } = router.currentRoute.value
        if (meta.menuId === undefined || !name || router.resolve(fullPath).name === name) continue
        const to = router.hasRoute(name) ? { name, params, query, hash } : fullPath
        await router.replace(to).catch(() => undefined)
      }
    } finally {
      running = false
    }
  }

  // a later version, another signed-in answer (a failed reload tries again) or the first load done
  return watch(
    [permVer, permVerAnswers, () => useMenuStore().loaded],
    ([ver], [prev]) => {
      // signed out: the next session starts over; its first answer: the router guard loads /me + /menus
      if (!ver || !prev) return void (applied = ver)
      if (!running) void drain()
    },
    { flush: 'sync' },
  )
}

/** Waits between attempts while the API does not answer (a restart, a rolling deploy): about 20 s in all. */
export const RETRY_MS = [1000, 1000, 2000, 2000, 3000, 3000, 4000, 4000]
/** No new attempt after this, request time included: an API that hangs costs one 30 s timeout, not nine. */
const RETRY_BUDGET_MS = RETRY_MS.reduce((a, b) => a + b)

/** Runs `step` again while it fails transiently (no answer, 429, 5xx); any other error at once. */
async function patiently(step: () => Promise<void>) {
  const deadline = Date.now() + RETRY_BUDGET_MS
  for (const ms of RETRY_MS) {
    try {
      return await step()
    } catch (e) {
      if (!isTransient(e) || Date.now() + ms > deadline) throw e
    }
    await new Promise((resolve) => setTimeout(resolve, ms))
  }
  return step()
}

export function createAppRouter(
  history: RouterHistory = createWebHistory(import.meta.env.BASE_URL),
) {
  const router = createRouter({ history, routes: staticRoutes })

  router.beforeEach(async (to) => {
    const auth = useAuthStore()
    // /me flags: the server only allows me/menus/password change/logout until the password changes, so a
    // known flagged session reaches nothing else, public pages included (sign-out clears it first)
    const forceChange = () =>
      to.name === 'password-change' || {
        name: 'password-change',
        query: to.meta.public ? {} : { redirect: to.fullPath },
      }
    if (auth.mustChangePassword) return forceChange()
    if (to.meta.public) return true
    const menu = useMenuStore()
    // only a rejected session signs in again; an API that still does not answer shows the retry page
    const failed = (e: unknown) => ({
      path: isTransient(e) ? '/503' : '/login',
      query: { redirect: to.fullPath },
    })
    try {
      await patiently(async () => {
        if (!auth.accessToken) await auth.refresh()
        if (!auth.me) await auth.fetchMe()
      })
    } catch (e) {
      return failed(e)
    }
    if (auth.mustChangePassword) return forceChange()
    // public pages stay reachable while locked: signing in again unlocks as well
    if (auth.locked && to.name !== 'lock') return { name: 'lock' }
    if (!auth.locked && to.name === 'lock') return '/'
    if (!menu.loaded) {
      try {
        await patiently(menu.load)
      } catch (e) {
        return failed(e)
      }
      // a new sign-in (possibly another user) replaces the previous user's menu routes
      syncMenuRoutes(router, menu.routes)
      return to.fullPath // match again against the new routes
    }
    if (to.name === LAYOUT) return menu.homePath || '/404'
    if (to.meta.perm && !auth.hasPerm(to.meta.perm)) return '/403'
    return true
  })
  router.afterEach(setTitle)
  watch([i18n.global.locale, () => appSettings.value.dynamicTitle], () =>
    setTitle(router.currentRoute.value),
  )
  return router
}

export default createAppRouter()
