<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useImCallsStore } from '@/core/im/calls-store'
const props = defineProps<{ connectionId: string; participantId: string }>()
const calls = useImCallsStore(),
  host = ref<HTMLElement>()
let off: (() => void) | null = null
function bind() {
  off?.()
  off = host.value
    ? calls.media.attachVideo(host.value, props.connectionId, props.participantId)
    : null
}
onMounted(bind)
watch(() => [props.connectionId, props.participantId], bind)
onBeforeUnmount(() => off?.())
</script>
<template><div ref="host" class="im-call-video" /></template>
<style scoped>
.im-call-video {
  aspect-ratio: 4 / 3;
  overflow: hidden;
  background: var(--qw-surface-2);
  border-radius: var(--qw-radius);
}
</style>
