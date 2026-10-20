<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { wxoaDraftApi, wxoaDraftSynced, type WxoaDraftVo } from '@/api/platform/wxoa/draft'
import EmptyState from '@/core/components/EmptyState.vue'
import Pagination from '@/core/components/Pagination.vue'
import { useCrudList } from '@/core/composables/use-crud'

/**
 * 选一份草稿：`await openDialog<WxoaDraftVo>(WxoaDraftPicker, { accountId }, { title })`。
 * 只有已同步到微信草稿箱、之后没有本地修改的草稿可选（发布与群发都用草稿箱的 media_id），
 * 其余的列出但禁用并说明原因；这里不新建也不编辑草稿。
 */
defineOptions({ name: 'WxoaDraftPicker' })
const { accountId } = defineProps<{ accountId: number }>()
const emit = defineEmits<{ done: [draft: WxoaDraftVo]; cancel: [] }>()
const { t } = useI18n()

const { query, rows, total, loading, refresh } = useCrudList({
  api: { page: (params: Record<string, unknown>) => wxoaDraftApi.page({ ...params, accountId }) },
  sort: '-updatedAt',
})
const time = (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm')
</script>

<template>
  <ul v-loading="loading" class="wxoa-draft-picker">
    <li v-for="d in rows" :key="d.id">
      <button
        type="button"
        class="wxoa-draft-picker__item"
        :disabled="!wxoaDraftSynced(d)"
        @click="emit('done', d)"
      >
        <span class="wxoa-draft-picker__title">{{ d.title }}</span>
        <span class="wxoa-draft-picker__meta">
          {{ t('wxoa.draft.picker.articles', { count: d.articles.length }) }} ·
          {{ time(d.updatedAt) }}
          <el-tag v-if="d.mediaId == null" size="small" type="info">{{
            t('wxoa.draft.picker.notSynced')
          }}</el-tag>
          <el-tag v-else-if="d.dirty" size="small" type="warning">{{
            t('wxoa.draft.picker.dirty')
          }}</el-tag>
        </span>
      </button>
    </li>
  </ul>
  <EmptyState v-if="!loading && !rows.length" :title="t('wxoa.draft.empty')" />
  <Pagination
    v-model:page="query.page"
    v-model:page-size="query.pageSize"
    :total="total"
    @change="refresh"
  />
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
  </div>
</template>

<style scoped>
.wxoa-draft-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 96px;
  padding: 0;
  margin: 0 0 12px;
  list-style: none;
}
.wxoa-draft-picker__item {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 8px 12px;
  font: inherit;
  color: var(--qw-text);
  text-align: left;
  cursor: pointer;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm);
}
.wxoa-draft-picker__item:hover:not(:disabled),
.wxoa-draft-picker__item:focus-visible {
  border-color: var(--qw-brand);
  outline: none;
}
.wxoa-draft-picker__item:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.wxoa-draft-picker__title {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wxoa-draft-picker__meta {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--qw-text-3);
}
</style>
