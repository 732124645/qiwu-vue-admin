// The mobile tokens (visual-system §12) are the web's values in light and dark,
// the mobile-only ones §12.1's; wot-ui only points at them; the literal colours of theme.json, pages.json and the
// baked static SVGs are token values of their theme; core/theme.ts picks the theme.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../App.vue?raw'
import tabBar from '../core/components/QwTabBar.vue?raw'
import loginShell from '../pages/login/LoginShell.vue?raw'
import mine from '../pages/mine/index.vue?raw'
import pagesJson from '../pages.json?raw'
import themeJson from '../theme.json'
import web from '../../../apps/web/src/styles/tokens.css?raw'

const decls = (css: string) =>
  Object.fromEntries(
    [...css.matchAll(/(--(?:qw|wot)-[\w-]+):\s*([^;]+);/g)].map(([, k, v]) => [
      k,
      v!.replace(/\s+/g, ' ').trim(),
    ]),
  )
/** the declarations of the first `{ … }` block after `head` */
const block = (css: string, head: string) => decls(css.split(head)[1]!.split(/^}/m)[0]!)
const qw = (d: Record<string, string>) =>
  Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('--qw-')))

const webLight = decls(web.split(/^html\.dark/m)[0]!)
const webDark = block(web, 'html.dark {')
const light = qw(block(app, 'page,\n.wd-root-portal {'))
const dark = qw(block(app, '@mixin qw-dark {'))

/** §12.1: the tokens only mobile has (and one it keeps in dark), light and dark */
const MOBILE: Record<string, [string, string]> = {
  '--qw-brand-2': ['#2193e0', '#2193e0'],
  '--qw-brand-soft': ['#a9c7f7', '#a9c7f7'],
  '--qw-raised': ['#ffffff', '#2a3550'],
  '--qw-mask': ['rgba(8, 13, 22, 0.45)', 'rgba(0, 0, 0, 0.6)'],
  // the web's, but kept in dark: the navy headers do not change with the theme (the web's dark value is
  // 4.04:1 on the header's brand glow)
  '--qw-side-text': ['#b9c4d8', '#b9c4d8'],
  '--qw-radius-xl': ['24px', '24px'],
  '--qw-shadow-up': ['0 -8px 24px -16px rgba(15, 26, 43, 0.22)', 'none'],
  '--qw-shadow-brand': ['0 8px 16px -10px var(--qw-brand)', 'none'],
  ...Object.fromEntries(
    [8, 16, 24, 32, 48].map((v, i) => [`--qw-space-${i + 1}`, [`${v}rpx`, `${v}rpx`]]),
  ),
  ...Object.fromEntries(
    Object.entries({
      display: 52,
      'title-lg': 44,
      title: 34,
      'body-lg': 30,
      body: 28,
      caption: 24,
      micro: 22,
    }).map(([k, v]) => [`--qw-fs-${k}`, [`${v}rpx`, `${v}rpx`]]),
  ),
}

/** a token's value in a theme (dark: the dark block over the light one) */
const token = (name: string, theme: 'light' | 'dark') =>
  (theme === 'dark' ? (dark[name] ?? light[name]) : light[name])!

describe('tokens', () => {
  it('light: the web light values, the mobile-only ones of §12.1', () => {
    expect(Object.keys(light).length).toBeGreaterThan(40)
    for (const [k, v] of Object.entries(light))
      expect([k, v]).toEqual([k, k in MOBILE ? MOBILE[k]![0] : webLight[k]])
  })

  it('dark: the web dark values; nothing the web darkens stays light', () => {
    for (const [k, v] of Object.entries(dark))
      expect([k, v]).toEqual([k, k in MOBILE ? MOBILE[k]![1] : webDark[k]])
    for (const k of Object.keys(webDark).filter(
      (k) => k in light && !(k in MOBILE) && webDark[k] !== webLight[k],
    ))
      expect(dark).toHaveProperty(k)
    for (const [k, [, d]] of Object.entries(MOBILE)) expect([k, token(k, 'dark')]).toEqual([k, d])
  })

  it('maps wot-ui variables only to defined tokens (or to plain sizes)', () => {
    const wot = Object.entries(decls(app)).filter(([k]) => k.startsWith('--wot-'))
    expect(wot.length).toBeGreaterThan(25)
    for (const [k, v] of wot) {
      if (/^(\d[\d.]*(px|rpx)? ?)+$/.test(v)) continue
      expect([k, v]).toEqual([k, expect.stringMatching(/^var\(--qw-[\w-]+\)$/)])
      expect(light[v.slice(4, -1)]).toBeDefined()
    }
  })
})

