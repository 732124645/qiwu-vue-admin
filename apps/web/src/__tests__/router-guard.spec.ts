import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AxiosError } from 'axios'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, withDirectives } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import { createMemoryHistory, RouterView, type Router } from 'vue-router'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken, api, permVer, setSessionHint } from '@/core/request/http'
import { buildRoutes } from '@/core/router/build-routes'
import { createAppRouter, LAYOUT, reloadOnPermChange, RETRY_MS, safeRedirect } from '@/core/router'
import { useAuthStore } from '@/core/stores/auth'
import { useTagsStore } from '@/core/stores/tags'
import ErrorView from '@/views/error/ErrorView.vue'
import LoginView from '@/views/login/index.vue'
import AppLogo from '@/core/layout/AppLogo.vue'
import AuthPage from '@/core/layout/AuthPage.vue'
import { fail, me, mockApi, node, ok, type Route } from './mock-api'

// the guard and the routes under test, not the layout (its own specs): a bare view for the pages below it
vi.mock('@/core/layout/AppLayout.vue', async () => ({
  default: (await import('vue-router')).RouterView,
}))

const tree = [
  node({
    id: 1,
    kind: 'group',
    routePath: '/settings',
    children: [
      node({
        id: 2,
        routePath: 'dicts',
        routeName: 'SettingsDict',
        name: 'menu.settings.dict',
        component: 'login/index',
        children: [
          node({
            id: 3,
            routePath: '/settings/dicts/:code',
            routeName: 'DictEntries',
            component: 'login/index',
            visible: false,
          }),
        ],
      }),
      node({
        id: 4,
        routePath: 'docs',
        linkType: 'iframe',
        linkUrl: 'https://example.com/docs',
        nameI18n: { 'zh-CN': '文档', 'en-US': 'Docs' },
      }),
      node({ id: 5, routePath: 'site', linkType: 'external', linkUrl: 'https://example.com' }),
      node({ id: 6, routePath: 'missing', component: 'no/such/view' }),
    ],
  }),
]

const loader = (r: unknown) => (r as { component: () => Promise<{ default: unknown }> }).component

let router: Router
const signedIn = (extra: Record<string, Route> = {}, perms = ['*'], flags = {}) =>
  mockApi({
    'POST /auth/refresh': ok({ accessToken: 'at-1', expiresIn: 900 }),
    'GET /auth/me': ok(me(perms, flags)),
    'GET /auth/menus': ok(tree),
    ...extra,
  })

beforeEach(() => {
  vi.stubEnv('VITE_APP_TITLE', undefined)
  setActivePinia(createPinia())
  accessToken.value = ''
  setSessionHint(true)
  setLocale('en-US')
  router = createAppRouter(createMemoryHistory())
})
afterEach(() => vi.unstubAllEnvs())

describe('buildRoutes', () => {
  const routes = buildRoutes(tree)

  it('flattens pages under the layout and skips groups and external links', () => {
    expect(routes.map((r) => r.path)).toEqual([
      '/settings/dicts',
      '/settings/dicts/:code',
      '/settings/docs',
      '/settings/missing',
    ])
    expect(routes.map((r) => r.name)).toEqual(['SettingsDict', 'DictEntries', 'menu-4', 'menu-6'])
    expect(routes[1]!.meta).toMatchObject({ hidden: true, menuId: 3 })
    expect(routes[0]!.meta).toMatchObject({
      hidden: false,
      title: 'menu.settings.dict',
      component: 'login/index',
    })
  })

  it('resolves components through the views glob; iframe → its URL in meta; unknown → error view', async () => {
    expect((await loader(routes[0])()).default).toBe(LoginView)
    expect(routes[2]!.meta?.linkUrl).toBe('https://example.com/docs')
    expect((await loader(routes[3])()).default).toBe(ErrorView)
  })

  it('an iframe page: the shared placeholder (AppLayout shows the frame), its URL in meta', () => {
    const [page, plain] = buildRoutes([
      node({ id: 7, routePath: '/api-docs', linkType: 'iframe', linkUrl: '/api/docs' }),
      // a route page never gets a frame, whatever its stored link_url
      node({ id: 8, routePath: '/p', component: 'login/index', linkUrl: 'https://example.com' }),
    ])
    expect(page!.component).toBe(routes[2]!.component)
    expect(page!.meta?.linkUrl).toBe('/api/docs')
    expect(plain!.meta?.linkUrl).toBeNull()
  })
})

