<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { RT, type WfTaskItemVo } from '@qiwu/shared'
import { wfCenterApi } from '@/api/workflow/center'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { tx } from '@/core/i18n'
import { onRealtime } from '@/core/realtime/socket'
import { at, useCenterList } from './use-center-list'

/**
 * 我的待办 (see docs/design-notes.md#workflow): the caller's pending tasks, newest first; a `wf:task` push (the
 * caller's to-dos changed) reloads the list, as it does the side menu's count (`TodoBadge`).
 */
defineOptions({ name: 'WfTodo' })
const { t } = useI18n()
const { query, rows, total, loading, refresh, onSortChange, open } = useCenterList<WfTaskItemVo>({
  api: { page: wfCenterApi.todo },
  sort: '-createdAt,-id',
})
onRealtime(RT.wfTask, () => void refresh())
const columns: QwColumn[] = [
  { prop: 'title', label: 'wf.center.list.title', minWidth: 260, showOverflowTooltip: true },
  { prop: 'nodeName', label: 'wf.center.list.node', width: 160, showOverflowTooltip: true },
  { prop: 'initiator', label: 'wf.center.list.initiator', width: 140, showOverflowTooltip: true },
  { prop: 'createdAt', label: 'wf.center.list.arrivedAt', width: 170, sortable: true },
]
</script>

<template>
  <div class="qw-page">
    <el-card class="qw-table-panel">
      <TableToolbar table-id="wf.todo" :columns="columns" :searchable="false" @refresh="refresh" />
      <QwTable
        table-id="wf.todo"
        :columns="columns"
        :data="rows"
        :loading="loading"
        @sort-change="onSortChange"
      >
        <template #cell-title="{ row }">{{ row.instance.title }}</template>
        <template #cell-nodeName="{ row }">{{ tx(row.nodeName) }}</template>
        <template #cell-initiator="{ row }">{{ row.instance.initiator.name }}</template>
        <template #cell-createdAt="{ row }">{{ at(row.createdAt) }}</template>
        <template #actions="{ row }">
          <el-button link type="primary" @click="open(row.instance.id)">
            {{ t('wf.center.list.handle') }}
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
