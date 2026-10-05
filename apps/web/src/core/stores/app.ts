import { watchEffect } from 'vue'
import { defineStore } from 'pinia'
import { useDark, useStorage } from '@vueuse/core'
import { brandFill, brandTokens, DEFAULT_BRAND } from '@/core/theme'

export type LayoutMode = 'side' | 'top' | 'mix'
export type SideTheme = 'dark' | 'light'
export type ComponentSize = 'small' | 'default' | 'large'

/** The design's brand color (tokens.css `--qw-brand`). */
export const DEFAULT_PRIMARY = DEFAULT_BRAND
/** Theme colors offered in the settings drawer; white text reads ≥ 4.5:1 on each (contrast.spec), so
 * `brandFill` keeps them as they are. */
export const THEME_PRESETS = [
  DEFAULT_PRIMARY,
  '#4f46e5',
  '#0f766e',
  '#15803d',
  '#b45309',
  '#be123c',
  '#7c3aed',
]

/**
 * Page settings (SettingsDrawer; see docs/design-notes.md#layering), per browser in localStorage. Module-level so the router can
 * follow `dynamicTitle` before pinia is installed; new fields get their defaults on old saved objects.
 */
export const appSettings = useStorage(
  'qw.app.settings',
  {
    layout: 'side' as LayoutMode,
    primary: DEFAULT_PRIMARY,
    grey: false,
    watermark: false,
    fixedHeader: true,
    showLogo: true,
    showFooter: false,
    dynamicTitle: true,
    size: 'default' as ComponentSize,
    sideCollapsed: false,
    sideTheme: 'dark' as SideTheme,
  },
  undefined,
  { mergeDefaults: true },
)

export const useAppStore = defineStore('app', () => {
  const settings = appSettings
  // Element Plus dark css vars key off `html.dark`; 'auto' (nothing saved) follows the OS
  const dark = useDark({ storageKey: 'qw.app.colorScheme' })
  const root = document.documentElement

  watchEffect(() => root.classList.toggle('qw-grey', settings.value.grey))
  // theme color: tokens.css holds the default; another color replaces the brand tokens inline, its text
  // shade and tint derived for the current mode (element.css mixes the Element Plus shades from them).
  // A color white text cannot read on is darkened first, and stored so the color picker shows it.
  watchEffect(() => {
    const p = settings.value.primary
    const brand = brandFill(/^#[\da-f]{6}$/i.test(p) ? p : DEFAULT_PRIMARY)
    if (brand !== p) settings.value.primary = brand
    const custom = brand.toLowerCase() !== DEFAULT_PRIMARY.toLowerCase()
    const derived = custom ? brandTokens(brand, dark.value ? 'dark' : 'light') : undefined
    const values = {
      '--qw-brand': brand,
      '--qw-brand-text': derived?.text,
      '--qw-brand-weak': derived?.weak,
    }
    for (const [name, value] of Object.entries(values))
      if (custom && value) root.style.setProperty(name, value)
      else root.style.removeProperty(name)
  })

  return { settings, dark }
})
