import { inspectImVoice } from '../../src/modules/platform/im/im-voice.js'
import { pcmVoice } from '../e2e/im-media-kit.js'

describe('voice metadata boundaries', () => {
  it('reads authoritative duration from complete signed 16-bit little-endian mono and stereo PCM', async () => {
    for (const channels of [1, 2])
      for (const rate of [8000, 16000, 44100]) {
        expect(await inspectImVoice(pcmVoice(0.2, rate, channels), 60)).toBe(200)
      }
  })
  it('rejects float, compressed, different bit width, channels, rate, endian, empty and truncated inputs', async () => {
    const reversed = pcmVoice()
    reversed.write('RIFX')
    const forged = pcmVoice()
    forged.writeUInt32LE(100000, 40)
    for (const data of [
      Buffer.alloc(0),
      Buffer.from('not audio'),
      pcmVoice(0.1, 48000),
      pcmVoice(0.1, 16000, 3),
      pcmVoice(0.1, 16000, 1, 8),
      pcmVoice(0.1, 16000, 1, 32, 3),
      pcmVoice(0.1, 16000, 1, 16, 6),
      reversed,
      forged,
      pcmVoice().subarray(0, 45),
    ]) {
      await expect(inspectImVoice(data, 60)).rejects.toMatchObject({ err: { code: 'B5020' } })
    }
  })
  it('rejects positive audio longer than the current server limit', async () => {
    await expect(inspectImVoice(pcmVoice(1.1), 1)).rejects.toMatchObject({ err: { code: 'B5021' } })
  })
  it('rejects forged sample stride and fact lengths instead of trusting a shortened parsed duration', async () => {
    const stride = pcmVoice(2)
    stride.writeUInt16LE(64000, 32)
    const byteRate = pcmVoice(2)
    byteRate.writeUInt32LE(1, 28)
    const original = pcmVoice(2)
    const fact = Buffer.alloc(12)
    fact.write('fact')
    fact.writeUInt32LE(4, 4)
    fact.writeUInt32LE(1, 8)
    const withFact = Buffer.concat([original.subarray(0, 36), fact, original.subarray(36)])
    withFact.writeUInt32LE(withFact.length - 8, 4)
    for (const forged of [stride, byteRate, withFact])
      await expect(inspectImVoice(forged, 1)).rejects.toMatchObject({ err: { code: 'B5020' } })
  })
})

function withInfo(data: Buffer, chunks: number, bytes = 4): Buffer {
  const chunk = Buffer.alloc(8 + bytes + (bytes % 2))
  chunk.write('LIST')
  chunk.writeUInt32LE(bytes, 4)
  chunk.write('INFO', 8)
  if (bytes > 4) {
    chunk.write('INAM', 12)
    chunk.writeUInt32LE(bytes - 12, 16)
    chunk.fill(65, 20, 8 + bytes)
  }
  const joined = Buffer.concat([
    data.subarray(0, 36),
    ...Array.from({ length: chunks }, () => chunk),
    data.subarray(36),
  ])
  joined.writeUInt32LE(joined.length - 8, 4)
  return joined
}

it('bounds valid RIFF chunk count including the format and audio chunks', async () => {
  expect(await inspectImVoice(withInfo(pcmVoice(0.2), 1022), 60)).toBe(200)
  await expect(inspectImVoice(withInfo(pcmVoice(0.2), 1023), 60)).rejects.toMatchObject({
    err: { code: 'B5020' },
  })
})
it('bounds valid metadata bytes including the PCM format block', async () => {
  expect(await inspectImVoice(withInfo(pcmVoice(0.2), 1, 64 * 1024 - 16), 60)).toBe(200)
  await expect(
    inspectImVoice(withInfo(pcmVoice(0.2), 1, 64 * 1024 - 14), 60),
  ).rejects.toMatchObject({ err: { code: 'B5020' } })
})
it('rejects mismatched RIFF container sizes even when the inner audio chunks are complete', async () => {
  for (const delta of [-2, 2]) {
    const data = pcmVoice(0.2)
    data.writeUInt32LE(data.length - 8 + delta, 4)
    await expect(inspectImVoice(data, 60)).rejects.toMatchObject({ err: { code: 'B5020' } })
  }
})

it('rejects a non-16-bit container even when its declared byte rate and stride match 16-bit capacity', async () => {
  const data = pcmVoice(0.2, 16000, 1, 8)
  data.writeUInt16LE(2, 32)
  data.writeUInt32LE(32000, 28)
  await expect(inspectImVoice(data, 60)).rejects.toMatchObject({ err: { code: 'B5020' } })
})
it('rejects a forged stride even when a fact chunk supplies the correct sample duration', async () => {
  const data = pcmVoice(0.2)
  data.writeUInt16LE(64000, 32)
  const fact = Buffer.alloc(12)
  fact.write('fact')
  fact.writeUInt32LE(4, 4)
  fact.writeUInt32LE(3200, 8)
  const joined = Buffer.concat([data.subarray(0, 36), fact, data.subarray(36)])
  joined.writeUInt32LE(joined.length - 8, 4)
  await expect(inspectImVoice(joined, 60)).rejects.toMatchObject({ err: { code: 'B5020' } })
})
