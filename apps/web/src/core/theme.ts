import tokensCss from '@/styles/tokens.css?raw'

// Color math over the design tokens (docs/design/visual-system.md §2, §9): the theme color's derived
// brand tokens, and the WCAG contrast checks of __tests__/contrast.spec.ts.

export type Theme = 'light' | 'dark'
/** r, g, b 0–255 and alpha 0–1 */
export type Rgba = [number, number, number, number]

/** `#rgb`, `#rrggbb`, `rgb()` / `rgba()`; undefined for anything else. */
export function parseColor(s: string): Rgba | undefined {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(s.trim())?.[1]
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
    const [r = 0, g = 0, b = 0] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
    return [r, g, b, 1]
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s.trim())?.[1]
  if (!fn) return undefined
  const [r = 0, g = 0, b = 0, a = 1] = fn
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number)
  return [r, g, b, a]
}

/** `fg` composited over an opaque `bg`. */
export const over = (fg: Rgba, bg: Rgba): Rgba => [
  fg[0] * fg[3] + bg[0] * (1 - fg[3]),
  fg[1] * fg[3] + bg[1] * (1 - fg[3]),
  fg[2] * fg[3] + bg[2] * (1 - fg[3]),
  1,
]

const channel = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]: Rgba) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)

/** WCAG 2 contrast ratio of two opaque colors (1–21). */
export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const hex = (c: Rgba) =>
  `#${c
    .slice(0, 3)
    .map((v) => Math.round(v).toString(16).padStart(2, '0'))
    .join('')}`

/** `--qw-*` values per theme from tokens.css; dark falls back to light, `var(--qw-x)` is resolved. */
export function parseTokens(css: string = tokensCss): Record<Theme, Record<string, string>> {
  const block = (selector: string) =>
    Object.fromEntries(
      [
        ...(
          new RegExp(`(?:^|\\})\\s*${selector}\\s*\\{([^}]*)\\}`).exec(
            css.replace(/\/\*[\s\S]*?\*\//g, ''),
          )?.[1] ?? ''
        ).matchAll(/(--qw-[\w-]+)\s*:\s*([^;]+);/g),
      ].map((m) => [m[1] ?? '', (m[2] ?? '').replace(/\s+/g, ' ').trim()]),
    )
  const resolve = (t: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(t).map(([k, v]) => [
        k,
        v.replace(/var\((--qw-[\w-]+)\)/g, (_, n) => t[n] ?? ''),
      ]),
    )
  const light = block(':root')
  return { light: resolve(light), dark: resolve({ ...light, ...block('html\\.dark') }) }
}

const TOKENS = parseTokens()
export const DEFAULT_BRAND = TOKENS.light['--qw-brand'] ?? '#1F6FEB'
/** body text contrast (§9) */
export const MIN_TEXT = 4.5

/** `color` moved `p` (0–1) of the way toward `to` (0 = black, 255 = white), opaque, channels rounded. */
const shade = (color: Rgba, to: number, p: number): Rgba =>
  [0, 1, 2].map((i) => Math.round(color[i]! * (1 - p) + to * p)).concat(1) as Rgba

/**
 * A theme color as a fill (primary buttons, the selected menu item): darkened in 2% steps until
 * `--qw-on-brand` text reads ≥ 4.5:1 on it; a color that already does comes back as given.
 */
export function brandFill(brand: string): string {
  const color = parseColor(brand)
  if (!color) return DEFAULT_BRAND
  const onBrand = parseColor(TOKENS.light['--qw-on-brand'] ?? '')!
  for (let step = 0; step < 50; step++) {
    const fill = shade(color, 0, step / 50)
    if (contrast(onBrand, fill) >= MIN_TEXT) return step ? hex(fill) : brand
  }
  return '#000000'
}

/**
 * Brand tokens for a theme color (settings drawer): `text` is the color darkened (light) / lightened (dark)
 * in 2% steps until it reads ≥ 4.5:1 on the canvas, both surfaces and `weak`; `weak` is the tint behind
 * selected items (10% of the color on the surface, or 14% of `text` over dark surfaces).
 */
export function brandTokens(brand: string, theme: Theme): { text: string; weak: string } {
  const t = TOKENS[theme]
  const color = parseColor(brand) ?? parseColor(DEFAULT_BRAND)!
  const surface = parseColor(t['--qw-surface'] ?? '')!
  const grounds = ['--qw-canvas', '--qw-surface', '--qw-surface-2'].map((k) =>
    parseColor(t[k] ?? '')!,
  )
  const toward = theme === 'dark' ? 255 : 0
  let text = color
  let weak = color
  for (let step = 0; step <= 50; step++) {
    text = shade(color, toward, step / 50)
    weak =
      theme === 'dark'
        ? [text[0], text[1], text[2], 0.14]
        : over([...color.slice(0, 3), 0.1] as Rgba, surface)
    if ([...grounds, over(weak, surface)].every((g) => contrast(text, g) >= MIN_TEXT)) break
  }
  return {
    text: hex(text),
    weak: weak[3] < 1 ? `rgba(${weak.slice(0, 3).join(', ')}, ${weak[3]})` : hex(weak),
  }
}