describe('router guard', () => {
  it('register and password reset are public, including with a live session', async () => {
    setSessionHint(false)
    const calls = signedIn()
    for (const [path, name, title] of [
      ['/register', 'register', 'Create an account'],
      ['/password-reset', 'password-reset', 'Reset password'],
    ]) {
      await router.push(path!)
      expect(router.currentRoute.value.name).toBe(name)
      expect(document.title).toBe(`${title} - Qiwu Admin`)
    }
    expect(calls).toEqual([])
    accessToken.value = 'at-1'
    await router.push('/login')
    await router.push('/register')
    expect(router.currentRoute.value.name).toBe('register')
  })
  it('no access token and refresh fails → /login?redirect=', async () => {
    const calls = mockApi({ 'POST /auth/refresh': fail(401, 'A1006') })
    await router.push('/settings/dicts?tab=2')
    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.query.redirect).toBe('/settings/dicts?tab=2')
    // a rejection is final: no second try
    expect(calls).toHaveLength(1)
  })

  it('/me rejected and its refresh rejected → /login at once', async () => {
    accessToken.value = 'at-0'
    const calls = mockApi({
      'GET /auth/me': fail(401, 'A0410'),
      'POST /auth/refresh': fail(401, 'A1006'),
    })
    await router.push('/settings/dicts')
    expect(router.currentRoute.value.fullPath).toBe('/login?redirect=/settings/dicts')
    expect(calls.map((c) => c.url)).toEqual(['/auth/me', '/auth/refresh'])
  })

  it('never signed in here (no session hint) → /login without trying the refresh', async () => {
    setSessionHint(false)
    const calls = signedIn()
    await router.push('/settings/dicts')
    expect(router.currentRoute.value.fullPath).toBe('/login?redirect=/settings/dicts')
    expect(calls).toEqual([])
  })

  it('first load: refresh, then me + menus, registers menu routes and lands on the target', async () => {
    const calls = signedIn()
    await router.push('/settings/dicts/iam.gender')
    expect(calls.map((c) => c.url)).toEqual(['/auth/refresh', '/auth/me', '/auth/menus'])
    expect(calls[1]!.headers.Authorization).toBe('Bearer at-1')
    expect(router.currentRoute.value.name).toBe('DictEntries')
    expect(router.hasRoute('menu-4')).toBe(true)
    expect(router.getRoutes().some((r) => r.path === '/settings/site')).toBe(false)

    await router.push('/settings/dicts')
    expect(calls).toHaveLength(3)
  })

  it('/ goes to the first visible menu page; unknown paths render 404', async () => {
    signedIn()
    await router.push('/')
    expect(router.currentRoute.value.path).toBe('/settings/dicts')
    await router.push('/no/such/page')
    expect(router.currentRoute.value.name).toBe('not-found')
  })

  it('my inbox is a signed-in static page without a menu grant', async () => {
    signedIn({}, [])
    await router.push('/inbox')
    expect(router.currentRoute.value.name).toBe('my-inbox')
    expect(router.currentRoute.value.meta.perm).toBeUndefined()
    expect(document.title).toBe('My messages - Qiwu Admin')
  })

  it('/sso: signed out → sign-in, back with the whole request; signed in → the consent page, no grant needed', async () => {
    const sso = '/sso?client_id=x&redirect_uri=https%3A%2F%2Fa.example%2Fcb&state=y'
    mockApi({ 'POST /auth/refresh': fail(401, 'A1006') })
    await router.push(sso)
    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.query.redirect).toBe(sso)

    setSessionHint(true)
    signedIn({}, [])
    await router.push(sso)
    expect(router.currentRoute.value.name).toBe('sso')
    // the first load's re-entry re-encodes the query (vue-router), the request itself is intact
    expect(router.currentRoute.value.query).toEqual({
      client_id: 'x',
      redirect_uri: 'https://a.example/cb',
      state: 'y',
    })
    expect(document.title).toBe('Authorize access - Qiwu Admin')
  })

  it('password change flags → only /password-change (with redirect back), no menus', async () => {
    const calls = signedIn({}, ['*'], { mustChangePassword: true })
    await router.push('/settings/dicts')
    expect(router.currentRoute.value.name).toBe('password-change')
    expect(router.currentRoute.value.query.redirect).toBe('/settings/dicts')
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('password-change')
    expect(calls.map((c) => c.url)).not.toContain('/auth/menus')
    // public pages too (sign-in, error pages); sign-out clears the session and frees them
    for (const path of ['/login', '/register', '/password-reset', '/403', '/404']) {
      await router.push(path)
      expect(router.currentRoute.value.fullPath).toBe('/password-change')
    }
    await useAuthStore().logout()
    await router.push('/login')
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('missing permission → /403', async () => {
    signedIn({}, ['settings.dict.browse'])
    await router.push('/settings/dicts')
    const component = ErrorView
    router.addRoute(LAYOUT, { path: '/audit', meta: { perm: 'audit.log.browse' }, component })
    router.addRoute(LAYOUT, {
      path: '/dicts2',
      meta: { perm: ['x.y.z', 'settings.dict.browse'] },
      component,
    })
    await router.push('/audit')
    expect(router.currentRoute.value.path).toBe('/403')
    await router.push('/dicts2')
    expect(router.currentRoute.value.path).toBe('/dicts2')
  })

  it('document title comes from t(meta.title) / name_i18n and follows the locale', async () => {
    signedIn()
    await router.push('/settings/docs')
    expect(document.title).toBe('Docs - Qiwu Admin')
    setLocale('zh-CN')
    await flushPromises()
    expect(document.title).toBe('文档 - 栖梧管理系统')
    await router.push('/login')
    expect(document.title).toBe(`${i18n.global.t('common.login.title')} - 栖梧管理系统`)
  })

  it('uses the configured title in the browser and logo across locales', async () => {
    const title = "Demo # 'quoted' \\ title"
    vi.stubEnv('VITE_APP_TITLE', title)
    signedIn()
    await router.push('/settings/docs')
    const logo = mount(AppLogo, { global: { plugins: [i18n, router] } })
    const authPage = mount(AuthPage, {
      props: { title: 'Sign in' },
      global: { plugins: [i18n] },
    })
    try {
      expect(document.title).toBe(`Docs - ${title}`)
      expect(logo.attributes('aria-label')).toBe(title)
      expect(logo.find('.app-logo__text').text()).toBe(title)
      expect(logo.find('.app-logo__suffix').exists()).toBe(false)
      expect(authPage.find('.auth-brand__logo').text()).toBe(title)
      expect(authPage.find('.auth-brand__suffix').exists()).toBe(false)
      setLocale('zh-CN')
      await flushPromises()
      expect(document.title).toBe(`${tree[0]!.children![1]!.nameI18n!['zh-CN']} - ${title}`)
      expect(logo.find('.app-logo__text').text()).toBe(title)
      expect(authPage.find('.auth-brand__logo').text()).toBe(title)
    } finally {
      logo.unmount()
      authPage.unmount()
    }
  })

  it.each([undefined, ''])('falls back to localized branding when title is %s', async (title) => {
    vi.stubEnv('VITE_APP_TITLE', title)
    signedIn()
    await router.push('/settings/docs')
    const logo = mount(AppLogo, { global: { plugins: [i18n, router] } })
    const authPage = mount(AuthPage, {
      props: { title: 'Sign in' },
      global: { plugins: [i18n] },
    })
    try {
      for (const locale of ['en-US', 'zh-CN'] as const) {
        setLocale(locale)
        await flushPromises()
        expect(document.title.endsWith(` - ${i18n.global.t('common.app.title')}`)).toBe(true)
        expect(logo.attributes('aria-label')).toBe(i18n.global.t('common.app.title'))
        expect(logo.find('.app-logo__text').text()).toBe(i18n.global.t('common.app.title'))
        expect(authPage.find('.auth-brand__logo').text()).toBe(i18n.global.t('common.app.title'))
        expect(authPage.find('.auth-brand__suffix').exists()).toBe(true)
      }
    } finally {
      logo.unmount()
      authPage.unmount()
    }
  })

  it('a new sign-in replaces the previous user’s menu routes', async () => {
    signedIn()
    await router.push('/settings/dicts')
    useAuthStore().clear()
    signedIn({ 'GET /auth/menus': ok([node({ id: 7, routePath: '/home', routeName: 'Home' })]) })
    await router.push('/')
    expect(router.currentRoute.value.path).toBe('/home')
    expect(router.hasRoute('SettingsDict')).toBe(false)
  })

  it('/redirect/<path> re-enters the page with its query', async () => {
    signedIn()
    await router.push('/settings/dicts')
    mount(RouterView, { global: { plugins: [router, i18n, ElementPlus] } })
    await router.push('/redirect/settings/dicts?tab=2')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/settings/dicts?tab=2')
  })
})

