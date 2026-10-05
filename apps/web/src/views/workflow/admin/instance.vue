<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { wfPerms, type WfAdminInstanceVo } from '@qiwu/shared'
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
 * 实例管理 (管理员; see docs/design-notes.md#workflow): every instance the server returns for the caller's data scope on the
 * initiator's dept, by model key, state and initiator; 终止 a running one (`wfPerms.task.manage`), open its
 * detail (`wfPerms.instance.view`: its hidden page /wf/instances/:id, the instance detail view).
 */
defineOptions({ name: 'WfInstance' })
const { t } = useI18n()
const router = useRouter()
const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange } = useCrudList<
  WfAdminInstanceVo,
  { modelKey: string; state: string; initiatorId: number | null }
>({
  api: { page: wfAdminApi.instances },
  filters: { modelKey: '', state: '', initiatorId: null },
  sort: '-startedAt,-id',
})
const showSearch = ref(true)
const columns: QwColumn[] = [
  { prop: 'id', label: 'wf.admin.instanceId', width: 90 },
  { prop: 'modelName', label: 'wf.center.list.model', minWidth: 180, showOverflowTooltip: true },
  { prop: 'initiator', label: 'wf.center.list.initiator', width: 140, showOverflowTooltip: true },
  { prop: 'dept', label: 'wf.admin.dept', width: 140, showOverflowTooltip: true },
  { prop: 'state', label: 'wf.center.list.state', width: 120 },
  { prop: 'startedAt', label: 'wf.center.list.startedAt', width: 170, sortable: true },
  { prop: 'endedAt', label: 'wf.center.list.endedAt', width: 170 },
]

async function terminate(row: WfAdminInstanceVo) {
  const done = await openDialog(
    WfAdminAction,
    { action: 'terminate', id: row.id },
    { title: () => t('wf.admin.terminate.title', { id: row.id }) },
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
        <el-form-item :label="t('wf.center.list.state')">
          <DictSelect
            v-model="query.state"
            code="wf.instance_state"
            :aria-label="t('wf.center.list.state')"
          />
        </el-form-item>
        <el-form-item :label="t('field.wf.admin.initiatorId')">
          <UserSelect v-model="query.initiatorId" />
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
        table-id="wf.instance"
        :columns="columns"
        @refresh="refresh"
      />
      <QwTable
        table-id="wf.instance"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :filtered
        @sort-change="onSortChange"
        @reset-filters="reset"
      >
        <template #cell-modelName="{ row }">{{ tx(row.modelName) }}</template>
        <template #cell-initiator="{ row }">{{
          row.initiator.name ?? `#${row.initiator.id}`
        }}</template>
        <template #cell-dept="{ row }">{{ row.dept?.name ? tx(row.dept.name) : '' }}</template>
        <template #cell-state="{ row }">
          <DictTag code="wf.instance_state" :value="row.state" />
        </template>
        <template #cell-startedAt="{ row }">{{ at(row.startedAt) }}</template>
        <template #cell-endedAt="{ row }">{{ at(row.endedAt) }}</template>
        <template #actions="{ row }">
          <el-button
            v-perm="wfPerms.instance.view"
            link
            type="primary"
            @click="router.push(`/wf/instances/${row.id}`)"
          >
            {{ t('wf.center.list.view') }}
          </el-button>
          <el-button
            v-if="row.state === 'running'"
            v-perm="wfPerms.task.manage"
            link
            type="danger"
            @click="terminate(row)"
          >
            {{ t('wf.admin.terminate.action') }}
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
