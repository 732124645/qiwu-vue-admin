// 内置表情素材：清单里每个编码在 web 与移动分包两处都有字节相同的 PNG，原稿也在，且没有清单外的文件
// （删掉了 mobile/ 的项目只检查 web 与原稿）。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { IM_STICKER_CODES } from './stickers.js'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const WEB = `${root}apps/web/public/im/stickers`
const MOBILE = `${root}mobile/src/pages-im/static/stickers`
const SOURCE = `${root}scripts/im-stickers`
const hasMobile = existsSync(`${root}mobile/src`)
const PNG_MAGIC = '89504e470d0a1a0a'

const files = (dir: string, ext: string) =>
  readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .map((f) => (f.endsWith(ext) ? f.slice(0, -ext.length) : f))
    .sort()

const codes = [...IM_STICKER_CODES].sort()

it('every code has its original source and a PNG on the web, nothing else', () => {
  expect(files(SOURCE, '.svg')).toEqual(codes)
  expect(files(WEB, '.png')).toEqual(codes)
  // 每个都是 240×240 的 PNG（文件头魔数 + IHDR 的宽高）
  const shapes = codes.map((code) => {
    const png = readFileSync(`${WEB}/${code}.png`)
    return [code, png.subarray(0, 8).toString('hex'), png.readUInt32BE(16), png.readUInt32BE(20)]
  })
  expect(shapes).toEqual(codes.map((code) => [code, PNG_MAGIC, 240, 240]))
})

it.skipIf(!hasMobile)('the mobile subpackage carries the same bytes, nothing else', () => {
  expect(files(MOBILE, '.png')).toEqual(codes)
  const differ = codes.filter(
    (code) => !readFileSync(`${MOBILE}/${code}.png`).equals(readFileSync(`${WEB}/${code}.png`)),
  )
  expect(differ).toEqual([])
})
