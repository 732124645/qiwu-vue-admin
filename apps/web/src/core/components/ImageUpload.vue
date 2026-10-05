<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FsObjectVo, StorageBizTag } from '@qiwu/shared'
import { storageApi } from '@/api/platform/storage/object'
import { formatSize, IMAGE_ACCEPT, useUpload } from '@/core/composables/use-upload'
import { Icon } from '@/core/icons'
import IconButton from './IconButton.vue'

/**
 * Image field (see docs/design-notes.md#layering, #storage): `v-model` = the stored images (`FsObjectVo[]`, `limit` 1 by default).
 * PNG/JPEG/GIF/WebP go to POST /api/storage/objects under `bizTag` (private by default; `cover` /
 * `richtext` / `avatar` are public; with `direct` straight to the primary S3 storage, presign → PUT →
 * confirm). Thumbnails and the viewer show a public image by its URL and a
 * private one through `fetchBlob` + an object URL (`<img>` cannot send the token), revoked when the image
 * leaves the list or the field unmounts. Removing drops the image from the list only.
 */
defineOptions({ name: 'ImageUpload' })
const {
  bizTag = 'attachment',
  limit = 1,
  maxSize,
  disabled = false,
  direct = false,
} = defineProps<{
  bizTag?: StorageBizTag
  limit?: number
  /**
   * bytes, checked before sending (unset: the server's limit, `storage.max_size_mb`); the server's own
   * limit still applies (413)
   */
  maxSize?: number
  disabled?: boolean
  /** upload straight to the primary S3 storage (presign → PUT → confirm); off: through the server */
  direct?: boolean
}>()
const model = defineModel<FsObjectVo[]>({ default: () => [] })
const { t } = useI18n()
const {
  pending,
  remaining,
  maxSize: sizeLimit,
  check,
  send,
  remove,
} = useUpload({
  model,
  bizTag: () => bizTag,
  limit: () => limit,
  maxSize: () => maxSize,
  direct: () => direct,
  images: true,
})

/** private images by id: 'loading', their object URL, or '' when the preview failed (the request layer said why) */
const blobs = reactive(new Map<number, string>())
const revoke = (url: string) => url && url !== 'loading' && URL.revokeObjectURL(url)
async function load(id: number) {
  blobs.set(id, 'loading')
  const blob = await storageApi.blob(id).catch(() => null)
  // removed or unmounted meanwhile: no URL to leak
  if (blobs.get(id) === 'loading') blobs.set(id, blob ? URL.createObjectURL(blob) : '')
}
watch(
  model,
  (list) => {
    const ids = new Set(list.map((o) => o.id))
    for (const [id, url] of blobs)
      if (!ids.has(id)) {
        revoke(url)
        blobs.delete(id)
      }
    for (const o of list) if (!o.url && !blobs.has(o.id)) void load(o.id)
  },
  { immediate: true, deep: 1 },
)
onBeforeUnmount(() => {
  blobs.forEach(revoke)
  blobs.clear()
})

const src = (o: FsObjectVo) => {
  const url = o.url ?? blobs.get(o.id)
  return url === 'loading' ? undefined : url
}
const previewAt = ref(-1)
const shown = computed(() => model.value.filter((o) => src(o)))

function preview(o: FsObjectVo) {
  previewAt.value = shown.value.indexOf(o)
}
</script>

<template>
  <div class="image-upload">
    <ul class="image-upload__grid">
      <li v-for="o in model" :key="o.id" class="image-upload__card">
        <img v-if="src(o)" class="image-upload__img" :src="src(o)" :alt="o.originalName" />
        <span v-else class="image-upload__placeholder" :aria-label="o.originalName">
          <Icon :icon="src(o) === '' ? 'lucide:image-off' : 'lucide:image'" />
        </span>
        <div class="image-upload__actions">
          <IconButton
            v-if="src(o)"
            icon="lucide:zoom-in"
            :label="t('upload.action.preview', { name: o.originalName })"
            @click="preview(o)"
          />
          <IconButton
            v-if="!disabled"
            icon="lucide:trash-2"
            :label="t('upload.action.remove', { name: o.originalName })"
            @click="remove(o)"
          />
        </div>
      </li>
      <li v-for="p in pending" :key="p.uid" class="image-upload__card" aria-busy="true">
        <el-progress
          type="circle"
          :width="56"
          :stroke-width="4"
          :percentage="p.percent"
          :aria-label="t('upload.uploading', { name: p.name, percent: p.percent })"
        />
      </li>
      <li v-if="!disabled && remaining() > 0">
        <el-upload
          class="image-upload__upload"
          :show-file-list="false"
          :multiple="limit > 1"
          :accept="IMAGE_ACCEPT"
          :before-upload="check"
          :http-request="send"
        >
          <span class="image-upload__trigger">
            <Icon icon="lucide:image-plus" class="image-upload__trigger-icon" />
            {{ t('upload.action.uploadImage') }}
          </span>
        </el-upload>
      </li>
    </ul>
    <p v-if="!disabled" class="image-upload__tip">
      {{ t('upload.hint.image', { size: formatSize(sizeLimit()), limit }) }}
    </p>
    <el-image-viewer
      v-if="previewAt >= 0"
      :url-list="shown.map((o) => src(o) ?? '')"
      :initial-index="previewAt"
      hide-on-click-modal
      teleported
      @close="previewAt = -1"
    />
  </div>
</template>

<style scoped>
.image-upload__grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.image-upload__card,
.image-upload__trigger {
  position: relative;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  width: 96px;
  height: 96px;
  overflow: hidden;
  background: var(--qw-surface-2);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm);
}
.image-upload__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.image-upload__placeholder {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  font-size: 24px;
  color: var(--qw-text-3);
}
/* on hover or keyboard focus: preview and remove over a navy scrim (navy in both themes) */
.image-upload__actions {
  position: absolute;
  inset: 0;
  display: flex;
  gap: 4px;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--qw-side-bg) 60%, transparent);
  opacity: 0;
  transition: opacity 0.15s;
}
.image-upload__card:hover .image-upload__actions,
.image-upload__actions:focus-within {
  opacity: 1;
}
.image-upload__actions .icon-button {
  color: var(--qw-side-active-text);
}
.image-upload__actions .icon-button:hover {
  color: var(--qw-side-active-text);
  background: var(--qw-side-hover);
}
.image-upload__trigger {
  gap: 4px;
  align-content: center;
  font-size: 12px;
  line-height: 16px;
  color: var(--qw-text-3);
  cursor: pointer;
  border-style: dashed;
  border-color: color-mix(in srgb, var(--qw-text-3) 45%, var(--qw-border));
  transition:
    color 0.15s,
    border-color 0.15s;
}
.image-upload__trigger:hover,
.image-upload__upload:focus-visible .image-upload__trigger {
  color: var(--qw-brand-text);
  border-color: var(--qw-brand);
}
.image-upload__trigger-icon {
  width: 22px;
  height: 22px;
}
.image-upload__tip {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
</style>
