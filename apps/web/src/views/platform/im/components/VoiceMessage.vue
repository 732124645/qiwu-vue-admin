<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { imBlobKey, type ImEntryRecord } from '@qiwu/shared/im-client'
import { imApi } from '@/api/platform/im'
import { useImStore } from '@/core/im/im-store'
import { setImVoicePlayback, clearImVoicePlayback } from '@/core/im/voice'

const props = defineProps<{ entry: ImEntryRecord; roomId: number }>()
const { t } = useI18n(),
  im = useImStore()
const busy = ref(false),
  playing = ref(false)
const seconds = computed(() =>
  Math.max(1, Math.ceil((props.entry.attachment?.durationMs ?? 0) / 1000)),
)
let generation = 0,
  audio: HTMLAudioElement | null = null
/** 清空 src 与退役代次一起执行，迟到下载和播放回调不能恢复旧消息。 */
function stop() {
  clearImVoicePlayback(stop)
  generation++
  const previous = audio
  audio = null
  previous?.pause()
  if (previous) {
    previous.removeAttribute('src')
    previous.load()
  }
  playing.value = busy.value = false
}
async function play() {
  if (playing.value || busy.value) {
    stop()
    return
  }
  const attachment = props.entry.attachment
  if (!attachment || props.entry.recalledAt || im.state === 'locked' || im.state === 'disabled')
    return
  setImVoicePlayback(stop)
  const at = ++generation
  busy.value = true
  try {
    const url = await im.blobUrl(imBlobKey.object(attachment.objectId), props.roomId, () =>
      imApi.entryFile(props.roomId, props.entry.seq),
    )
    if (at !== generation) return
    const next = new Audio(url)
    audio = next
    next.onended = () => {
      if (audio === next) stop()
    }
    next.onerror = () => {
      if (audio === next) {
        stop()
        ElMessage.error(t('im.voice.playFailed'))
      }
    }
    await next.play()
    if (at === generation) playing.value = true
  } catch {
    if (at === generation) {
      stop()
      ElMessage.error(t('im.voice.playFailed'))
    }
  } finally {
    if (at === generation) busy.value = false
  }
}
watch(
  [
    () => props.entry.recalledAt,
    () => props.entry.attachment?.objectId,
    () => ['locked', 'disabled', 'idle'].includes(im.state),
  ],
  stop,
)
onBeforeUnmount(stop)
onDeactivated(stop)
</script>
<template>
  <el-button
    :loading="busy"
    :aria-label="t(playing ? 'im.voice.stop' : 'im.voice.play', { seconds })"
    :aria-pressed="playing"
    @click="play"
  >
    {{ t(playing ? 'im.voice.stop' : 'im.voice.play', { seconds }) }}
  </el-button>
</template>
