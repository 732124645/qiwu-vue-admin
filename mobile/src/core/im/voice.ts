import { shallowRef } from 'vue'
import { IM_VOICE_LIMITS } from '@qiwu/shared'
import type { ImEntryRecord, ImOutboxFile } from '@qiwu/shared/im-client'
import type { ImMediaFailure, ImVoiceRecorderOptions } from '@qiwu/shared/im-media'
// #ifdef H5
import { createBrowserVoiceRecorder } from '@qiwu/shared/im-media'
// #endif
// #ifdef APP-PLUS
import { copyIntoOutbox } from './file-picker-app'
import { removeLocalFile } from './cache-sqlite'
// #endif
import { createAppVoiceRecorder, type AppVoiceState } from './voice-recorder'
import { entryBlobUrl } from './blob-app'
import { imCurrent, imOptions } from './client'
import { imMedia, imMediaReserved, requestImMicrophonePermission } from './media'
import { currentSessionVersion, errorText } from '../request'
import { t } from '../i18n'

interface Recorder {
  start(options: ImVoiceRecorderOptions): Promise<void>
  stop(): void
  cancel(): void
  whenIdle?(): Promise<void>
}
export const imVoice = shallowRef<{
  state: AppVoiceState
  roomId: number | null
  startedAt: number
  error: string | null
}>({ state: 'idle', roomId: null, startedAt: 0, error: null })
export const imVoicePlaying = shallowRef<{
  roomId: number
  seq: number
  loading: boolean
  playing: boolean
} | null>(null)
let recorder: Recorder | null = null
let generation = 0
let visibleRoom: number | null = null
let audio: UniApp.InnerAudioContext | null = null
let playGeneration = 0

/** 媒体错误只选择本地译文，不显示原始 SDK 异常或路径。 */
export function voiceError(failure: ImMediaFailure): string {
  if (failure.code === 'TOO_LARGE')
    return t('imMedia.voice.tooLarge', {
      n: imOptions.value?.voiceMaxMb ?? IM_VOICE_LIMITS.defaultMb,
    })
  return t(
    failure.code === 'PERMISSION_DENIED'
      ? 'imMedia.voice.permissionDenied'
      : failure.code === 'BUSY'
        ? 'imMedia.voice.busy'
        : failure.code === 'SDK_UNAVAILABLE' || failure.code === 'UNSUPPORTED'
          ? 'imMedia.voice.unavailable'
          : 'imMedia.voice.failed',
  )
}
const update = (patch: Partial<typeof imVoice.value>) => {
  imVoice.value = { ...imVoice.value, ...patch }
}
const recordingState = (): AppVoiceState => imVoice.value.state
const voiceSeconds = () =>
  Math.max(
    1,
    Math.min(
      imOptions.value?.voiceMaxSeconds ?? IM_VOICE_LIMITS.defaultSeconds,
      IM_VOICE_LIMITS.maxSeconds,
    ),
  )
const voiceBytes = () =>
  Math.max(
    1,
    Math.min(imOptions.value?.voiceMaxMb ?? IM_VOICE_LIMITS.defaultMb, IM_VOICE_LIMITS.maxMb),
  ) *
  1024 *
  1024

function getRecorder(): Recorder {
  if (recorder) return recorder
  // #ifdef APP-PLUS
  if (process.env.UNI_PLATFORM === 'app') {
    recorder = createAppVoiceRecorder({
      manager: uni.getRecorderManager(),
      permission: requestImMicrophonePermission,
      keep: async (tempFilePath) => {
        const size = await new Promise<number>((resolve, reject) =>
          uni.getFileInfo({
            filePath: tempFilePath,
            success: (result) => resolve(result.size),
            fail: reject,
          }),
        )
        if (!Number.isSafeInteger(size) || size <= 0)
          throw { code: 'SDK_ERROR', operation: 'record' }
        if (size > voiceBytes()) throw { code: 'TOO_LARGE', operation: 'record' }
        const path = await copyIntoOutbox(tempFilePath, 'voice.wav')
        return { name: 'voice.wav', mime: 'audio/wav', size, localRef: path }
      },
      remove: removeLocalFile,
      state: (state) =>
        update({ state, ...(state === 'recording' ? { startedAt: Date.now() } : {}) }),
    })
    return recorder
  }
  // #endif
  // #ifdef H5
  if (process.env.UNI_PLATFORM === 'h5') {
    recorder = createBrowserVoiceRecorder()
    return recorder
  }
  // #endif
  throw { code: 'UNSUPPORTED', operation: 'record' } satisfies ImMediaFailure
}

function removeDraft(file: ImOutboxFile) {
  // #ifdef APP-PLUS
  if (process.env.UNI_PLATFORM === 'app') void removeLocalFile(file.localRef).catch(() => {})
  // #endif
}

