<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { WfTaskItemVo } from '@qiwu/shared'
import { wfCenterApi } from '@/api/workflow/center'
import DictTag from '@/core/components/DictTag.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { tx } from '@/core/i18n'
import { at, useCenterList } from './use-center-list'

/**
 * 我的已办 (see docs/design-notes.md#workflow): the tasks the caller handled (approved, rejected, sent back,
 * transferred), latest first, with where their process stands now.
 */
defineOptions({ name: 'WfDone' })
const { t } = useI18n()
const { query, rows, total, loading, refresh, onSortChange, open } = useCenterList<WfTaskItemVo>({
  api: { page: wfCenterApi.done },
  sort: '-handledAt,-id',
})
const columns: QwColumn[] = [
  { prop: 'title', label: 'wf.center.list.title', minWidth: 260, showOverflowTooltip: true },
  { prop: 'nodeName', label: 'wf.center.list.node', width: 160, showOverflowTooltip: true },
  { prop: 'state', label: 'wf.center.list.result', width: 120 },
  { prop: 'comment', label: 'wf.center.list.comment', minWidth: 160, showOverflowTooltip: true },
  { prop: 'instanceState', label: 'wf.center.list.state', width: 130 },
  { prop: 'handledAt', label: 'wf.center.list.handledAt', width: 170, sortable: true },
]
</script>

<template>
  <div class="qw-page">
    <el-card class="qw-table-panel">
      <TableToolbar table-id="wf.done" :columns="columns" :searchable="false" @refresh="refresh" />
      <QwTable
        table-id="wf.done"
        :columns="columns"
        :data="rows"
        :loading="loading"
        @sort-change="onSortChange"
      >
        <template #cell-title="{ row }">{{ row.instance.title }}</template>
        <template #cell-nodeName="{ row }">{{ tx(row.nodeName) }}</template>
        <template #cell-state="{ row }">
          <DictTag code="wf.task_state" :value="row.state" />
        </template>
        <template #cell-instanceState="{ row }">
          <DictTag code="wf.instance_state" :value="row.instance.state" />
        </template>
        <template #cell-handledAt="{ row }">{{ at(row.handledAt) }}</template>
        <template #actions="{ row }">
          <el-button link type="primary" @click="open(row.instance.id)">
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
