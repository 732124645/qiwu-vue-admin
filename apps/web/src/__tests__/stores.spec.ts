import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { currentLocale, setLocale } from '@/core/i18n'
import { brandFill, DEFAULT_BRAND } from '@/core/theme'
import { accessToken, api, setSessionHint } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { useDictStore } from '@/core/stores/dict'
import { useLocaleStore } from '@/core/stores/locale'
import { useMenuStore } from '@/core/stores/menu'
import { useNotifyStore } from '@/core/stores/notify'
import { fail, me, mockApi, node, ok, type Route } from './mock-api'

/** A fake endpoint that answers only when the test says so. */
function later() {
  let answer = (_reply: ReturnType<typeof ok>) => {}
  const route: Route = () => new Promise((resolve) => (answer = resolve))
  return { route, answer: (reply: ReturnType<typeof ok>) => answer(reply) }
}

const HINT = 'qw.auth.session'
const stored = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))

beforeEach(() => {
  setActivePinia(createPinia())
  accessToken.value = ''
  localStorage.clear()
  setSessionHint(true)
})

describe('auth store', () => {
  it('login keeps the access token in memory and drops the previous session state', async () => {
    localStorage.clear()
    const calls = mockApi({
      'POST /auth/login': ok({ accessToken: 'at-1', expiresIn: 900 }),
      'GET /auth/me': ok(me(['iam.user.browse'])),
    })
    const auth = useAuthStore()
    auth.me = me(['*'])
    // the previous user's bell counts never show for the next one
    useNotifyStore().inboxUnread = 3
    await auth.login({ username: 'admin', password: 'secret-pw' })
    expect(useNotifyStore().unread).toBe(0)
    expect(auth.accessToken).toBe('at-1')
    expect(accessToken.value).toBe('at-1')
    expect(auth.me).toBeNull()
    expect(calls[0]!.data).toBe(JSON.stringify({ username: 'admin', password: 'secret-pw' }))
    // only the non-secret "may hold a refresh cookie" hint is stored
    expect(stored()).toEqual([HINT])
    expect(localStorage.getItem(HINT)).toBe('1')

    await auth.fetchMe()
    expect(calls[1]!.headers.Authorization).toBe('Bearer at-1')
    expect(auth.roles).toEqual(['root'])
    expect(auth.hasPerm('iam.user.browse')).toBe(true)
    expect(auth.hasPerm('iam.user.remove')).toBe(false)
    expect(auth.hasPerm(['iam.user.remove', 'iam.user.browse'])).toBe(true)
  })

  it('root wildcard grants every permission point', () => {
    const auth = useAuthStore()
    auth.me = me(['*'])
    expect(auth.hasPerm('settings.dict.browse')).toBe(true)
  })

  it('mustChangePassword follows either /me flag', () => {
    const auth = useAuthStore()
    expect(auth.mustChangePassword).toBe(false)
    auth.me = me([], { passwordExpired: true })
    expect(auth.mustChangePassword).toBe(true)
    auth.me = me([], { mustChangePassword: true })
    expect(auth.mustChangePassword).toBe(true)
  })

  it('refresh stores the rotated token', async () => {
    mockApi({ 'POST /auth/refresh': ok({ accessToken: 'at-2', expiresIn: 900 }) })
    const auth = useAuthStore()
    await auth.refresh()
    expect(auth.accessToken).toBe('at-2')
  })

  it('session hint: no refresh without it; a rejected refresh drops it, a server error keeps it', async () => {
    const refresh = { reply: fail(500, 'A0500') }
    const calls = mockApi({ 'POST /auth/refresh': () => refresh.reply })
    const auth = useAuthStore()
    await expect(auth.refresh()).rejects.toMatchObject({ status: 500 })
    expect(localStorage.getItem(HINT)).toBe('1')
    refresh.reply = fail(401, 'A1006')
    await expect(auth.refresh()).rejects.toMatchObject({ status: 401 })
    expect(localStorage.getItem(HINT)).toBeNull()
    expect(calls).toHaveLength(2)
    await expect(auth.refresh()).rejects.toMatchObject({ status: 401 })
    expect(calls).toHaveLength(2)
  })

  it('logout clears token, me and menus even when the server call fails', async () => {
    const calls = mockApi({ 'POST /auth/logout': fail(500, 'A0500') })
    const auth = useAuthStore()
    const menu = useMenuStore()
    accessToken.value = 'at-1'
    auth.me = me(['*'])
    menu.tree = [node({ id: 1, routePath: '/home' })]
    menu.loaded = true
    await auth.logout()
    expect(localStorage.getItem(HINT)).toBeNull()
    expect(calls[0]!.headers.Authorization).toBe('Bearer at-1')
    expect(auth.accessToken).toBe('')
    expect(auth.me).toBeNull()
    expect(menu.loaded).toBe(false)
    expect(menu.tree).toEqual([])
  })
})