describe('permission reload', () => {
  it('a later X-Perm-Ver reloads /me + /menus in place: new pages route, a revoked current page shows 404, v-perm follows', async () => {
    const stop = reloadOnPermChange(router)
    const state = {
      ver: '3.1',
      perms: ['iam.user.browse'],
      menus: tree,
      menusDown: false,
      meGate: Promise.resolve(),
    }
    const reply = (data: unknown): [number, unknown, Record<string, string>] => [
      200,
      { code: 0, msg: 'ok', data },
      { 'x-perm-ver': state.ver },
    ]
    const calls = mockApi({
      'POST /auth/refresh': ok({ accessToken: 'at-1', expiresIn: 900 }),
      'GET /auth/me': async () => (await state.meGate, reply(me(state.perms))),
      'GET /auth/menus': () => (state.menusDown ? fail(503, 'B0001') : reply(state.menus)),
      'GET /ping': () => reply(null),
    })
    const ping = async () => {
      await api.get('/ping')
      await flushPromises()
    }
    await router.push('/settings/dicts')
    expect(permVer.value).toBe('3.1')
    const tags = useTagsStore()
    tags.open(router.currentRoute.value)
    const button = mount(
      defineComponent({ render: () => withDirectives(h('button'), [[vPerm, 'iam.user.create']]) }),
    )
    const shown = () => button.element.style.display !== 'none'
    expect(shown()).toBe(false)
    const urls = () => calls.map((c) => c.url).filter((u) => u !== '/ping')

    // the same version: nothing reloads
    await ping()
    expect(urls()).toEqual(['/auth/refresh', '/auth/me', '/auth/menus'])

    // granted a button and a page, the dicts page revoked: the next answer carries 3.2
    state.ver = '3.2'
    state.perms = ['iam.user.browse', 'iam.user.create']
    state.menus = [node({ id: 7, routePath: '/home', routeName: 'Home' })]
    await ping()
    expect(urls()).toEqual(['/auth/refresh', '/auth/me', '/auth/menus', '/auth/me', '/auth/menus'])
    expect(shown()).toBe(true)
    expect(router.hasRoute('Home')).toBe(true)
    expect(router.hasRoute('SettingsDict')).toBe(false)
    expect(router.currentRoute.value.name).toBe('not-found')
    expect(tags.tags).toEqual([]) // its open tag went with it

    // an older answer (a request sent before the change) changes nothing
    state.ver = '3.1'
    await ping()
    expect(permVer.value).toBe('3.2')
    expect(urls()).toHaveLength(5)

    // a page moved to another path (same route name): the current page follows it
    await router.push('/home')
    state.ver = '3.3'
    state.menus = [node({ id: 7, routePath: '/start', routeName: 'Home' })]
    await ping()
    expect(router.currentRoute.value.fullPath).toBe('/start')

    // revoked again, but the reload fails: the next answer with the same version tries again
    state.ver = '3.4'
    state.perms = ['iam.user.browse']
    state.menusDown = true
    await ping()
    expect(shown()).toBe(true)
    state.menusDown = false
    await ping()
    expect(shown()).toBe(false)

    // signed out while a reload is under way: its answers belong to the ended session and are dropped
    let open = () => {}
    state.meGate = new Promise((resolve) => (open = resolve))
    state.ver = '3.5'
    await ping()
    const auth = useAuthStore()
    auth.clear()
    expect(permVer.value).toBe('')
    open()
    await flushPromises()
    expect(auth.me).toBeNull()
    stop()
  })
})

