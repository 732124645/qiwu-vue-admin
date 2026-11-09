<template><view ref="host" class="qw-im-video" /></template>
<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue'
// #ifdef H5
import { imBrowserMedia } from '@/core/im/media'
// #endif
const props = defineProps<{ connectionId: string; participantId: string }>()
const host = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
let generation = 0
let detach: (() => void) | undefined
watch(
  () => [props.connectionId, props.participantId],
  async () => {
    const at = ++generation
    detach?.()
    detach = undefined
    await nextTick()
    if (at !== generation) return
    // #ifdef H5
    const node = host.value && ('$el' in host.value ? host.value.$el : host.value)
    if (node instanceof HTMLElement) {
      try {
        detach = imBrowserMedia().attachVideo(node, props.connectionId, props.participantId)
      } catch {
        /* 连接状态由宿主统一显示，视频组件不传播 SDK 原始错误。 */
      }
    }
    // #endif
  },
  { immediate: true, flush: 'post' },
)
onUnmounted(() => {
  generation++
  detach?.()
})
</script>
<style>
.qw-im-video {
  width: 100%;
  height: 360rpx;
  overflow: hidden;
  background: var(--qw-canvas);
  border-radius: var(--qw-radius-lg);
}
.qw-im-video video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