describe('native bars and baked colours', () => {
  const THEME_TOKENS = {
    navBg: '--qw-surface',
    bg: '--qw-canvas',
    heroBg: '--qw-side-bg',
    tabColor: '--qw-text-3',
    tabSelected: '--qw-brand-text',
    tabBg: '--qw-surface',
  } as const

  it('theme.json: each colour is its theme’s token value', () => {
    for (const theme of ['light', 'dark'] as const) {
      const vars = themeJson[theme]
      for (const [k, name] of Object.entries(THEME_TOKENS))
        expect([theme, k, vars[k as keyof typeof vars]]).toEqual([theme, k, token(name, theme)])
      expect(vars.navText).toBe(theme === 'dark' ? 'white' : 'black')
      // App's back arrow: the title's colour (uni's for navText)
      expect(vars.navBack).toBe(theme === 'dark' ? '#ffffff' : '#000000')
      expect(vars.bgText).toBe(theme === 'dark' ? 'light' : 'dark')
    }
  })

  it('pages.json: no literal colours, only theme.json variables of both themes', () => {
    expect(pagesJson).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    const used = [...pagesJson.matchAll(/"@(\w+)"/g)].map(([, v]) => v!)
    expect(used.length).toBeGreaterThan(10)
    for (const v of used) {
      expect(themeJson.light).toHaveProperty(v)
      expect(themeJson.dark).toHaveProperty(v)
    }
    // App: a theme change rebuilds every native bar without a back arrow colour, and iOS draws it white (unseen
    // on the light bar), so the global style names it
    expect(JSON.parse(pagesJson).globalStyle['app-plus']).toEqual({
      titleNView: { backButton: { color: '@navBack' } },
    })
  })

  /** a theme's colours as #RRGGBB (an rgba token: its rgb, the SVG carries the alpha) */
  const palette = (theme: 'light' | 'dark') =>
    new Set(
      Object.keys(light).flatMap((k) => {
        const v = token(k, theme)
        const rgba = v.match(/^rgba\((\d+), (\d+), (\d+)/)
        if (rgba)
          return [
            '#' +
              rgba
                .slice(1, 4)
                .map((n) => (+n).toString(16).padStart(2, '0'))
                .join(''),
          ]
        return /^#[0-9a-f]{6}$/i.test(v) ? [v.toLowerCase()] : []
      }),
    )

  it('static SVGs: only their theme’s token colours, each at most 4 KB', () => {
    const svgs = import.meta.glob<string>('../static/**/*.svg', {
      query: '?raw',
      import: 'default',
      eager: true,
    })
    expect(Object.keys(svgs).length).toBe(21)
    const [day, night] = [palette('light'), palette('dark')]
    for (const [path, svg] of Object.entries(svgs)) {
      const file = path.replace('../static/', '')
      // ASCII files: length = bytes
      expect([file, svg.length <= 4096]).toEqual([file, true])
      expect(svg).not.toMatch(/var\(|href|style=/)
      const colors = [...svg.matchAll(/#[0-9a-f]{6}\b/gi)].map(([c]) => c.toLowerCase())
      // per-theme surface images (tab icons, empty state); the header art and the mark: the same in both
      const themes = /-dark\.svg$|rest-night\.svg$/.test(file)
        ? [night]
        : /^(tab|empty)\//.test(file)
          ? [day]
          : [day, night]
      for (const c of colors)
        for (const p of themes) expect([file, c, p.has(c)]).toEqual([file, c, true])
    }
  })
})

describe('contrast (§9; measured values: §12.6)', () => {
  type Theme = 'light' | 'dark'
  type Rgb = number[]
  /** a token as RGB; an rgba one over `base` */
  const rgb = (name: string, theme: Theme, base?: Rgb): Rgb => {
    const v = token(name, theme)
    const hex = v.match(/^#([0-9a-f]{6})$/i)
    if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16))
    const [r, g, b, a] = v.match(/[\d.]+/g)!.map(Number)
    return [r!, g!, b!].map((c, i) => c * a! + base![i]! * (1 - a!))
  }
  const mix = (a: Rgb, b: Rgb, alpha: number) => a.map((c, i) => b[i]! * alpha + c * (1 - alpha))
  // WCAG 2.x relative luminance and contrast ratio
  const lum = (c: Rgb) => {
    const [r, g, b] = c.map((v) => {
      v /= 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const ratio = (a: Rgb, b: Rgb) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
    return Math.round(((x! + 0.05) / (y! + 0.05)) * 100) / 100
  }

  /** [what, foreground, background, needed]: body text 4.5, large text (≥ 18.7px bold) and icons 3 */
  const pairs = (th: Theme): [string, Rgb, Rgb, number][] => {
    const c = (name: string, base?: Rgb) => rgb(name, th, base)
    const surface = c('--qw-surface')
    const navy = c('--qw-side-bg')
    // the header's brand glow at its peak (opacity .5); weak tokens are rgba over the card in dark
    const glow = mix(navy, c('--qw-brand'), 0.5)
    const weak = (name: string) => c(`--qw-${name}-weak`, surface)
    return [
      ['text / canvas', c('--qw-text'), c('--qw-canvas'), 4.5],
      ['text / surface', c('--qw-text'), surface, 4.5],
      ['text / surface-2', c('--qw-text'), c('--qw-surface-2'), 4.5],
      ['text / raised', c('--qw-text'), c('--qw-raised'), 4.5],
      ['text-2 / canvas', c('--qw-text-2'), c('--qw-canvas'), 4.5],
      ['text-2 / surface', c('--qw-text-2'), surface, 4.5],
      ['text-2 / neutral-weak', c('--qw-text-2'), weak('neutral'), 4.5],
      ['text-3 / canvas', c('--qw-text-3'), c('--qw-canvas'), 4.5],
      ['text-3 / surface', c('--qw-text-3'), surface, 4.5],
      ['text-3 / surface-2', c('--qw-text-3'), c('--qw-surface-2'), 4.5],
      ['brand-text / surface', c('--qw-brand-text'), surface, 4.5],
      ['brand-text / canvas', c('--qw-brand-text'), c('--qw-canvas'), 4.5],
      ['on-brand / brand', c('--qw-on-brand'), c('--qw-brand'), 4.5],
      ['white / navy', c('--qw-side-active-text'), navy, 4.5],
      ['white / glow', c('--qw-side-active-text'), glow, 4.5],
      ['side-text / navy', c('--qw-side-text'), navy, 4.5],
      ['side-text / glow', c('--qw-side-text'), glow, 4.5],
      ['on-brand / brand-2 (tile, avatar end)', c('--qw-on-brand'), c('--qw-brand-2'), 3],
      ...(['brand', 'success', 'warning', 'danger', 'neutral'] as const).map(
        (k): [string, Rgb, Rgb, number] => [
          `tag ${k}`,
          c(k === 'brand' ? '--qw-brand-text' : `--qw-${k}`),
          weak(k),
          4.5,
        ],
      ),
      ['badge digits (surface / danger)', surface, c('--qw-danger'), 4.5],
      ['danger dot / surface', c('--qw-danger'), surface, 3],
      ['danger dot / canvas', c('--qw-danger'), c('--qw-canvas'), 3],
    ]
  }

  for (const th of ['light', 'dark'] as const)
    it(`${th}: every key pair meets its ratio`, () => {
      const low = pairs(th)
        .map(([what, fg, bg, need]) => [what, ratio(fg, bg), need] as const)
        .filter(([, got, need]) => got < need)
      expect(low).toEqual([])
    })
})

describe('core/theme', () => {
  /** the OS's theme, and the app's style (App: forced by a choice) */
  let system: 'light' | 'dark'
  let app: 'light' | 'dark'
  let onChange: ((r: { theme: 'light' | 'dark' }) => void) | undefined
  const load = async (platform?: 'h5' | 'app' | 'mp-weixin') => {
    vi.resetModules()
    process.env.UNI_PLATFORM = platform
    return import('@/core/theme')
  }

  beforeEach(() => {
    system = 'light'
    app = 'light'
    Object.assign(uni, {
      // App: getAppBaseInfo().theme is the app's style; elsewhere (no forcing) the system's
      getAppBaseInfo: () => ({ theme: process.env.UNI_PLATFORM === 'app' ? app : system }),
      onThemeChange: (cb: typeof onChange) => void (onChange = cb),
      addInterceptor: vi.fn(),
    })
    uni.removeStorageSync('qw.theme')
  })
  afterEach(() => {
    delete process.env.UNI_PLATFORM
    delete (globalThis as { document?: unknown }).document
    delete (globalThis as { matchMedia?: unknown }).matchMedia
    delete (globalThis as { plus?: unknown }).plus
  })

  it('follows the system by default, and its changes', async () => {
    system = 'dark'
    const theme = await load()
    theme.initTheme()
    expect([theme.themePref.value, theme.isDark.value]).toEqual(['system', true])
    onChange!({ theme: 'light' })
    expect([theme.isDark.value, theme.systemIsDark.value]).toEqual([false, false])
  })

  it('a manual choice wins over the system and is kept for the next start', async () => {
    let theme = await load('h5')
    // H5: the system theme from the media query; the side effect: the <html> class (it darkens the bar too)
    const classList = { toggle: vi.fn() }
    const query = {
      matches: false,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) =>
        void (onChange = ({ theme }) => cb({ matches: theme === 'dark' })),
    }
    Object.assign(globalThis, {
      document: { documentElement: { classList } },
      matchMedia: () => query,
    })
    theme.initTheme()
    expect(classList.toggle).toHaveBeenLastCalledWith('qw-dark', false)
    theme.setThemePref('dark')
    expect(theme.isDark.value).toBe(true)
    expect(classList.toggle).toHaveBeenLastCalledWith('qw-dark', true)
    onChange!({ theme: 'dark' })
    theme.setThemePref('light')
    expect([theme.isDark.value, theme.systemIsDark.value]).toEqual([false, true])

    theme = await load('h5')
    theme.initTheme()
    expect([theme.themePref.value, theme.isDark.value]).toEqual(['light', false])
  })

  /** App's plus: setUIStyle (forces the app's style), the OS name, iOS's screen traits (the OS's: 2 = dark) */
  const appPlus = (name = 'iOS') => ({
    nativeUI: {
      setUIStyle: vi.fn((style: 'auto' | 'light' | 'dark') => {
        if (name === 'iOS') app = style === 'auto' ? system : style
      }),
    },
    os: { name },
    ios: {
      invoke: (_: unknown, method: string) =>
        method === 'userInterfaceStyle' ? (system === 'dark' ? 2 : 1) : {},
      deleteObject: vi.fn(),
    },
  })

  it('App (iOS): the whole app’s style follows the choice; the system’s theme is the screen’s, not the forced style', async () => {
    const plus = appPlus()
    const { setUIStyle } = plus.nativeUI
    Object.assign(globalThis, { plus })
    const theme = await load('app')
    theme.initTheme()
    expect(setUIStyle).toHaveBeenLastCalledWith('auto')
    theme.setThemePref('dark')
    expect(setUIStyle).toHaveBeenLastCalledWith('dark')
    // the forced style's own report: the OS is still light
    onChange!({ theme: 'dark' })
    expect([theme.isDark.value, theme.systemIsDark.value]).toEqual([true, false])
    // forced dark, the OS turns dark: the app's style stays, so no event; Appearance reads it on opening
    system = 'dark'
    theme.refreshSystemTheme()
    expect([theme.isDark.value, theme.systemIsDark.value]).toEqual([true, true])
    // … and back to the system's
    system = 'light'
    theme.setThemePref('light')
    system = 'dark'
    theme.setThemePref('system')
    expect(setUIStyle).toHaveBeenLastCalledWith('auto')
    expect([theme.isDark.value, theme.systemIsDark.value]).toEqual([true, true])
    // forced light, the OS turns light: the event carries the app's style; the hint follows the OS
    theme.setThemePref('light')
    system = 'light'
    onChange!({ theme: 'light' })
    expect([theme.isDark.value, theme.systemIsDark.value]).toEqual([false, false])
  })

  it('App (iOS): back to the system after the OS changed under a forced choice (no event, Appearance not reopened)', async () => {
    Object.assign(globalThis, { plus: appPlus() })
    const theme = await load('app')
    theme.initTheme()
    theme.setThemePref('dark')
    system = 'dark'
    theme.setThemePref('system')
    expect([theme.isDark.value, theme.systemIsDark.value]).toEqual([true, true])
  })

  it('wiring: the navy pages whiten the status bar when they show; Appearance reads the system’s theme first', () => {
    expect(tabBar).toMatch(/onShow\(\(\) => \{\n {2}whiteStatusBar\(\)\n/)
    // a closure per instance (uni binds a hook function to the first page that registers it)
    expect(loginShell).toContain('\nonShow(() => whiteStatusBar())\n')
    expect(mine).toMatch(/go: \(\) => \{\s*refreshSystemTheme\(\)\s*appearanceOpen\.value = true/)
  })

  it('App elsewhere (setUIStyle is iOS-only), or no screen to ask: the app’s style is the system’s', async () => {
    Object.assign(globalThis, { plus: appPlus('Android') })
    system = app = 'dark'
    let theme = await load('app')
    theme.initTheme()
    expect([theme.isDark.value, theme.systemIsDark.value]).toEqual([true, true])
    Object.assign(globalThis, {
      plus: {
        nativeUI: { setUIStyle: vi.fn() },
        os: { name: 'iOS' },
        ios: {
          invoke: () => {
            throw new Error('no native.js')
          },
        },
      },
    })
    // the app's (dark), not the OS's (light)
    system = 'light'
    theme = await load('app')
    theme.initTheme()
    expect(theme.systemIsDark.value).toBe(true)
  })

  it('App: the navy pages keep white status bar text when the theme changes (§12.6)', async () => {
    vi.useFakeTimers()
    const setNavigationBarColor = vi.fn()
    Object.assign(uni, { setNavigationBarColor })
    Object.assign(globalThis, { plus: appPlus() })
    let route = 'pages/mine/index'
    vi.stubGlobal('getCurrentPages', () => [{ route: 'pages/home/index' }, { route }])
    const white = expect.objectContaining({
      frontColor: '#ffffff',
      backgroundColor: themeJson.light.heroBg,
    })
    try {
      const theme = await load('app')
      theme.initTheme()
      // a navy page shows (QwTabBar, LoginShell)
      theme.whiteStatusBar()
      expect(setNavigationBarColor).toHaveBeenLastCalledWith(white)
      setNavigationBarColor.mockClear()
      // the theme changes: after uni's own restyle of every page (it runs after the handlers)
      onChange!({ theme: 'light' })
      expect(setNavigationBarColor).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(setNavigationBarColor.mock.calls).toEqual([[white]])
      // a page with its native bar keeps the theme's
      route = 'pages-wf/detail/index'
      onChange!({ theme: 'dark' })
      vi.runAllTimers()
      expect(setNavigationBarColor).toHaveBeenCalledTimes(1)
      // H5 and the mini program: nothing (no status bar, or pages.json's white holds)
      for (const platform of ['h5', 'mp-weixin'] as const) (await load(platform)).whiteStatusBar()
      expect(setNavigationBarColor).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      vi.stubGlobal('getCurrentPages', () => [])
    }
  })

  it('App: the title a page sets survives the rebuild of its native bar on a theme change', async () => {
    const addInterceptor = vi.fn()
    Object.assign(uni, { addInterceptor })
    Object.assign(globalThis, { plus: appPlus() })
    // uni rebuilds a bar from its page's route meta (pages.json): the title goes there too
    const below = { titleText: 'Qiwu' }
    const top = { titleText: 'Qiwu', type: 'default' }
    vi.stubGlobal('getCurrentPages', () => [
      { $page: { meta: { navigationBar: below } } },
      { $page: { meta: { navigationBar: top } } },
    ])
    try {
      ;(await load('app')).initTheme()
      expect(addInterceptor.mock.calls).toEqual([
        ['setNavigationBarTitle', { invoke: expect.any(Function) }],
      ])
      const { invoke } = addInterceptor.mock.calls[0]![1] as { invoke: (o: object) => unknown }
      // the page being loaded is the last one; the call goes on unchanged
      expect(invoke({ title: 'About' })).toBeUndefined()
      expect([below, top]).toEqual([{ titleText: 'Qiwu' }, { titleText: 'About', type: 'default' }])
      // elsewhere (here the mini program): no native bar to rebuild
      addInterceptor.mockClear()
      ;(await load('mp-weixin')).initTheme()
      expect(addInterceptor).not.toHaveBeenCalled()
    } finally {
      vi.stubGlobal('getCurrentPages', () => [])
    }
  })

  it('NAVY_PAGES: the pages.json pages with custom navigation and white text', async () => {
    type Pages = { path: string; style: Record<string, string> }[]
    const json = JSON.parse(pagesJson) as {
      pages: Pages
      subPackages: { root: string; pages: Pages }[]
    }
    const all = [
      ...json.pages,
      ...json.subPackages.flatMap((p) =>
        p.pages.map((x) => ({ ...x, path: `${p.root}/${x.path}` })),
      ),
    ]
    const navy = all.filter(
      (p) => p.style.navigationStyle === 'custom' && p.style.navigationBarTextStyle === 'white',
    )
    expect(new Set(navy.map((p) => p.path))).toEqual(new Set((await load()).NAVY_PAGES))
  })

  it('z-paging: every list binds the theme in use (dark: its white set), texts and lines in tokens', async () => {
    const vues = import.meta.glob<string>('../**/*.vue', {
      query: '?raw',
      import: 'default',
      eager: true,
    })
    const lists = Object.entries(vues).filter(([, v]) => v.includes('<z-paging'))
    // the generated list pages (pages-biz) are lists too
    expect(lists.map(([p]) => p)).toEqual(
      expect.arrayContaining(['../pages/approval/index.vue', '../pages/message/index.vue']),
    )
    for (const [p, v] of lists)
      for (const bind of [
        ':default-theme-style="pagingTheme.style"',
        ':loading-more-title-custom-style="pagingTheme.title"',
        ':loading-more-no-more-line-custom-style="pagingTheme.line"',
      ])
        expect([p, bind, v.includes(bind)]).toEqual([p, bind, true])
    system = 'dark'
    const theme = await load()
    theme.initTheme()
    expect(theme.pagingTheme.value).toEqual({
      style: 'white',
      title: { color: 'var(--qw-text-3)' },
      line: { backgroundColor: 'var(--qw-border)' },
    })
    onChange!({ theme: 'light' })
    expect(theme.pagingTheme.value.style).toBe('black')
  })

  it('the mini program follows the system only: no choice, a saved one ignored', async () => {
    uni.setStorageSync('qw.theme', 'dark')
    const theme = await load('mp-weixin')
    theme.initTheme()
    expect([theme.canChooseTheme, theme.themePref.value, theme.isDark.value]).toEqual([
      false,
      'system',
      false,
    ])
    theme.setThemePref('dark')
    expect(theme.isDark.value).toBe(false)
  })
})