/** 当前房间中的用户动作才可录音；授权、复制和入发件箱前都核对同一身份与代次。 */
export async function startImVoice(roomId: number): Promise<void> {
  if (process.env.UNI_PLATFORM === 'mp-weixin') return
  const ctx = imCurrent()
  if (!ctx || visibleRoom !== roomId || imOptions.value?.voiceEnabled !== true) return
  if (
    imMediaReserved.value ||
    imVoice.value.state !== 'idle' ||
    imMedia.getSnapshot().state !== 'idle'
  ) {
    update({ error: t('imMedia.voice.busy') })
    return
  }
  stopImVoicePlayback()
  const at = ++generation,
    session = currentSessionVersion()
  const current = () =>
    at === generation &&
    session === currentSessionVersion() &&
    ctx === imCurrent() &&
    visibleRoom === roomId
  update({ state: 'requesting', roomId, startedAt: 0, error: null })
  try {
    await getRecorder().start({
      maxSeconds: voiceSeconds(),
      onStop(file) {
        if (!current()) {
          removeDraft(file)
          return
        }
        update({ state: 'idle', roomId: null, startedAt: 0 })
        if (file.size <= 0 || file.size > voiceBytes()) {
          removeDraft(file)
          update({
            error: t('imMedia.voice.tooLarge', {
              n: imOptions.value?.voiceMaxMb ?? IM_VOICE_LIMITS.defaultMb,
            }),
          })
          return
        }
        void ctx.engine.send(roomId, { kind: 'voice', file }).catch((error: unknown) => {
          // 通知失败也可能发生在落库之后，不能删除已被发件箱持有的副本。
          void ctx.cache.listOutbox(roomId).then(
            (items) => {
              if (!items.some((item) => item.file?.localRef === file.localRef)) removeDraft(file)
            },
            () => {},
          )
          if (current()) update({ error: errorText(error) })
        })
      },
      onError(error) {
        if (!current()) return
        update({
          error: voiceError(error),
          ...(imVoice.value.state === 'stopping' ? {} : { state: 'idle' as const, roomId: null }),
        })
      },
    })
    if (current() && recordingState() === 'requesting')
      update({ state: 'recording', startedAt: Date.now() })
  } catch (error) {
    if (current())
      update({
        ...(recordingState() === 'stopping' ? {} : { state: 'idle' as const, roomId: null }),
        error: voiceError(error as ImMediaFailure),
      })
  }
}

/** 用户完成录音；保存与发送阶段由发件箱负责，不重复提交。 */
export function finishImVoice(): void {
  recorder?.stop()
}

/** 退役录音/播放；通话可等待真正的旧采集终局，身份变更不等待再继续清理。 */
export function cancelImVoice(): Promise<void> {
  generation++
  recorder?.cancel()
  stopImVoicePlayback()
  if (imVoice.value.state !== 'stopping') update({ state: 'idle', roomId: null, startedAt: 0 })
  return recorder?.whenIdle?.() ?? Promise.resolve()
}

/** 房间离开后，下载、授权和停止回调不得重新恢复媒体。 */
export function imVoiceRoomShow(roomId: number): void {
  if (visibleRoom !== null && visibleRoom !== roomId) void cancelImVoice().catch(() => {})
  visibleRoom = roomId
}
export function imVoiceRoomHide(roomId: number): void {
  if (visibleRoom !== roomId) return
  visibleRoom = null
  void cancelImVoice().catch(() => {})
}

/** 全端只保留一个播放器；显式切换、撤回与身份退役都会废弃旧回调。 */
export function stopImVoicePlayback(): void {
  playGeneration++
  const previous = audio
  audio = null
  imVoicePlaying.value = null
  if (previous) {
    try {
      previous.stop()
    } catch {
      /* 仍继续销毁失效的播放器。 */
    }
    try {
      previous.destroy()
    } catch {
      /* 不保留 SDK 对象或原始错误。 */
    }
  }
}

/** 经已有私有附件授权下载到本地后才播放，临时地址不携带登录令牌。 */
export async function playImVoice(roomId: number, entry: ImEntryRecord): Promise<void> {
  if (
    process.env.UNI_PLATFORM === 'mp-weixin' ||
    visibleRoom !== roomId ||
    entry.kind !== 'voice' ||
    entry.recalledAt ||
    !entry.attachment
  )
    return
  if (imVoicePlaying.value?.roomId === roomId && imVoicePlaying.value.seq === entry.seq) {
    stopImVoicePlayback()
    return
  }
  const ctx = imCurrent()
  if (
    !ctx ||
    imMediaReserved.value ||
    imMedia.getSnapshot().state !== 'idle' ||
    imVoice.value.state !== 'idle'
  )
    return
  stopImVoicePlayback()
  const at = playGeneration,
    session = currentSessionVersion()
  imVoicePlaying.value = { roomId, seq: entry.seq, loading: true, playing: false }
  const current = () =>
    at === playGeneration &&
    session === currentSessionVersion() &&
    ctx === imCurrent() &&
    visibleRoom === roomId
  try {
    const path = await entryBlobUrl(
      ctx.cache,
      roomId,
      entry.seq,
      entry.kind,
      entry.attachment,
      false,
    )
    if (!current()) return
    const player = uni.createInnerAudioContext()
    audio = player
    player.autoplay = false
    player.onPlay(() => {
      if (current() && audio === player)
        imVoicePlaying.value = { roomId, seq: entry.seq, loading: false, playing: true }
    })
    player.onEnded(() => {
      if (current() && audio === player) stopImVoicePlayback()
    })
    player.onError(() => {
      if (current() && audio === player) {
        stopImVoicePlayback()
        update({ error: t('imMedia.voice.playFailed') })
      }
    })
    player.src = path
    player.play()
  } catch {
    if (current()) {
      stopImVoicePlayback()
      update({ error: t('imMedia.voice.playFailed') })
    }
  }
}

/** 缓存中的播放行撤回或清理后立即停止，不让旧下载回调恢复声音。 */
export async function reconcileImVoice(): Promise<void> {
  const playing = imVoicePlaying.value,
    ctx = imCurrent()
  if (!playing || !ctx) return
  const row = await ctx.cache.getEntry(playing.roomId, playing.seq).catch(() => undefined)
  if (imVoicePlaying.value !== playing || ctx !== imCurrent()) return
  if (!row || row.recalledAt || !row.attachment) stopImVoicePlayback()
}
