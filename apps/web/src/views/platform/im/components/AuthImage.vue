<script setup lang="ts">
import { ref, watch } from 'vue'
import { useImStore } from '@/core/im/im-store'

/**
 * 授权图片：按缓存键从本地附件缓存取，没有才经 `fetch` 下载（带登录令牌）并存进缓存；显示对象 URL。
 * 同一个键（同一缩略图、同一表情）整个会话只下载一次。
 */
defineOptions({ name: 'ImAuthImage' })
const props = defineProps<{
  blobKey: string
  roomId: number | null
  fetch: () => Promise<Blob>
  alt: string
}>()
const im = useImStore()
const src = ref('')
const failed = ref(false)

watch(
  () => props.blobKey,
  async (key) => {
    failed.value = false
    try {
      const url = await im.blobUrl(key, props.roomId, props.fetch)
      if (key === props.blobKey) src.value = url
    } catch {
      if (key === props.blobKey) failed.value = true
    }
  },
  { immediate: true },
)
</script>

<template>
  <img v-if="src" :src="src" :alt="alt" class="im-auth-image" draggable="false" />
  <span v-else class="im-auth-image im-auth-image--empty" role="img" :aria-label="alt">
    {{ failed ? '!' : '' }}
  </span>
</template>

<style scoped>
.im-auth-image {
  display: block;
  max-width: 100%;
  max-height: 100%;
  border-radius: var(--qw-radius-sm);
}
.im-auth-image--empty {
  width: 120px;
  height: 90px;
  background: var(--qw-surface-2);
}
</style>
