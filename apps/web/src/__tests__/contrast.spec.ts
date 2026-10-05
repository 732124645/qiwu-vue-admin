import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { THEME_PRESETS, useAppStore } from '@/core/stores/app'
import elementCssRaw from '@/styles/element.css?raw'
import {
  brandFill,
  brandTokens,
  contrast,
  DEFAULT_BRAND,
  MIN_TEXT,
  over,
  parseColor,
  parseTokens,
  type Rgba,
  type Theme,
} from '@/core/theme'

// WCAG contrast of the design tokens in both themes (docs/design/visual-system.md §9), read from tokens.css.
const tokens = parseTokens()
const THEMES: Theme[] = ['light', 'dark']

/** A token as an opaque color; translucent tokens are composited over `on`. */
function color(theme: Theme, name: string, on = '--qw-surface'): Rgba {
  const c = parseColor(tokens[theme][name] ?? '')
  if (!c) throw new Error(`${theme} ${name}: not a color (${tokens[theme][name]})`)
  return c[3] < 1 ? over(c, color(theme, on)) : c
}

const GROUNDS = ['--qw-canvas', '--qw-surface', '--qw-surface-2']
/** [text, background, background drawn over, minimum ratio] */
const PAIRS: [string, string, string?, number?][] = [
  ...['--qw-text', '--qw-text-2', '--qw-text-3'].flatMap((fg) =>
    GROUNDS.map((bg): [string, string] => [fg, bg]),
  ),
  ['--qw-on-brand', '--qw-brand'],
  ['--qw-side-active-text', '--qw-side-active-bg'],
  ...[...GROUNDS, '--qw-brand-weak'].map((bg): [string, string] => ['--qw-brand-text', bg]),
  ['--qw-side-text', '--qw-side-bg'],
  ['--qw-side-text-3', '--qw-side-bg'],
  ['--qw-side-text', '--qw-side-hover', '--qw-side-bg'],
  ...['success', 'warning', 'danger', 'neutral'].map((s): [string, string] => [
    `--qw-${s}`,
    `--qw-${s}-weak`,
  ]),
  ['--qw-danger', '--qw-surface'],
  ['--qw-danger', '--qw-surface-2'],
  // non-text (focus ring, selected fills) against the surface: 3:1
  ['--qw-brand', '--qw-surface', undefined, 3],
]

