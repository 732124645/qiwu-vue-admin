<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WfInstanceItemVo } from '@qiwu/shared'
import { wfCenterApi } from '@/api/workflow/center'
import DictSelect from '@/core/components/DictSelect.vue'
import DictTag from '@/core/components/DictTag.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { at, useCenterList } from './use-center-list'

/** 我的发起 (see docs/design-notes.md#workflow): the instances the caller started, newest first, by state. */
defineOptions({ name: 'WfMine' })
const { t } = useI18n()
const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange, open } =
  useCenterList<WfInstanceItemVo, { state: string }>({
    api: { page: wfCenterApi.mine },
    filters: { state: '' },
    sort: '-startedAt,-id',
  })
const showSearch = ref(true)
const columns: QwColumn[] = [
  { prop: 'title', label: 'wf.center.list.title', minWidth: 260, showOverflowTooltip: true },
  { prop: 'modelName', label: 'wf.center.list.model', width: 180, showOverflowTooltip: true },
  { prop: 'state', label: 'wf.center.list.state', width: 120 },
  { prop: 'startedAt', label: 'wf.center.list.startedAt', width: 170, sortable: true },
  { prop: 'endedAt', label: 'wf.center.list.endedAt', width: 170 },
]
</script>

<template>
  <div class="qw-page">
    <el-card v-show="showSearch" class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('wf.center.list.state')">
          <DictSelect
            v-model="query.state"
            code="wf.instance_state"
            :aria-label="t('wf.center.list.state')"
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
        table-id="wf.mine"
        :columns="columns"
        @refresh="refresh"
      />
      <QwTable
        table-id="wf.mine"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :filtered
        @sort-change="onSortChange"
        @reset-filters="reset"
      >
        <template #cell-modelName="{ row }">{{ tx(row.modelName) }}</template>
        <template #cell-state="{ row }">
          <DictTag code="wf.instance_state" :value="row.state" />
        </template>
        <template #cell-startedAt="{ row }">{{ at(row.startedAt) }}</template>
        <template #cell-endedAt="{ row }">{{ at(row.endedAt) }}</template>
        <template #actions="{ row }">
          <el-button link type="primary" @click="open(row.id)">
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
