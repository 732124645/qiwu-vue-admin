<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { wfPerms, type WfAdminTaskVo } from '@qiwu/shared'
import { wfAdminApi } from '@/api/workflow/admin'
import DictSelect from '@/core/components/DictSelect.vue'
import DictTag from '@/core/components/DictTag.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import UserSelect from '@/core/components/UserSelect.vue'
import { useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { at } from '../center/use-center-list'
import WfAdminAction from './WfAdminAction.vue'

/**
 * 任务管理 (管理员; see docs/design-notes.md#workflow): the tasks of every instance the server returns for the caller's data
 * scope on the initiator's dept, by model key, state, assignee and instance; 改派 an open task of a running
 * instance to another user (`wfPerms.task.manage`, e.g. its assignee left).
 */
defineOptions({ name: 'WfTask' })
const { t } = useI18n()
type Filters = {
  modelKey: string
  state: string
  assigneeId: number | null
  instanceId: number | null
}
const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange } = useCrudList<
  WfAdminTaskVo,
  Filters
>({
  api: { page: wfAdminApi.tasks },
  filters: { modelKey: '', state: '', assigneeId: null, instanceId: null },
  sort: '-createdAt,-id',
})
const showSearch = ref(true)
const columns: QwColumn[] = [
  { prop: 'instanceId', label: 'wf.admin.instanceId', width: 90 },
  { prop: 'modelName', label: 'wf.center.list.model', minWidth: 160, showOverflowTooltip: true },
  { prop: 'nodeName', label: 'wf.center.list.node', width: 150, showOverflowTooltip: true },
  { prop: 'assignee', label: 'field.wf.admin.assigneeId', width: 130, showOverflowTooltip: true },
  { prop: 'state', label: 'wf.admin.taskState', width: 110 },
  { prop: 'initiator', label: 'wf.center.list.initiator', width: 130, showOverflowTooltip: true },
  { prop: 'dept', label: 'wf.admin.dept', width: 130, showOverflowTooltip: true, hidden: true },
  { prop: 'createdAt', label: 'wf.center.list.arrivedAt', width: 170, sortable: true },
  { prop: 'dueAt', label: 'wf.admin.dueAt', width: 170, hidden: true },
  { prop: 'handledAt', label: 'wf.center.list.handledAt', width: 170 },
]
/**
 * an open task, the ones 改派 accepts (a begin task is refused by the server); only a running instance has
 * one (terminate / approve / reject close every open task)
 */
const reassignable = (row: WfAdminTaskVo) => ['waiting', 'pending', 'delegated'].includes(row.state)

async function reassign(row: WfAdminTaskVo) {
  const done = await openDialog(
    WfAdminAction,
    { action: 'reassign', id: row.id },
    { title: () => t('wf.admin.reassign.title', { node: tx(row.nodeName) }) },
  )
  if (done) await refresh()
}
</script>

<template>
  <div class="qw-page">
    <el-card v-show="showSearch" class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('field.wf.admin.modelKey')">
          <el-input v-model="query.modelKey" name="modelKey" clearable />
        </el-form-item>
        <el-form-item :label="t('wf.admin.taskState')">
          <DictSelect
            v-model="query.state"
            code="wf.task_state"
            :aria-label="t('wf.admin.taskState')"
          />
        </el-form-item>
        <el-form-item :label="t('field.wf.admin.assigneeId')">
          <UserSelect v-model="query.assigneeId" />
        </el-form-item>
        <el-form-item :label="t('field.wf.admin.instanceId')">
          <el-input-number
            v-model="query.instanceId"
            :min="1"
            :controls="false"
            :aria-label="t('field.wf.admin.instanceId')"
          />
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
        table-id="wf.task"
        :columns="columns"
        @refresh="refresh"
      />
      <QwTable
        table-id="wf.task"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :filtered
        @sort-change="onSortChange"
        @reset-filters="reset"
      >
        <template #cell-instanceId="{ row }">{{ row.instance.id }}</template>
        <template #cell-modelName="{ row }">{{ tx(row.instance.modelName) }}</template>
        <template #cell-nodeName="{ row }">{{ tx(row.nodeName) }}</template>
        <template #cell-assignee="{ row }">{{
          row.assignee.name ?? `#${row.assignee.id}`
        }}</template>
        <template #cell-state="{ row }">
          <DictTag code="wf.task_state" :value="row.state" />
        </template>
        <template #cell-initiator="{ row }">
          {{ row.instance.initiator.name ?? `#${row.instance.initiator.id}` }}
        </template>
        <template #cell-dept="{ row }">
          {{ row.instance.dept?.name ? tx(row.instance.dept.name) : '' }}
        </template>
        <template #cell-createdAt="{ row }">{{ at(row.createdAt) }}</template>
        <template #cell-dueAt="{ row }">{{ at(row.dueAt) }}</template>
        <template #cell-handledAt="{ row }">{{ at(row.handledAt) }}</template>
        <template #actions="{ row }">
          <el-button
            v-if="reassignable(row)"
            v-perm="wfPerms.task.manage"
            link
            type="primary"
            @click="reassign(row)"
          >
            {{ t('wf.admin.reassign.action') }}
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
