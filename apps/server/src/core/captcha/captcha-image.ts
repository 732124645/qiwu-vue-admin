// Image captcha: our own polyline glyphs drawn as SVG paths, no fonts, no dependency.
import { randomInt } from 'node:crypto'

type Point = readonly [number, number]
export type Rng = () => number

/**
 * Answers (questions, piece positions) come from the CSPRNG: Math.random is xorshift128+, whose state
 * could be rebuilt from the many values a rendered challenge shows and the next answer predicted.
 */
export const secureRandom: Rng = () => randomInt(0, 2 ** 32) / 2 ** 32

/**
 * Glyphs on a 5×7 grid, one "x,y x,y …" string per stroke. Answer characters leave out look-alikes
 * (O Q D I L J Z S B U V G); 0, 1 and 5 exist for the math questions only.
 */
const STROKES: Record<string, string[]> = {
  '0': ['1,0 4,0 5,1 5,6 4,7 1,7 0,6 0,1 1,0'],
  '1': ['1,2 3,0 3,7', '1,7 5,7'],
  '2': ['0,1 1,0 4,0 5,1 5,3 0,7 5,7'],
  '3': ['0,0 5,0 3,3 5,4 5,6 4,7 0,7', '2,3 4,3'],
  '4': ['4,0 4,7', '0,0 0,4 5,4'],
  '5': ['5,0 0,0 0,3 4,3 5,4 5,6 4,7 0,7'],
  '6': ['5,0 1,0 0,2 0,6 1,7 4,7 5,6 5,4 4,3 0,3'],
  '7': ['0,0 5,0 2,7'],
  '8': ['1,0 4,0 5,1 5,2 4,3 1,3 0,2 0,1 1,0', '1,3 0,4 0,6 1,7 4,7 5,6 5,4 4,3'],
  '9': ['5,4 1,4 0,3 0,1 1,0 4,0 5,1 5,5 4,7 0,7'],
  A: ['0,7 0,2 2,0 4,0 5,2 5,7', '0,4 5,4'],
  C: ['5,0 1,0 0,1 0,6 1,7 5,7'],
  E: ['5,0 0,0 0,7 5,7', '0,3 4,3'],
  F: ['0,7 0,0 5,0', '0,3 4,3'],
  H: ['0,0 0,7', '5,0 5,7', '0,3 5,3'],
  K: ['0,0 0,7', '5,0 0,4 5,7'],
  M: ['0,7 0,0 2.5,3 5,0 5,7'],
  N: ['0,7 0,0 5,7 5,0'],
  P: ['0,7 0,0 4,0 5,1 5,3 4,4 0,4'],
  R: ['0,7 0,0 4,0 5,1 5,3 4,4 0,4', '2,4 5,7'],
  T: ['0,0 5,0', '2.5,0 2.5,7'],
  W: ['0,0 1,7 2.5,4 4,7 5,0'],
  X: ['0,0 5,7', '5,0 0,7'],
  Y: ['0,0 2.5,3 5,0', '2.5,3 2.5,7'],
  '+': ['2.5,1 2.5,6', '0,3.5 5,3.5'],
  '−': ['0,3.5 5,3.5'],
  '×': ['0,1 5,6', '5,1 0,6'],
  '=': ['0,2 5,2', '0,5 5,5'],
  '?': ['0,1 1,0 4,0 5,1 5,2 2.5,4', '2.5,6.5 2.5,7'],
}
const glyphs = new Map(
  Object.entries(STROKES).map(([char, strokes]) => [
    char,
    strokes.map((s) => s.split(' ').map((p) => p.split(',').map(Number) as unknown as Point)),
  ]),
)

export const CAPTCHA_CHAR_ALPHABET = 'ACEFHKMNPRTWXY234679'
export const CAPTCHA_GLYPHS = [...glyphs.keys()]
export const CAPTCHA_WIDTH = 130
export const CAPTCHA_HEIGHT = 48

const pick = (rng: Rng, max: number) => Math.floor(rng() * max)
const between = (rng: Rng, a: number, b: number) => a + rng() * (b - a)
const fmt = (n: number) => n.toFixed(1)
const clamp = (n: number, max: number) => Math.max(2, Math.min(max - 2, n))

/** `a op b = ?` with operands 1–9 (0 would make "0" a frequent blind guess); never negative. */
export function makeMathChallenge(rng: Rng = secureRandom): { text: string; answer: string } {
  const op = ['+', '−', '×'][pick(rng, 3)]!
  let a = 1 + pick(rng, 9)
  let b = 1 + pick(rng, 9)
  if (op === '−' && a < b) [a, b] = [b, a]
  return {
    text: `${a} ${op} ${b} = ?`,
    answer: String(op === '+' ? a + b : op === '−' ? a - b : a * b),
  }
}

