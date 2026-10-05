// Light and dark (visual-system §12.6). The tokens of both live in App.vue; this module only
// decides which one shows. Default: the system's. App and H5 let Me → Appearance override it, saved per device
// in uni storage (`qw.theme`); the mini program has no API to override its theme, so it follows the system only.
// Applying it: H5 sets the `qw-dark` class on <html>, which also darkens the native navigation bar (App.vue:
// its build has the light theme.json values only); App switches the whole app's style
// (plus.nativeUI.setUIStyle: native bars, dialogs and the WebView's prefers-color-scheme); the mini program
// needs nothing (theme.json + prefers-color-scheme).
import { computed, ref } from 'vue'
import themeJson from '@/theme.json'

export type ThemePref = 'system' | 'light' | 'dark'
export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark']

const STORAGE_KEY = 'qw.theme'
/** uni's build-time platform: `h5`, `app`, `mp-weixin` (undefined under vitest) */
const platform = process.env.UNI_PLATFORM

/** App and H5 show Me → Appearance; the mini program follows the system only. */
export const canChooseTheme = platform !== 'mp-weixin'

const isPref = (v: unknown): v is ThemePref => THEME_PREFS.includes(v as ThemePref)
const pref = ref<ThemePref>('system')
const systemDark = ref(false)

/** the saved choice */
export const themePref = computed(() => pref.value)
/** what the system shows (Appearance's "System · currently …") */
export const systemIsDark = computed(() => systemDark.value)
/** the theme in use: what the static images (tab icons, empty state) follow */
export const isDark = computed(() =>
  pref.value === 'system' ? systemDark.value : pref.value === 'dark',
)

/**
 * z-paging in the theme in use (every list it pages): its pull-to-refresh and load-more texts and icons
 * (`style`), the load-more text and the "no more" lines in tokens
 */
export const pagingTheme = computed(() => ({
  style: isDark.value ? ('white' as const) : ('black' as const),
  title: { color: 'var(--qw-text-3)' },
  line: { backgroundColor: 'var(--qw-border)' },
}))

/**
 * The system's theme. On App uni reports the app's own style, which a choice forces (getAppBaseInfo().theme,
 * plus.navigator.getUIStyle() and osTheme alike; checked on iOS 26), so iOS asks the screen, whose traits no
 * override reaches (UIUserInterfaceStyleDark = 2); setUIStyle is iOS-only (html5plus), so elsewhere the app's
 * style is the system's. The mini program's is the system's (it cannot be forced).
 */
function readSystem(): boolean {
  if (platform === 'app' && plus.os.name === 'iOS') {
    try {
      const screen = plus.ios.invoke('UIScreen', 'mainScreen')
      const traits = plus.ios.invoke(screen, 'traitCollection')
      const style: unknown = plus.ios.invoke(traits, 'userInterfaceStyle')
      plus.ios.deleteObject(traits)
      plus.ios.deleteObject(screen)
      return style === 2
    } catch {
      // the app's style below
    }
  }
  return uni.getAppBaseInfo().theme === 'dark'
}

/** App.vue onLaunch: the saved choice and the system's theme, then follows the system's changes. */
export function initTheme() {
  const saved: unknown = canChooseTheme ? uni.getStorageSync(STORAGE_KEY) : ''
  pref.value = isPref(saved) ? saved : 'system'
  if (platform === 'h5') {
    // H5 builds without uni's darkmode (with it uni.hideTabBar misses the themed tab bar copy): the media query
    const query = matchMedia('(prefers-color-scheme: dark)')
    systemDark.value = query.matches
    query.addEventListener('change', (e) => followSystem(e.matches))
  } else {
    systemDark.value = readSystem()
    uni.onThemeChange(({ theme }) => followSystem(theme === 'dark'))
  }
  if (platform === 'app') keepTitles()
  apply()
}

/**
 * App: on every theme change uni rebuilds each page's native bar from the page's pages.json style, its route
 * meta (uistylechange → useWebviewThemeChange → parseWebviewStyle), so a title the page set at runtime falls
 * back to "Qiwu". The title a page sets goes into that meta too, and the rebuild keeps it.
 */
function keepTitles() {
  uni.addInterceptor('setNavigationBarTitle', {
    invoke({ title }: { title: string }) {
      const pages = getCurrentPages()
      const page = pages[pages.length - 1] as { $page?: { meta: { navigationBar: object } } }
      if (page?.$page) Object.assign(page.$page.meta.navigationBar, { titleText: title })
    },
  })
}

function followSystem(dark: boolean) {
  if (platform !== 'app') {
    systemDark.value = dark
    return apply()
  }
  // App: the event also reports the style a choice forces (setUIStyle), so the system's is read; the app's
  // style follows by itself. Then uni restyles every page's status bar text to the theme (uistylechange →
  // changePagesNavigatorStyle, after this handler): a navy current page gets its white text back.
  systemDark.value = readSystem()
  setTimeout(() => {
    const pages = getCurrentPages()
    if (NAVY_PAGES.includes(pages[pages.length - 1]?.route ?? '')) whiteStatusBar()
  })
}

/** Me → Appearance opens: the system's theme now (App: a change while a choice is forced sends no event). */
export function refreshSystemTheme() {
  if (platform === 'app') systemDark.value = readSystem()
}

/** Me → Appearance: takes effect at once and is kept for the next start (no-op on the mini program). */
export function setThemePref(next: ThemePref) {
  if (!canChooseTheme) return
  pref.value = next
  uni.setStorageSync(STORAGE_KEY, next)
  apply()
}

function apply() {
  if (platform === 'app') {
    // back to "system": the OS may have changed while a choice was forced (and then no event comes)
    systemDark.value = readSystem()
    plus.nativeUI.setUIStyle(pref.value === 'system' ? 'auto' : pref.value)
  }
  if (platform === 'h5') document.documentElement.classList.toggle('qw-dark', isDark.value)
}

/** the pages under the navy sky (pages.json: custom navigation, white status bar text; §12.6) */
export const NAVY_PAGES = [
  'pages/login/index',
  'pages/home/index',
  'pages/approval/index',
  'pages/message/index',
  'pages/mine/index',
  'pages-sys/wx-bind/index',
]

/**
 * App: white status bar text on a navy page, whatever the theme (§12.6). uni sets every page's to the theme
 * whenever the theme changes, so the navy pages call it when they show (QwTabBar, LoginShell) and a theme
 * change calls it for the current one.
 */
export function whiteStatusBar() {
  if (platform !== 'app') return
  uni.setNavigationBarColor({
    frontColor: '#ffffff',
    backgroundColor: themeJson.light.heroBg,
    fail: () => {},
  })
}

/** For components and pages: the theme state and its setter. */
export const useTheme = () => ({
  pref: themePref,
  isDark,
  systemIsDark,
  canChoose: canChooseTheme,
  setPref: setThemePref,
})
