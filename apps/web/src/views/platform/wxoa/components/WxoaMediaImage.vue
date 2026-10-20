<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { wxoaImageUrl } from '@qiwu/shared'
import { storageApi } from '@/api/platform/storage/object'
import { Icon } from '@/core/icons'

/**
 * An official account's image (see docs/design-notes.md#wxoa): the local copy (`objectId`, read with the
 * token as a blob) whenever there is one; else the WeChat link `url` only on the two mmbiz hosts
 * (`wxoaImageUrl`), sent without a Referer; else a placeholder. With `preview` a local copy opens large
 * on click (the viewer cannot drop the Referer, so a remote image stays a thumbnail).
 */
defineOptions({ name: 'WxoaMediaImage' })
const {
  objectId = null,
  url = null,
  alt = '',
  preview = false,
} = defineProps<{
  objectId?: number | null
  url?: string | null
  alt?: string
  preview?: boolean
}>()
const { t } = useI18n()

/** the local copy's object URL; '' while loading or when it failed (the request layer said why) */
const blobUrl = ref('')
let seq = 0
function drop() {
  seq++
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value)
  blobUrl.value = ''
}
watch(
  () => objectId,
  async (id) => {
    drop()
    if (id == null) return
    const mine = seq
    const blob = await storageApi.blob(id).catch(() => null)
    // another image or unmounted meanwhile: no URL to leak
    if (blob && mine === seq) blobUrl.value = URL.createObjectURL(blob)
  },
  { immediate: true },
)
onBeforeUnmount(drop)

const remote = computed(() => (objectId == null ? wxoaImageUrl(url) : null))
const src = computed(() => blobUrl.value || remote.value || '')
const viewing = ref(false)
</script>

<template>
  <button
    v-if="preview && blobUrl"
    type="button"
    class="wxoa-media-image wxoa-media-image--button"
    :aria-label="t('wxoa.material.previewLarge', { name: alt })"
    @click="viewing = true"
  >
    <img :src="blobUrl" :alt="alt" class="wxoa-media-image__img" />
  </button>
  <img
    v-else-if="src"
    :src="src"
    :alt="alt"
    referrerpolicy="no-referrer"
    class="wxoa-media-image wxoa-media-image__img"
  />
  <span v-else class="wxoa-media-image wxoa-media-image__placeholder" role="img" :aria-label="alt">
    <Icon icon="lucide:image" />
  </span>
  <el-image-viewer
    v-if="viewing && blobUrl"
    :url-list="[blobUrl]"
    hide-on-click-modal
    teleported
    @close="viewing = false"
  />
</template>

<style scoped>
.wxoa-media-image {
  box-sizing: border-box;
  display: inline-grid;
  place-items: center;
  width: 64px;
  height: 64px;
  overflow: hidden;
  vertical-align: middle;
  background: var(--qw-surface-2);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm);
}
.wxoa-media-image--button {
  padding: 0;
  cursor: zoom-in;
}
.wxoa-media-image--button:focus-visible {
  outline: 2px solid var(--qw-brand);
  outline-offset: 1px;
}
.wxoa-media-image__img {
  object-fit: cover;
}
.wxoa-media-image--button .wxoa-media-image__img {
  width: 100%;
  height: 100%;
}
.wxoa-media-image__placeholder {
  font-size: 22px;
  color: var(--qw-text-3);
}
</style>