/** Four characters of the unambiguous alphabet; the answer is compared upper-cased. */
export function makeCharsChallenge(rng: Rng = secureRandom): { text: string; answer: string } {
  const text = Array.from(
    { length: 4 },
    () => CAPTCHA_CHAR_ALPHABET[pick(rng, CAPTCHA_CHAR_ALPHABET.length)],
  ).join('')
  return { text, answer: text }
}

/** 0–2 jittered points inside every segment: a stroke's point count is never the table's. */
const subdivide = (stroke: Point[], rng: Rng): Point[] =>
  stroke.flatMap((point, j) => {
    if (!j) return [point]
    const [px, py] = stroke[j - 1]!
    const n = pick(rng, 3)
    const extra = Array.from({ length: n }, (_, k): Point => {
      const t = (k + 1) / (n + 1)
      const jitter = () => between(rng, -0.15, 0.15)
      return [px + (point[0] - px) * t + jitter(), py + (point[1] - py) * t + jitter()]
    })
    return [...extra, point]
  })

/**
 * The text (spaces ignored) as SVG paths with the scale, rotation, offset and a per-point jitter
 * baked into the coordinates, so the same character never gives the same path data; noise curves and
 * dots use overlapping stroke widths and the draw order is shuffled. No text, fonts or transforms.
 */
export function renderCaptchaSvg(text: string, rng: Rng = Math.random): string {
  const chars = [...text].filter((c) => c !== ' ')
  const paths: { d: string; width: number }[] = []
  // five math glyphs share the width of four characters
  const size = chars.length > 4 ? 3.1 : 3.8
  const step = chars.length > 1 ? 84 / (chars.length - 1) : 0
  chars.forEach((char, i) => {
    const strokes = glyphs.get(char)
    if (!strokes) throw new Error(`Missing captcha glyph: ${char}`)
    const scale = size * between(rng, 0.85, 1.15)
    // operators turn less: a tilted − or = reads as a stroke of noise
    const tilt = /[A-Z0-9]/.test(char) ? 25 : 8
    const angle = (between(rng, -tilt, tilt) * Math.PI) / 180
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)]
    const cx = (chars.length > 1 ? 23 + i * step : 65) + between(rng, -1.5, 1.5)
    const cy = 24 + between(rng, -3, 3)
    for (const stroke of strokes) {
      const d = subdivide(stroke, rng).map(([x, y], j) => {
        const [dx, dy] = [(x - 2.5) * scale, (y - 3.5) * scale]
        const px = clamp(cx + dx * cos - dy * sin + between(rng, -0.4, 0.4), CAPTCHA_WIDTH)
        const py = clamp(cy + dx * sin + dy * cos + between(rng, -0.4, 0.4), CAPTCHA_HEIGHT)
        return `${j ? 'L' : 'M'}${fmt(px)} ${fmt(py)}`
      })
      paths.push({ d: d.join(' '), width: between(rng, 2.1, 2.7) })
    }
  })
  for (let i = 0, n = 2 + pick(rng, 2); i < n; i++) {
    const [x0, y0] = [between(rng, 0, 40), between(rng, 5, 43)]
    const [qx, qy] = [between(rng, 30, 100), between(rng, 0, 48)]
    const [x1, y1] = [between(rng, 90, 130), between(rng, 5, 43)]
    const d = `M${fmt(x0)} ${fmt(y0)} Q${fmt(qx)} ${fmt(qy)} ${fmt(x1)} ${fmt(y1)}`
    paths.push({ d, width: between(rng, 1.2, 2.2) })
  }
  for (let i = 0, n = 15 + pick(rng, 11); i < n; i++) {
    const [x, y] = [between(rng, 0, CAPTCHA_WIDTH), between(rng, 0, CAPTCHA_HEIGHT)]
    const [dx, dy] = [between(rng, -0.6, 0.6), between(rng, -0.6, 0.6)]
    paths.push({ d: `M${fmt(x)} ${fmt(y)} l${fmt(dx)} ${fmt(dy)}`, width: between(rng, 1.2, 2.2) })
  }
  for (let i = paths.length - 1; i > 0; i--) {
    const j = pick(rng, i + 1)
    ;[paths[i], paths[j]] = [paths[j]!, paths[i]!]
  }
  const ink = ['#354b63', '#435a70', '#52647b']
  const bg = () => 245 + pick(rng, 8)
  const body = paths
    .map(
      ({ d, width }) =>
        `<path d="${d}" stroke="${ink[pick(rng, ink.length)]}" stroke-width="${fmt(width)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CAPTCHA_WIDTH}" height="${CAPTCHA_HEIGHT}" viewBox="0 0 ${CAPTCHA_WIDTH} ${CAPTCHA_HEIGHT}"><rect width="${CAPTCHA_WIDTH}" height="${CAPTCHA_HEIGHT}" fill="rgb(${bg()},${bg()},${bg()})"/>${body}</svg>`
}
