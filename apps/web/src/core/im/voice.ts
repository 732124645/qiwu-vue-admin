import { createBrowserVoiceRecorder } from '@qiwu/shared/im-media'

export const imVoiceRecorder = createBrowserVoiceRecorder()
let stopPlaying: (() => void) | null = null
/** 一个端同时只播放一条语音，切换、开始录音或通话都先停掉旧播放器。 */
export function setImVoicePlayback(stop: () => void) {
  stopPlaying?.()
  stopPlaying = stop
}
export function clearImVoicePlayback(stop: () => void) {
  if (stopPlaying === stop) stopPlaying = null
}
export function stopImVoicePlayback() {
  stopPlaying?.()
  stopPlaying = null
}
export function stopImVoice() {
  imVoiceRecorder.cancel()
  stopImVoicePlayback()
}