describe.each(THEMES)('%s tokens', (theme) => {
  it.each(PAIRS)('%s on %s', (fg, bg, under = '--qw-surface', min = MIN_TEXT) => {
    const ratio = contrast(color(theme, fg), color(theme, bg, under))
    expect(ratio, `${fg} on ${bg}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min)
  })
})

// the BPMN designer's logo plate: bpmn-js draws the bpmn.io logo #404040, left as it is
it.each(THEMES)('%s: the bpmn.io logo on --qw-logo-plate reads ≥ 7:1', (theme) => {
  const ratio = contrast(parseColor('#404040')!, color(theme, '--qw-logo-plate'))
  expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(7)
})

describe('theme color', () => {
  it('parses both themes and resolves token references', () => {
    expect(tokens.light['--qw-side-active-bg']).toBe(tokens.light['--qw-brand'])
    expect(tokens.dark['--qw-brand']).toBe(DEFAULT_BRAND) // the fill stays, the text shade changes
    expect(tokens.dark['--qw-brand-text']).not.toBe(tokens.light['--qw-brand-text'])
    expect(parseColor('rgba(76, 141, 255, 0.14)')).toEqual([76, 141, 255, 0.14])
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1])
  })

  it("tokens.css' light brand text and tint are the ones derived from the default brand", () => {
    expect(brandTokens(DEFAULT_BRAND, 'light')).toEqual({
      text: tokens.light['--qw-brand-text'],
      weak: tokens.light['--qw-brand-weak'],
    })
  })

  it.each(THEME_PRESETS)(
    'preset %s: white fill text and a readable text shade in both modes',
    (p) => {
      const brand = parseColor(p)!
      expect(contrast([255, 255, 255, 1], brand)).toBeGreaterThanOrEqual(MIN_TEXT)
      for (const theme of THEMES) {
        const { text, weak } = brandTokens(p, theme)
        const grounds = [
          ...GROUNDS.map((g) => color(theme, g)),
          over(parseColor(weak)!, color(theme, '--qw-surface')),
        ]
        for (const g of grounds)
          expect(contrast(parseColor(text)!, g)).toBeGreaterThanOrEqual(MIN_TEXT)
      }
    },
  )

  it('a custom color white text cannot read on is darkened first; the picker shows the result', async () => {
    const white: Rgba = [255, 255, 255, 1]
    const nearWhite = '#f4f6ff'
    const fill = brandFill(nearWhite)
    expect(contrast(white, parseColor(fill)!)).toBeGreaterThanOrEqual(MIN_TEXT)
    expect(contrast(white, parseColor(fill)!)).toBeLessThan(MIN_TEXT + 0.5) // just enough
    for (const p of THEME_PRESETS) expect(brandFill(p)).toBe(p) // readable colors stay as picked

    setActivePinia(createPinia())
    const app = useAppStore()
    app.settings.primary = nearWhite
    await nextTick()
    expect(app.settings.primary).toBe(fill) // the color picker's v-model
    const root = document.documentElement.style
    expect(root.getPropertyValue('--qw-brand')).toBe(fill)
    expect(root.getPropertyValue('--qw-brand-text')).toBe(brandTokens(fill, 'light').text)
    app.settings.primary = DEFAULT_BRAND
    await nextTick()
    expect(root.getPropertyValue('--qw-brand')).toBe('')
  })

  it('lightens in dark mode and darkens in light mode', () => {
    const lum = (c: string) =>
      parseColor(c)!
        .slice(0, 3)
        .reduce((a, b) => a + b, 0)
    expect(lum(brandTokens('#0f766e', 'dark').text)).toBeGreaterThan(lum('#0f766e'))
    expect(lum(brandTokens('#0f766e', 'light').text)).toBeLessThanOrEqual(lum('#0f766e'))
  })
})

// element.css: white text on the solid primary button in every state, both themes, every preset (§9)
const elementCss = elementCssRaw.replace(/\/\*[\s\S]*?\*\//g, '')

/** The `--x: value;` declarations of the rule whose selector is exactly `selector`. */
function declarations(selector: string): Record<string, string> {
  const at = elementCss.indexOf(`${selector} {`)
  if (at < 0) throw new Error(`element.css: no rule '${selector}'`)
  const body = elementCss.slice(elementCss.indexOf('{', at) + 1, elementCss.indexOf('}', at))
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [
      m[1]!,
      m[2]!.replace(/\s+/g, ' ').trim(),
    ]),
  )
}

/** A CSS color over `vars`: `#hex` / `rgb()`, `black` / `white`, `var(--x)`, `color-mix(in srgb, A p%, B)`. */
function cssColor(value: string | undefined, vars: Record<string, string>): Rgba {
  const v = (value ?? '').trim()
  const ref = /^var\((--[\w-]+)\)$/.exec(v)?.[1]
  if (ref) return cssColor(vars[ref], vars)
  const mix = /^color-mix\(in srgb, (.+?) ([\d.]+)%, (.+)\)$/.exec(v)
  if (mix) {
    const [a, b, p] = [cssColor(mix[1], vars), cssColor(mix[3], vars), Number(mix[2]) / 100]
    return [0, 1, 2].map((i) => a[i]! * p + b[i]! * (1 - p)).concat(1) as Rgba
  }
  const c = parseColor({ black: '#000000', white: '#ffffff' }[v] ?? v)
  if (!c) throw new Error(`not a color: '${v}'`)
  return c
}

const PRIMARY = ':root .el-button--primary:not(.is-plain, .is-link, .is-text)'
const FILLS = [...THEME_PRESETS, brandFill('#f4f6ff')] // + a calibrated custom color

describe.each(THEMES)('%s solid primary button', (theme) => {
  it.each(FILLS)('%s: white text ≥ 4.5:1 at rest, on hover and while pressed', (brand) => {
    const vars: Record<string, string> = {
      ...tokens[theme],
      '--qw-brand': brand,
      '--el-color-primary': 'var(--qw-brand)',
      ...declarations('html:root'),
      ...(theme === 'dark' ? declarations('html.dark:root') : {}),
      ...declarations(PRIMARY),
    }
    for (const state of ['', 'hover-', 'active-']) {
      const bg = vars[`--el-button-${state}bg-color`] ?? (state ? undefined : 'var(--qw-brand)')
      const ratio = contrast(
        cssColor(vars[`--el-button-${state}text-color`], vars),
        cssColor(bg, vars),
      )
      expect(ratio, `${state || 'rest '}${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN_TEXT)
    }
  })
})

// Check the actual sidebar scope, including translucent icons and the logo suffix.
describe.each(THEMES)('%s sidebar', (theme) => {
  it.each(FILLS)('%s: both appearances keep text ≥ 4.5:1 and icons ≥ 3:1', (brand) => {
    for (const appearance of ['dark', 'light']) {
      const vars = {
        ...tokens[theme],
        '--qw-brand': brand,
        '--qw-brand-weak': brandTokens(brand, theme).weak,
        '--qw-side-active-bg': brand,
        ...(appearance === 'light' ? declarations(':root .qw-side-light') : {}),
      }
      const bg = cssColor('var(--qw-side-bg)', vars)
      const hover = over(cssColor('var(--qw-side-hover)', vars), bg)
      const active = cssColor('var(--qw-side-active-bg)', vars)
      const pairs: [string, Rgba][] = [
        ['--qw-side-text', bg],
        ['--qw-side-text-3', bg],
        ['--qw-side-text', hover],
        ['--qw-side-hover-text', hover],
        ['--qw-side-active-text', active],
        ['--qw-side-logo-text', bg],
      ]
      for (const [token, ground] of pairs) {
        const fg = cssColor(`var(${token})`, vars)
        expect(contrast(fg, ground), `${appearance} ${token}`).toBeGreaterThanOrEqual(MIN_TEXT)
        expect(
          contrast(over([...fg.slice(0, 3), 0.85] as Rgba, ground), ground),
        ).toBeGreaterThanOrEqual(3)
      }
      const logo = cssColor('var(--qw-side-logo-text)', vars)
      expect(contrast(over([...logo.slice(0, 3), 0.6] as Rgba, bg), bg)).toBeGreaterThanOrEqual(
        MIN_TEXT,
      )
    }
  })
})
