import { Err, IM_VOICE_LIMITS } from '@qiwu/shared'
import { parseBuffer, TrackType } from 'music-metadata'
import { BizError } from '../../../core/http/biz-error.js'

/** 只接收完整的小端 PCM WAV；时长来自解析器，并用实际字节数约束样本声明。 */
export async function inspectImVoice(data: Buffer, maxSeconds: number): Promise<number> {
  const invalid = () => new BizError(Err.IM_VOICE_INVALID)
  if (
    data.length < 44 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WAVE' ||
    data.readUInt32LE(4) + 8 !== data.length
  )
    throw invalid()
  // 先限制容器块数量与物理边界，避免畸形 RIFF 让成熟解析器在大量空块上消耗无界时间。
  let position = 12,
    chunks = 0,
    metadataBytes = 0,
    formats = 0,
    audioChunks = 0,
    formatOffset = 0,
    audioBytes = 0
  while (position < data.length) {
    if (++chunks > 1024 || position + 8 > data.length) throw invalid()
    const name = data.toString('ascii', position, position + 4)
    const size = data.readUInt32LE(position + 4)
    if (name === 'fmt ') {
      if (++formats > 1 || size < 16 || size > 128) throw invalid()
      formatOffset = position + 8
    }
    if (name === 'data') {
      if (++audioChunks > 1) throw invalid()
      audioBytes = size
    } else if ((metadataBytes += size) > 64 * 1024) throw invalid()
    position += 8 + size + (size % 2)
    if (position > data.length) throw invalid()
  }
  if (formats !== 1 || audioChunks !== 1) throw invalid()
  try {
    const metadata = await parseBuffer(
      data,
      { mimeType: 'audio/wav', size: data.length },
      { duration: true, skipCovers: true },
    )
    const f = metadata.format
    if (
      f.codec !== 'PCM' ||
      f.bitsPerSample !== 16 ||
      ![1, 2].includes(f.numberOfChannels ?? 0) ||
      !(IM_VOICE_LIMITS.sampleRates as readonly number[]).includes(f.sampleRate ?? 0) ||
      !Number.isFinite(f.duration) ||
      !f.duration ||
      f.duration <= 0 ||
      metadata.quality.warnings.length ||
      (f.trackInfo ?? []).some((track) => track.type === TrackType.video)
    )
      throw invalid()
    // PCM 的字节步长固定；解析器会信任 blockAlign/fact，必须与实际样本容量相等以防伪造短时长。
    const stride = f.numberOfChannels! * 2
    if (
      data.readUInt16LE(formatOffset) !== 1 ||
      data.readUInt16LE(formatOffset + 12) !== stride ||
      data.readUInt32LE(formatOffset + 8) !== f.sampleRate! * stride ||
      audioBytes % stride !== 0 ||
      Math.abs(f.duration * f.sampleRate! * stride - audioBytes) > 0.001
    )
      throw invalid()
    const durationMs = Math.ceil(f.duration * 1000)
    if (durationMs > maxSeconds * 1000) throw new BizError(Err.IM_VOICE_TOO_LONG)
    return durationMs
  } catch (error) {
    if (error instanceof BizError) throw error
    throw invalid()
  }
}
