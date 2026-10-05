<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { BulletinFeedDetail } from '@qiwu/shared'
import DictTag from '@/core/components/DictTag.vue'

/**
 * A bulletin as its readers see it: the bell's detail dialog (`openDialog` content). `body` is HTML the
 * server cleaned with the fixed whitelist of `core/sanitize.ts` when it was saved (no script,
 * style, on* or iframe, http/https/mailto only; see docs/design-notes.md#security), so it is rendered as it is; the SPA CSP (no inline
 * scripts) stands behind it. Links open in a new tab that gets no handle on this page.
 */
defineOptions({ name: 'BulletinView' })
const { bulletin } = defineProps<{ bulletin: BulletinFeedDetail }>()
const emit = defineEmits<{ done: [result: undefined]; cancel: [] }>()
const { t } = useI18n()

function onClick(e: MouseEvent) {
  const link = (e.target as Element | null)?.closest<HTMLAnchorElement>('a[href]')
  if (!link) return
  e.preventDefault()
  window.open(link.href, '_blank', 'noopener,noreferrer')
}
</script>

<template>
  <article class="bulletin-view">
    <div class="bulletin-view__meta">
      <DictTag code="messaging.bulletin_kind" :value="bulletin.kind" />
      <time :datetime="bulletin.publishedAt">
        {{ dayjs(bulletin.publishedAt).format('YYYY-MM-DD HH:mm') }}
      </time>
    </div>
    <!-- sanitized when saved (core/sanitize.ts whitelist): the bulletin body is the one v-html source -->
    <div class="bulletin-view__body" @click="onClick" v-html="bulletin.body" />
    <div class="qw-dialog-footer">
      <el-button @click="emit('cancel')">{{ t('notify.bulletin.close') }}</el-button>
    </div>
  </article>
</template>

<style scoped>
.bulletin-view__meta {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--qw-text-3);
}
.bulletin-view__body {
  max-height: 60vh;
  overflow: auto;
  line-height: 1.7;
  color: var(--qw-text);
  overflow-wrap: anywhere;
}
.bulletin-view__body :deep(:first-child) {
  margin-top: 0;
}
.bulletin-view__body :deep(img) {
  max-width: 100%;
  height: auto;
}
.bulletin-view__body :deep(a) {
  color: var(--qw-brand-text);
}
.bulletin-view__body :deep(blockquote) {
  margin: 12px 0;
  padding: 4px 12px;
  color: var(--qw-text-2);
  border-left: 3px solid var(--qw-border);
}
.bulletin-view__body :deep(pre) {
  padding: 12px;
  overflow: auto;
  background: var(--qw-surface-2);
  border-radius: var(--qw-radius-sm);
}
.bulletin-view__body :deep(table) {
  border-collapse: collapse;
}
.bulletin-view__body :deep(th),
.bulletin-view__body :deep(td) {
  padding: 4px 8px;
  border: 1px solid var(--qw-border);
}
</style>
