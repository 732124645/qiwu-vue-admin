<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WfCcItemVo } from '@qiwu/shared'
import { wfCenterApi } from '@/api/workflow/center'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { Icon } from '@/core/icons'
import { at, useCenterList } from './use-center-list'

/**
 * 抄送我的 (see docs/design-notes.md#workflow): copies sent to the caller, newest first, by read state; viewing an
 * unread one marks it read (only the caller's own copy, server side) before the instance opens.
 */
defineOptions({ name: 'WfCc' })
const { t } = useI18n()
const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange, open } =
  useCenterList<WfCcItemVo, { unread: string }>({
    api: { page: wfCenterApi.ccs },
    filters: { unread: '' },
    sort: '-createdAt,-id',
  })
const showSearch = ref(true)
const opening = ref(false)
const columns: QwColumn[] = [
  { prop: 'readAt', label: 'wf.center.list.readState', width: 120 },
  { prop: 'title', label: 'wf.center.list.title', minWidth: 260, showOverflowTooltip: true },
  { prop: 'fromUser', label: 'wf.center.list.from', width: 150, showOverflowTooltip: true },
  { prop: 'reason', label: 'wf.center.list.reason', minWidth: 160, showOverflowTooltip: true },
  { prop: 'createdAt', label: 'wf.center.list.ccAt', width: 170, sortable: true },
]

async function view(row: WfCcItemVo) {
  if (opening.value) return
  opening.value = true
  try {
    if (!row.readAt) await wfCenterApi.readCc(row.id)
    await open(row.instance.id)
  } catch (e) {
    toastRest(e)
    void refresh()
  } finally {
    opening.value = false
  }
}
</script>

<template>
  <div class="qw-page">
    <el-card v-show="showSearch" class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('wf.center.list.readState')">
          <el-select v-model="query.unread" :aria-label="t('wf.center.list.readState')">
            <el-option :label="t('wf.center.list.all')" value="" />
            <el-option :label="t('wf.center.list.unread')" value="true" />
            <el-option :label="t('wf.center.list.read')" value="false" />
          </el-select>
        </el-form-item>
        <el-form-item class="qw-search-actions">
          <el-button type="primary" plain native-type="submit">
            <el-icon class="el-icon--left"><Icon icon="lucide:search" /></el-icon>
            {{ t('crud.action.search') }}
          </el-button>
          <el-button @click="reset">{{ t('crud.action.reset') }}</el-button>
        </el-form-item>
      </el-form>
    </el-card>
    <el-card class="qw-table-panel">
      <TableToolbar
        v-model:search="showSearch"
        table-id="wf.cc"
        :columns="columns"
        @refresh="refresh"
      />
      <QwTable
        table-id="wf.cc"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :filtered
        @sort-change="onSortChange"
        @reset-filters="reset"
      >
        <template #cell-readAt="{ row }">
          <span class="wf-cc-state" :class="{ 'is-unread': !row.readAt }">
            {{ t(row.readAt ? 'wf.center.list.read' : 'wf.center.list.unread') }}
          </span>
        </template>
        <template #cell-title="{ row }">{{ row.instance.title }}</template>
        <template #cell-fromUser="{ row }">
          {{ row.fromUser ? row.fromUser.name : t('wf.center.list.fromStep') }}
        </template>
        <template #cell-createdAt="{ row }">{{ at(row.createdAt) }}</template>
        <template #actions="{ row }">
          <el-button link type="primary" :disabled="opening" @click="view(row)">
            {{ t('wf.center.list.view') }}
          </el-button>
        </template>
      </QwTable>
      <Pagination
        v-model:page="query.page"
        v-model:page-size="query.pageSize"
        :total="total"
        @change="refresh"
      />
    </el-card>
  </div>
</template>

<style scoped>
.wf-cc-state {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 2px 10px;
  color: var(--qw-neutral);
  background: var(--qw-neutral-weak);
  border-radius: 999px;
}
.wf-cc-state::before {
  width: 6px;
  height: 6px;
  content: '';
  background: currentcolor;
  border-radius: 50%;
}
.wf-cc-state.is-unread {
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
}
</style>