describe('auth store: sign-in / refresh ordering (session epoch)', () => {
  const user = { username: 'bob', password: 'secret-pw' }

  it('a sign-in waits for the in-flight refresh, so the refresh lands first and the sign-in wins', async () => {
    const refresh = later()
    const calls = mockApi({
      'POST /auth/refresh': refresh.route,
      'POST /auth/login': ok({ accessToken: 'at-bob', expiresIn: 900 }),
    })
    const auth = useAuthStore()
    const refreshing = auth.refresh()
    const login = auth.login(user)
    await flushPromises()
    expect(calls.map((c) => c.url)).toEqual(['/auth/refresh'])
    refresh.answer(ok({ accessToken: 'at-alice-2', expiresIn: 900 }))
    await Promise.all([refreshing, login])
    expect(calls.map((c) => c.url)).toEqual(['/auth/refresh', '/auth/login'])
    expect(accessToken.value).toBe('at-bob')
  })

  it('a refresh answered after a sign-in neither overwrites nor clears the new token', async () => {
    const login = later()
    const refresh = later()
    mockApi({ 'POST /auth/login': login.route, 'POST /auth/refresh': refresh.route })
    const auth = useAuthStore()
    const signingIn = auth.login(user)
    await flushPromises()
    // started under the previous session while the sign-in is on its way
    const refreshing = auth.refresh()
    login.answer(ok({ accessToken: 'at-bob', expiresIn: 900 }))
    await signingIn
    refresh.answer(ok({ accessToken: 'at-alice-2', expiresIn: 900 }))
    await refreshing
    expect(accessToken.value).toBe('at-bob')
  })

  it('a failed refresh of the previous session keeps the new token', async () => {
    const login = later()
    const refresh = later()
    mockApi({ 'POST /auth/login': login.route, 'POST /auth/refresh': refresh.route })
    const auth = useAuthStore()
    const signingIn = auth.login(user)
    await flushPromises()
    const refreshing = auth.refresh()
    login.answer(ok({ accessToken: 'at-bob', expiresIn: 900 }))
    await signingIn
    refresh.answer(fail(401, 'A1006'))
    await expect(refreshing).rejects.toMatchObject({ status: 401 })
    expect(accessToken.value).toBe('at-bob')
  })

  it('a 401 of the previous session’s request is not replayed with the new user’s token', async () => {
    accessToken.value = 'at-alice'
    const pending = later()
    const calls = mockApi({
      'GET /a': (c) => (c._retried ? ok('replayed as bob') : pending.route(c)),
      'POST /auth/login': ok({ accessToken: 'at-bob', expiresIn: 900 }),
      'POST /auth/refresh': ok({ accessToken: 'at-bob-2', expiresIn: 900 }),
    })
    const request = api.get('/a')
    await flushPromises()
    await useAuthStore().login(user)
    pending.answer(fail(401, 'A0410'))
    await expect(request).rejects.toMatchObject({ status: 401 })
    expect(calls.map((c) => c.url)).toEqual(['/a', '/auth/login'])
    expect(accessToken.value).toBe('at-bob')
  })
})

describe('menu store', () => {
  it('loads the tree and lists keep-alive component names', async () => {
    const tree = [
      node({
        id: 1,
        kind: 'group',
        routePath: '/settings',
        children: [
          node({ id: 2, routePath: 'dicts', keepAlive: true, componentName: 'SettingsDict' }),
          node({ id: 3, routePath: 'params', componentName: 'ParamList' }),
          node({ id: 4, routePath: 'x', keepAlive: true }),
        ],
      }),
    ]
    mockApi({ 'GET /auth/menus': ok(tree) })
    const menu = useMenuStore()
    await menu.load()
    expect(menu.loaded).toBe(true)
    expect(menu.tree).toEqual(tree)
    expect(menu.cacheNames).toEqual(['SettingsDict'])
  })
})

