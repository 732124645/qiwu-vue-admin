<template>
  <view class="qw-business-summary">
    <text v-if="summary.problem" class="qw-form__error" role="alert">{{ summary.problem }}</text>
    <view v-for="row in summary.rows" :key="row.label" class="qw-kv">
      <text class="qw-kv__k">{{ row.label }}</text
      ><text class="qw-kv__v">{{ row.value }}</text>
    </view>
    <view class="qw-business-summary__files">
      <text class="qw-field__label">{{ t('oa.attachments') }}</text>
      <QwAttachments :files="summary.attachments" @unavailable="emit('unavailable')" />
    </view>
    <view v-for="item in summary.items" :key="item.title" class="qw-business-summary__item">
      <text class="qw-business-summary__title">{{ item.title }}</text>
      <view v-for="row in item.rows" :key="row.label" class="qw-kv"
        ><text class="qw-kv__k">{{ row.label }}</text
        ><text class="qw-kv__v">{{ row.value }}</text></view
      >
      <QwAttachments :files="item.attachments" @unavailable="emit('unavailable')" />
    </view>
  </view>
</template>
<script setup lang="ts">
import type { FormSummary } from '@/core/approvals'
import { t } from '@/core/i18n'
import QwAttachments from './QwAttachments.vue'
defineOptions({ options: { virtualHost: true } })
defineProps<{ summary: FormSummary }>()
const emit = defineEmits<{ unavailable: [] }>()
</script>
<style>
.qw-business-summary__files {
  padding: var(--qw-space-3) 0;
}
.qw-business-summary__item {
  padding-top: var(--qw-space-3);
  margin-top: var(--qw-space-3);
  border-top: 1px solid var(--qw-border);
}
.qw-business-summary__title {
  color: var(--qw-text);
  font-size: var(--qw-fs-body-lg);
  font-weight: 600;
}
</style>
