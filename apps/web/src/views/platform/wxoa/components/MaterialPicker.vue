<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { Page, WxoaMaterialVo, WxoaMediaKind } from '@qiwu/shared'
import { wxoaMaterialApi } from '@/api/platform/wxoa/material'
import EmptyState from '@/core/components/EmptyState.vue'
import Pagination from '@/core/components/Pagination.vue'
import { useCrudList } from '@/core/composables/use-crud'
import { Icon } from '@/core/icons'
import WxoaMediaImage from './WxoaMediaImage.vue'

/**
 * Picks one permanent material of `mediaKind` from the account's materials:
 * `await openDialog<WxoaMaterialVo>(WxoaMaterialPicker, { accountId, mediaKind }, { title })`. New
 * media is uploaded on the material page first; nothing here uploads.
 */
defineOptions({ name: 'WxoaMaterialPicker' })
const { accountId, mediaKind } = defineProps<{ accountId: number; mediaKind: WxoaMediaKind }>()
const emit = defineEmits<{ done: [material: WxoaMaterialVo]; cancel: [] }>()
const { t } = useI18n()

const { query, rows, total, loading, filtered, search, refresh } = useCrudList({
  api: {
    page: (params: Record<string, unknown>): Promise<Page<WxoaMaterialVo>> =>
      wxoaMaterialApi.page({ ...params, accountId, mediaKind }),
  },
  filters: { title: '' },
  sort: '-createdAt',
})
const imageKind = mediaKind === 'image' || mediaKind === 'thumb'
const ICONS: Record<WxoaMediaKind, string> = {
  image: 'lucide:image',
  thumb: 'lucide:image',
  voice: 'lucide:audio-lines',
  video: 'lucide:clapperboard',
}
const nameOf = (m: WxoaMaterialVo) => m.title || m.fileName || m.mediaId
</script>

<template>
  <el-form :model="query" inline @submit.prevent="search">
    <el-form-item :label="t('field.wxoa.material.title')">
      <el-input v-model="query.title" name="title" clearable />
    </el-form-item>
    <el-form-item>
      <el-button type="primary" plain native-type="submit">{{ t('crud.action.search') }}</el-button>
    </el-form-item>
  </el-form>
  <ul v-loading="loading" class="wxoa-picker">
    <li v-for="m in rows" :key="m.id">
      <button type="button" class="wxoa-picker__item" @click="emit('done', m)">
        <WxoaMediaImage v-if="imageKind" :object-id="m.objectId" :url="m.wxUrl" :alt="nameOf(m)" />
        <span v-else class="wxoa-picker__icon" aria-hidden="true">
          <Icon :icon="ICONS[mediaKind]" />
        </span>
        <span class="wxoa-picker__name">{{ nameOf(m) }}</span>
      </button>
    </li>
  </ul>
  <EmptyState
    v-if="!loading && !rows.length"
    :title="filtered ? t('common.empty.noMatch') : t('wxoa.material.picker.empty')"
  />
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
.wxoa-picker {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
  min-height: 96px;
  padding: 0;
  margin: 0 0 12px;
  list-style: none;
}
.wxoa-picker__item {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  width: 100%;
  padding: 8px;
  font: inherit;
  color: var(--qw-text);
  cursor: pointer;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius-sm);
}
.wxoa-picker__item:hover,
.wxoa-picker__item:focus-visible {
  border-color: var(--qw-brand);
  outline: none;
}
.wxoa-picker__icon {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  font-size: 24px;
  color: var(--qw-text-3);
  background: var(--qw-surface-2);
  border-radius: var(--qw-radius-sm);
}
.wxoa-picker__name {
  width: 100%;
  overflow: hidden;
  font-size: 12px;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