describe('locale store', () => {
  it('reads and switches the app locale', () => {
    const store = useLocaleStore()
    store.set('en-US')
    expect(currentLocale()).toBe('en-US')
    expect(store.locale).toBe('en-US')
    expect(store.locales).toEqual(['zh-CN', 'en-US'])
    setLocale('zh-CN')
    expect(store.locale).toBe('zh-CN')
  })

  it('signed in, the switch is saved to the account too (never while a password change is due)', async () => {
    const calls = mockApi({ 'PUT /iam/profile/locale': ok(null) })
    const store = useLocaleStore()
    const auth = useAuthStore()
    store.set('en-US') // signed out: this browser only
    auth.me = me(['*'], { mustChangePassword: true })
    store.set('zh-CN')
    auth.me = me(['*'])
    store.set('en-US')
    await flushPromises()
    expect(calls.map((c) => [c.url, c.data])).toEqual([
      ['/iam/profile/locale', JSON.stringify({ locale: 'en-US' })],
    ])
    setLocale('zh-CN')
  })

  it('quick switches (A → B → A) save one at a time, so the last choice is the one persisted', async () => {
    // the server applies a save when it answers; the spec answers one held request at a time
    const held: { locale: string; answer: () => void }[] = []
    let persisted = ''
    mockApi({
      'PUT /iam/profile/locale': (config) =>
        new Promise((resolve) => {
          const { locale } = JSON.parse(config.data as string) as { locale: string }
          held.push({
            locale,
            answer: () => {
              persisted = locale
              resolve(ok(null))
            },
          })
        }),
    })
    useAuthStore().me = me(['*'])
    const store = useLocaleStore()
    store.set('en-US')
    store.set('zh-CN')
    store.set('en-US')
    const sent: string[] = []
    for (await flushPromises(); held.length; await flushPromises()) {
      expect(held).toHaveLength(1) // never two in flight: none can overtake another
      const next = held.shift()!
      sent.push(next.locale)
      next.answer()
    }
    expect(sent).toEqual(['en-US', 'zh-CN', 'en-US'])
    expect(persisted).toBe('en-US')
    setLocale('zh-CN')
  })
})

describe('dict store', () => {
  const gender = {
    version: 3,
    entries: [
      {
        value: 'm',
        label: 'Male',
        labelI18n: { 'zh-CN': '男', 'en-US': 'Male' },
        tagType: null,
        cssClass: null,
        isDefault: false,
        sortNo: 1,
      },
      {
        value: 'x',
        label: 'Other',
        labelI18n: null,
        tagType: null,
        cssClass: null,
        isDefault: false,
        sortNo: 2,
      },
    ],
  }

  it('loads each code lazily and only once', async () => {
    const calls = mockApi({ 'GET /settings/dicts/iam.gender/entries': ok(gender) })
    const dict = useDictStore()
    expect(calls).toHaveLength(0)
    const [a, b] = await Promise.all([dict.load('iam.gender'), dict.load('iam.gender')])
    expect(a).toEqual(gender.entries)
    expect(b).toBe(a)
    await dict.load('iam.gender')
    expect(calls).toHaveLength(1)
  })

  it('renders labels from label_i18n with fallback to label, following the locale', async () => {
    mockApi({ 'GET /settings/dicts/iam.gender/entries': ok(gender) })
    const dict = useDictStore()
    expect(dict.label('iam.gender', 'm')).toBe('m') // first read starts the load
    await dict.load('iam.gender')
    setLocale('zh-CN')
    expect(dict.label('iam.gender', 'm')).toBe('男')
    setLocale('en-US')
    expect(dict.label('iam.gender', 'm')).toBe('Male')
    expect(dict.label('iam.gender', 'x')).toBe('Other')
    expect(dict.label('iam.gender', 'unknown')).toBe('unknown')
    setLocale('zh-CN')
  })

  it('refetches only when invalidated with a different version', async () => {
    const calls = mockApi({ 'GET /settings/dicts/iam.gender/entries': ok(gender) })
    const dict = useDictStore()
    await dict.load('iam.gender')
    dict.invalidate('iam.gender', 3)
    await dict.load('iam.gender')
    expect(calls).toHaveLength(1)
    dict.invalidate('iam.gender', 4)
    await dict.load('iam.gender')
    expect(calls).toHaveLength(2)
    dict.invalidate('iam.gender')
    await dict.load('iam.gender')
    expect(calls).toHaveLength(3)
  })
})

describe('app store', () => {
  it("a saved theme color is kept on load, Element Plus' old default too (no stale migration)", async () => {
    localStorage.setItem('qw.app.settings', JSON.stringify({ primary: '#409EFF' }))
    vi.resetModules() // appSettings reads localStorage when the module loads
    const { useAppStore } = await import('@/core/stores/app')
    const app = useAppStore()
    await nextTick()
    // only darkened for white text, never reset to the default
    expect(app.settings.primary).toBe(brandFill('#409EFF'))
    expect(app.settings.primary).not.toBe(DEFAULT_BRAND)
  })
})
