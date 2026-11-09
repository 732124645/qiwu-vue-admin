/**
 * 内置表情清单（see docs/im.md）：24 个原创图案的稳定编码。图片是 web 的 `/im/stickers/<code>.png`
 * 与移动分包的 `static/stickers/<code>.png`（同一份素材），名称键 `im.sticker.<code>`（web 与移动各自的
 * 语言包）。编码一旦发布就不改不删：历史消息只存编码。
 */
export const IM_STICKER_CODES = [
  'smile',
  'laugh',
  'grin',
  'wink',
  'blush',
  'heart',
  'cool',
  'think',
  'wow',
  'sad',
  'cry',
  'angry',
  'sleepy',
  'sweat',
  'facepalm',
  'shrug',
  'thumbsup',
  'clap',
  'ok',
  'thanks',
  'cheers',
  'fighting',
  'coffee',
  'party',
] as const
export type ImStickerCode = (typeof IM_STICKER_CODES)[number]

/** 编码是否在内置清单里（发送时服务端与客户端都用它判定）。 */
export const isImStickerCode = (code: string): code is ImStickerCode =>
  (IM_STICKER_CODES as readonly string[]).includes(code)

/** 名称的 i18n 键。 */
export const imStickerNameKey = (code: ImStickerCode): string => `im.sticker.${code}`