describe('permission reload during the first load', () => {
  it('a version that moves between the first /me and /menus reloads once after the first load, never rolled back', async () => {
    const stop = reloadOnPermChange(router)
    const state = { ver: '5.1', perms: ['iam.user.browse'], menus: 0 }
    const reply = (data: unknown): [number, unknown, Record<string, string>] => [
      200,
      { code: 0, msg: 'ok', data },
      { 'x-perm-ver': state.ver },
    ]
    const calls = mockApi({
      'POST /auth/refresh': ok({ accessToken: 'at-1', expiresIn: 900 }),
      'GET /auth/me': () => reply(me(state.perms)),
      'GET /auth/menus': () => {
        // granted a button between the guard's /me and its /menus: the menus answer at the new version
        if (!state.menus++) {
          state.ver = '5.2'
          state.perms = ['iam.user.browse', 'iam.user.create']
        }
        return reply(tree)
      },
    })
    await router.push('/settings/dicts')
    await flushPromises()
    expect(calls.map((c) => c.url)).toEqual([
      '/auth/refresh',
      '/auth/me',
      '/auth/menus',
      '/auth/me',
      '/auth/menus',
    ])
    expect(permVer.value).toBe('5.2')
    expect(useAuthStore().me?.perms).toEqual(['iam.user.browse', 'iam.user.create'])
    expect(router.currentRoute.value.name).toBe('SettingsDict')
    stop()
  })
})

