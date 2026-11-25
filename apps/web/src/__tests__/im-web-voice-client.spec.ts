import { Blob as NativeBlob } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { createMemoryCache, type ImOutboxRecord } from '@qiwu/shared/im-client'
import { previewText, eventText } from '@/views/platform/im/components/im-view'
import { setLocale } from '@/core/i18n'
import type { ImEntry } from '@qiwu/shared'

describe('voice local data', () => {
  it('persists the voice Blob with a stable reference and deletes it only with its acknowledged outbox row', async () => {
    const cache = createMemoryCache('voice-account')
    const blob = new NativeBlob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' })
    const item: ImOutboxRecord = {
      clientEntryId: 'voice-a',
      roomId: 10,
      kind: 'voice',
      file: { name: 'voice.wav', size: 3, mime: 'audio/wav', localRef: 'v:voice-a', body: blob },
      state: 'pending',
      attempts: 0,
      createdAt: 1,
      nextAttemptAt: 1,
    }
    await cache.putOutbox(item)
    const restored = (await cache.listOutbox())[0]!
    expect(restored.file?.localRef).toBe('v:voice-a')
    expect(restored.file?.body).toBeInstanceOf(NativeBlob)
    expect([...new Uint8Array(await (restored.file!.body as NativeBlob).arrayBuffer())]).toEqual([
      1, 2, 3,
    ])
    await expect(
      cache.tx(async (tx) => {
        await tx.deleteOutbox('voice-a')
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await cache.listOutbox()).toHaveLength(1)
    await cache.deleteOutbox('voice-a')
    expect(await cache.listOutbox()).toEqual([])
    await cache.destroy()
  })
  it('renders voice and call history in both languages without treating media as plain text', async () => {
    const preview = {
      seq: 1,
      kind: 'voice' as const,
      authorId: 7,
      authorLabel: 'Ann',
      text: null,
      stickerCode: null,
      eventCode: null,
      recalled: false,
      at: '',
    }
    for (const locale of ['zh-CN', 'en-US'] as const) {
      await setLocale(locale)
      expect(previewText(preview)).toBeTruthy()
      const row = {
        event: {
          code: 'call.ended',
          actorId: 7,
          call: { callId: 1, mode: 'audio', durationSeconds: 30, endReason: 'ended' },
        },
      } as ImEntry
      const text = eventText(row, new Map())
      expect(text).toContain('30')
      expect(text).not.toContain('im.calls.')
    }
    await setLocale('zh-CN')
  })
})
