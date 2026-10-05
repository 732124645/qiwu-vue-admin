<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { MyInboxItemVo } from '@qiwu/shared'

/**
 * One inbox message as its recipient sees it (`openDialog` content, the dialog title is the message's):
 * category, sender, time and the body as plain text (never v-html; line breaks by
 * `white-space: pre-line`; see docs/design-notes.md#security).
 */
defineOptions({ name: 'InboxMessageView' })
const { message } = defineProps<{ message: MyInboxItemVo }>()
const emit = defineEmits<{ cancel: [] }>()
const { t } = useI18n()
</script>

<template>
  <article class="inbox-message-view">
    <div class="inbox-message-view__meta">
      <span>{{ t(`notify.inbox.category.${message.category}`) }}</span>
      <span>{{ message.senderLabel || t('notify.inbox.systemSender') }}</span>
      <time :datetime="message.createdAt">{{
        dayjs(message.createdAt).format('YYYY-MM-DD HH:mm')
      }}</time>
    </div>
    <div class="inbox-message-view__body">{{ message.body }}</div>
    <div class="qw-dialog-footer">
      <el-button @click="emit('cancel')">{{ t('notify.inbox.close') }}</el-button>
    </div>
  </article>
</template>

<style scoped>
.inbox-message-view__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--qw-text-3);
}
.inbox-message-view__body {
  max-height: 60vh;
  overflow: auto;
  line-height: 1.7;
  white-space: pre-line;
  overflow-wrap: anywhere;
  color: var(--qw-text);
}
</style>
