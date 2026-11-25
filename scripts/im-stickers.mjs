// 内置聊天表情的构建步骤：把 scripts/im-stickers/<code>.svg 原稿转成 240×240 PNG，写到 web 的
// public/im/stickers/ 与移动端分包 pages-im/static/stickers/（同一份字节），并删掉不再有原稿的旧 PNG。
// 用 apps/server 已有的 sharp（不新增依赖）。改了原稿后运行：node scripts/im-stickers.mjs
// 清单是 packages/shared/src/platform/im/stickers.ts；im-sticker-assets 规格核对两处 PNG 与清单一致。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sharp = createRequire(join(root, 'apps/server/package.json'))('sharp')
const src = join(root, 'scripts/im-stickers')
const outs = [join(root, 'apps/web/public/im/stickers')]
const MOBILE = join(root, 'mobile/src/pages-im/static/stickers')
// 删掉 mobile/ 的项目只生成 web 一份
if (existsSync(join(MOBILE, '../../..'))) outs.push(MOBILE)

const SIZE = 240
const codes = readdirSync(src)
  .filter((f) => f.endsWith('.svg'))
  .map((f) => f.slice(0, -4))
  .sort()

for (const out of outs) {
  mkdirSync(out, { recursive: true })
  for (const f of readdirSync(out))
    if (f.endsWith('.png') && !codes.includes(f.slice(0, -4))) rmSync(join(out, f))
}
for (const code of codes) {
  // 原稿 viewBox 240：按 72dpi 栅格化即 240px；固定压缩参数让同一原稿得到同样的字节
  const png = await sharp(readFileSync(join(src, `${code}.svg`)), { density: 72 })
    .resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer()
  for (const out of outs) writeFileSync(join(out, `${code}.png`), png)
}
console.log(`im-stickers: ${codes.length} stickers → ${outs.length} folder(s)`)
