<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { FsObjectVo, StorageBizTag } from '@qiwu/shared'
import { storageApi } from '@/api/platform/storage/object'
import { formatSize, useUpload } from '@/core/composables/use-upload'
import { Icon } from '@/core/icons'
import IconButton from './IconButton.vue'

/**
 * Attachments field (see docs/design-notes.md#layering, #storage): `v-model` = the stored objects (`FsObjectVo[]`; map them to ids when
 * saving). Each picked file goes to POST /api/storage/objects under `bizTag` (private by default; with
 * `direct` straight to the primary S3 storage, presign → PUT → confirm); a name
 * opens the file: public by its URL, private downloaded with the access token. Removing drops the file from
 * the list only (the stored object stays).
 */
defineOptions({ name: 'FileUpload' })
const {
  bizTag = 'attachment',
  limit = 10,
  maxSize,
  accept,
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
  /** the file picker's filter, e.g. `.pdf,.docx`; the server's extension whitelist still applies */
  accept?: string
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
})
</script>

<template>
  <div class="file-upload">
    <el-upload
      v-if="!disabled"
      :show-file-list="false"
      :multiple="limit > 1"
      :accept
      :disabled="remaining() <= 0"
      :before-upload="check"
      :http-request="send"
    >
      <el-button :disabled="remaining() <= 0">
        <el-icon class="el-icon--left"><Icon icon="lucide:upload" /></el-icon>
        {{ t('upload.action.upload') }}
      </el-button>
      <template #tip>
        <p class="file-upload__tip">
          {{ t('upload.hint.file', { size: formatSize(sizeLimit()), limit }) }}
        </p>
      </template>
    </el-upload>
    <ul v-if="model.length || pending.length" class="file-upload__list">
      <li v-for="o in model" :key="o.id" class="file-upload__item">
        <Icon icon="lucide:file-text" class="file-upload__icon" />
        <a v-if="o.url" class="file-upload__name" :href="o.url" target="_blank" rel="noopener">
          {{ o.originalName }}
        </a>
        <button v-else type="button" class="file-upload__name" @click="storageApi.download(o)">
          {{ o.originalName }}
        </button>
        <!-- a file kept in a text column comes without its size (uploadField) -->
        <span v-if="o.size" class="file-upload__size">{{ formatSize(o.size) }}</span>
        <IconButton
          v-if="!disabled"
          icon="lucide:x"
          :label="t('upload.action.remove', { name: o.originalName })"
          @click="remove(o)"
        />
      </li>
      <li v-for="p in pending" :key="p.uid" class="file-upload__item" aria-busy="true">
        <Icon icon="lucide:loader-circle" class="file-upload__icon file-upload__icon--spin" />
        <span class="file-upload__name file-upload__name--pending">{{ p.name }}</span>
        <el-progress
          class="file-upload__progress"
          :percentage="p.percent"
          :stroke-width="4"
          :show-text="false"
          :aria-label="t('upload.uploading', { name: p.name, percent: p.percent })"
        />
        <span class="file-upload__size">{{ p.percent }}%</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.file-upload {
  width: 100%;
}
.file-upload__tip {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
.file-upload__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.file-upload__item {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 32px;
  padding: 0 4px 0 8px;
  border-radius: var(--qw-radius-sm);
  transition: background-color 0.15s;
}
.file-upload__item:hover {
  background: var(--qw-surface-2);
}
.file-upload__icon {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--qw-text-3);
}
.file-upload__icon--spin {
  animation: file-upload-spin 1s linear infinite;
}
.file-upload__name {
  flex: 1;
  min-width: 0;
  padding: 0;
  overflow: hidden;
  font: inherit;
  line-height: 20px;
  color: var(--qw-brand-text);
  text-align: left;
  text-decoration: none;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  background: none;
  border: 0;
}
.file-upload__name:hover {
  text-decoration: underline;
}
.file-upload__name--pending {
  flex: 0 1 auto;
  color: var(--qw-text-2);
  cursor: default;
}
.file-upload__name--pending:hover {
  text-decoration: none;
}
.file-upload__progress {
  flex: 1;
  min-width: 60px;
}
.file-upload__size {
  flex: none;
  font-size: 12px;
  color: var(--qw-text-3);
  font-variant-numeric: tabular-nums;
}
@keyframes file-upload-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
