<template>
  <view class="qw-files">
    <text v-if="!files.length" class="qw-files__empty">{{ t('oa.noAttachments') }}</text>
    <view v-for="file in files" :key="file.id" class="qw-files__row">
      <view class="qw-files__info">
        <text class="qw-files__name">{{ file.originalName }}</text>
        <text class="qw-files__size">{{ formatSize(file.size) }}</text>
        <text v-if="!attachmentPreviewable(file)" class="qw-form__hint">{{
          t('approval.attachmentDesktop')
        }}</text>
      </view>
      <wd-button
        size="small"
        variant="soft"
        :loading="opening === file.id"
        :disabled="!!opening || !attachmentPreviewable(file)"
        @click="open(file.id)"
        >{{ t('oa.preview') }}</wd-button
      >
    </view>
    <text v-if="error" class="qw-form__error" role="alert">{{ error }}</text>
  </view>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import type { FsObjectVo } from '@qiwu/shared'
import { attachmentPreviewable, openAttachmentWithFeedback } from '@/core/attachments'
import { formatSize } from '@/core/format'
import { t } from '@/core/i18n'

defineOptions({ options: { virtualHost: true } })
defineProps<{ files: readonly FsObjectVo[] }>()
const emit = defineEmits<{ unavailable: [] }>()
const opening = ref(0)
const error = ref('')
/** 每次点击重新核验业务访问权；失败只提示，不回退外链或文件名拼接。 */
async function open(id: number) {
  if (opening.value) return
  opening.value = id
  error.value = ''
  try {
    await openAttachmentWithFeedback(id, {
      error: (message) => (error.value = message),
      unavailable: () => emit('unavailable'),
    })
  } finally {
    opening.value = 0
  }
}
</script>
<style>
.qw-files {
  display: flex;
  flex-direction: column;
  gap: var(--qw-space-3);
}
.qw-files__row {
  display: flex;
  align-items: center;
  gap: var(--qw-space-3);
}
.qw-files__info {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: var(--qw-space-1);
}
.qw-files__name {
  color: var(--qw-text);
  font-size: var(--qw-fs-body);
  word-break: break-all;
}
.qw-files__size,
.qw-files__empty {
  color: var(--qw-text-3);
  font-size: var(--qw-fs-caption);
}
</style>
