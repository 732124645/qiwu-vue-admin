// Slider captcha: a procedural background and a jigsaw piece cut from it, go-captcha-vue's data
// contract {image, thumb, thumbX, thumbY, thumbWidth, thumbHeight}; nothing is read from disk.
import sharp from 'sharp'
import { type Rng, secureRandom } from './captcha-image.js'

const WIDTH = 300
const HEIGHT = 220
const PIECE = 60
const pick = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1))
const color = (rng: Rng) => `rgb(${pick(rng, 90, 235)},${pick(rng, 90, 235)},${pick(rng, 90, 235)})`
const dataUrl = (mime: string, bytes: Buffer) =>
  `data:image/${mime};base64,${bytes.toString('base64')}`

// The two protrusions fit inside the 60 px box; the flat center stays easy to align by eye.
const PIECE_PATH = 'M8 8 H24 C24 0 36 0 36 8 H52 V24 C60 24 60 36 52 36 V52 H8 Z'

function background(rng: Rng): string {
  const stopCount = pick(rng, 2, 3)
  const stops = Array.from(
    { length: stopCount },
    (_, i) => `<stop offset="${(i / (stopCount - 1)) * 100}%" stop-color="${color(rng)}"/>`,
  ).join('')
  const shapes = Array.from({ length: pick(rng, 10, 16) }, () => {
    const x = pick(rng, 0, WIDTH)
    const y = pick(rng, 0, HEIGHT)
    const size = pick(rng, 12, 56)
    const fill = color(rng)
    const opacity = (pick(rng, 20, 60) / 100).toFixed(2)
    const angle = pick(rng, -45, 45)
    const shape = pick(rng, 0, 2)
    const body =
      shape === 0
        ? `<circle cx="0" cy="0" r="${size / 2}"/>`
        : shape === 1
          ? `<rect x="${-size / 2}" y="${-size / 2}" width="${size}" height="${size}"/>`
          : `<polygon points="0,${-size / 2} ${size / 2},${size / 2} ${-size / 2},${size / 2}"/>`
    return `<g transform="translate(${x} ${y}) rotate(${angle})" fill="${fill}" opacity="${opacity}">${body}</g>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><defs><linearGradient id="g" x2="1" y2="1">${stops}</linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${shapes}</svg>`
}

const pieceSvg = (fill: string, stroke: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PIECE}" height="${PIECE}"><path d="${PIECE_PATH}" fill="${fill}" stroke="${stroke}" stroke-width="2"/></svg>`,
  )

/**
 * A 300×220 JPEG with the piece's hole darkened, the 60×60 PNG piece (transparent outside its shape)
 * and the answer: the piece box's top-left in image pixels. `thumbX` is the piece's start column (0);
 * `thumbY` is its row, so only x is to be found.
 */
export async function sliderChallenge(rng: Rng = secureRandom) {
  const x = pick(rng, PIECE + 10, WIDTH - PIECE - 10)
  const y = pick(rng, 10, HEIGHT - PIECE - 10)
  const clean = await sharp(Buffer.from(background(rng)))
    .png()
    .toBuffer()
  const mask = await sharp(pieceSvg('white', 'white')).png().toBuffer()
  const outline = await sharp(pieceSvg('none', 'rgba(255,255,255,0.9)')).png().toBuffer()
  const thumb = await sharp(clean)
    .extract({ left: x, top: y, width: PIECE, height: PIECE })
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }, { input: outline }])
    .png()
    .toBuffer()
  const hole = await sharp(pieceSvg('rgba(0,0,0,0.8)', 'rgba(255,255,255,0.6)')).png().toBuffer()
  const image = await sharp(clean)
    .composite([{ input: hole, left: x, top: y }])
    .jpeg({ quality: 85 })
    .toBuffer()
  return {
    image: dataUrl('jpeg', image),
    thumb: dataUrl('png', thumb),
    thumbX: 0,
    thumbY: y,
    thumbWidth: PIECE,
    thumbHeight: PIECE,
    answer: { x, y },
  }
}
