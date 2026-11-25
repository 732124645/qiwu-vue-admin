<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import DictSelect from '@/core/components/DictSelect.vue'
import DictTag from '@/core/components/DictTag.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { useCrudList } from '@/core/composables/use-crud'
import { at } from '@/views/workflow/center/use-center-list'
import { officeResources, type OfficeResource } from './resources'
import { officeWorkflowAvailable } from './access'
import { useAuthStore } from '@/core/stores/auth'

const { kind } = defineProps<{ kind: OfficeResource['kind'] }>()
const resource = officeResources[kind]
const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const hasWorkflow = computed(() => officeWorkflowAvailable(auth.me))
const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange } = useCrudList(
  {
    api: {
      page: (params) =>
        hasWorkflow.value ? resource.api.page(params) : Promise.resolve({ items: [], total: 0 }),
    },
    filters: { state: '' },
    sort: '-createdAt,-id',
  },
)
watch(hasWorkflow, () => void refresh())
</script>
<template>
  <div class="qw-page">
    <el-alert
      v-if="!hasWorkflow"
      :title="t('oa.workflowUnavailable')"
      type="info"
      :closable="false"
    />
    <template v-else>
      <el-card class="qw-search-panel"
        ><el-form :model="query" inline @submit.prevent="search"
          ><el-form-item :label="t('field.oa.trip.state')"
            ><DictSelect v-model="query.state" code="oa.request_state" /></el-form-item
          ><el-button type="primary" plain native-type="submit">{{
            t('crud.action.search')
          }}</el-button
          ><el-button @click="reset">{{ t('crud.action.reset') }}</el-button></el-form
        ></el-card
      >
      <el-card class="qw-table-panel">
        <TableToolbar
          :table-id="`oa.${kind}`"
          :columns="resource.columns"
          :searchable="false"
          @refresh="refresh"
          ><template #default
            ><el-button
              v-if="hasWorkflow"
              v-perm="resource.perms.create"
              type="primary"
              @click="router.push(`${resource.path}/new`)"
              >{{ t('crud.action.create') }}</el-button
            ></template
          ></TableToolbar
        >
        <QwTable
          :table-id="`oa.${kind}`"
          :columns="resource.columns"
          :data="rows"
          :loading="loading"
          :filtered="filtered"
          @sort-change="onSortChange"
          @reset-filters="reset"
        >
          <template #cell-state="{ row }"
            ><DictTag code="oa.request_state" :value="row.state"
          /></template>
          <template #cell-startAt="{ row }">{{ at(row.startAt ?? null) }}</template>
          <template #cell-createdAt="{ row }">{{ at(row.createdAt) }}</template>
          <template #actions="{ row }"
            ><el-button link type="primary" @click="router.push(`${resource.path}/${row.id}`)">{{
              t('oa.view')
            }}</el-button></template
          >
        </QwTable>
        <Pagination
          v-model:page="query.page"
          v-model:page-size="query.pageSize"
          :total="total"
          @change="refresh"
        />
      </el-card>
    </template>
  </div>
</template>
