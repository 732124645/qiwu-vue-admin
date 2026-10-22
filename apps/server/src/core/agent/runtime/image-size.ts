/**
 * 图片的实际宽高，从文件头读出（PNG、GIF、JPEG、WebP）；认不出时为 null（条目里就不填）。只看头部字节，
 * 不解码图片。
 */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  const ok = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null)
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47)
    return ok(b.readUInt32BE(16), b.readUInt32BE(20))
  if (b.length >= 10 && b.toString('latin1', 0, 4) === 'GIF8')
    return ok(b.readUInt16LE(6), b.readUInt16LE(8))
  if (
    b.length >= 30 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP'
  ) {
    const chunk = b.toString('latin1', 12, 16)
    if (chunk === 'VP8 ') return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff)
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21)
      return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
    }
    if (chunk === 'VP8X') return ok(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1)
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // JPEG：逐段找帧头（SOF0–SOF15，除去 DHT、JPG、DAC）
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]!
      const len = b.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return ok(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5))
      i += 2 + len
    }
  }
  return null
}