describe('safeRedirect', () => {
  it('only allows internal paths', () => {
    expect(safeRedirect('/iam/users?page=2')).toBe('/iam/users?page=2')
    expect(safeRedirect('//evil.example')).toBe('/')
    expect(safeRedirect('https://evil.example')).toBe('/')
    expect(safeRedirect(['/a'])).toBe('/')
    expect(safeRedirect('/\\evil.example')).toBe('/')
    expect(safeRedirect('/a\\b')).toBe('/')
    expect(safeRedirect('/\t/evil.example')).toBe('/')
    expect(safeRedirect('/\n/evil.example')).toBe('/')
    expect(safeRedirect('javascript:alert(1)')).toBe('/')
    expect(safeRedirect('/home#x')).toBe('/home#x')
  })
})

describe('router guard while the API does not answer (a restart, a rolling deploy)', () => {
  afterEach(() => vi.useRealTimers())

  /** answers in turn, the last one for good; 'down': no answer at all (network error) */
  const seq =
    (...replies: (ReturnType<typeof ok> | 'down')[]): Route =>
    (config) => {
      const reply = replies.length > 1 ? replies.shift()! : replies[0]!
      if (reply === 'down') throw new AxiosError('down', 'ERR_NETWORK', config)
      return reply
    }
  const hint = () => localStorage.getItem('qw.auth.session')

  it('no answer, 429 or 5xx: tries again and lands on the page, still signed in', async () => {
    vi.useFakeTimers()
    const calls = mockApi({
      'POST /auth/refresh': seq(
        fail(502, 'B0001'),
        'down',
        fail(503, 'B0001'),
        ok({ accessToken: 'at-1', expiresIn: 900 }),
      ),
      'GET /auth/me': seq(fail(429, 'A0429'), 'down', ok(me(['*']))),
      'GET /auth/menus': seq(fail(500, 'B0001'), ok(tree)),
    })
    const nav = router.push('/settings/dicts')
    await vi.runAllTimersAsync()
    await nav
    expect(router.currentRoute.value.name).toBe('SettingsDict')
    expect(calls.map((c) => c.url)).toEqual([
      ...Array<string>(4).fill('/auth/refresh'),
      ...Array<string>(3).fill('/auth/me'),
      ...Array<string>(2).fill('/auth/menus'),
    ])
    expect(hint()).toBe('1')
  })

  it('an API that hangs until the request times out is not tried again past the ~20 s budget', async () => {
    vi.useFakeTimers()
    const calls = mockApi({
      'POST /auth/refresh': async (config) => {
        await new Promise((resolve) => setTimeout(resolve, 30_000))
        throw new AxiosError('timeout of 30000ms exceeded', 'ECONNABORTED', config)
      },
    })
    const nav = router.push('/settings/dicts')
    await vi.runAllTimersAsync()
    await nav
    expect(router.currentRoute.value.name).toBe('503')
    expect(calls).toHaveLength(1)
  })

  it('still no answer after the retries: the retry page, not the sign-in page; its button tries again', async () => {
    vi.useFakeTimers()
    const calls = mockApi({ 'POST /auth/refresh': fail(502, 'B0001') })
    const nav = router.push('/settings/dicts?tab=2')
    await vi.runAllTimersAsync()
    await nav
    expect(router.currentRoute.value.name).toBe('503')
    expect(router.currentRoute.value.query.redirect).toBe('/settings/dicts?tab=2')
    expect(calls).toHaveLength(RETRY_MS.length + 1)
    expect(hint()).toBe('1')
    vi.useRealTimers()

    // the API is back: "retry" goes to the page the load was for
    signedIn()
    const view = mount(RouterView, { global: { plugins: [router, i18n, ElementPlus] } })
    await vi.waitFor(() => expect(view.text()).toContain('The server is not responding'))
    await view.get('button').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/settings/dicts?tab=2'))
  })
})
