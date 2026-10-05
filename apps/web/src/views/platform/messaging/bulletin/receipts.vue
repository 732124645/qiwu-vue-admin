<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { bulletinApi } from '@/api/platform/messaging/bulletin'
import QwTable from '@/core/components/QwTable.vue'
import Pagination from '@/core/components/Pagination.vue'
import { useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { Icon } from '@/core/icons'
import { tx } from '@/core/i18n'

/** Who read bulletin `id` (users in the caller's data scope), opened from the list's row action. */
defineOptions({ name: 'MessagingBulletinReceipts' })
const { id } = defineProps<{ id: number }>()
const { t } = useI18n()
const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange } = useCrudList(
  {
    // rows are keyed by the reader
    api: {
      page: async (params) => {
        const page = await bulletinApi.receipts(id, params)
        return { ...page, items: page.items.map((r) => ({ ...r, id: r.userId })) }
      },
    },
    filters: { keyword: '' },
    sort: '-readAt',
  },
)
const columns: QwColumn[] = [
  {
    prop: 'username',
    label: 'field.messaging.bulletinReceipt.username',
    sortable: true,
    width: 160,
  },
  { prop: 'displayName', label: 'field.messaging.bulletinReceipt.displayName', width: 140 },
  { prop: 'deptName', label: 'field.messaging.bulletinReceipt.deptName', minWidth: 140 },
  { prop: 'readAt', label: 'field.messaging.bulletinReceipt.readAt', sortable: true, width: 160 },
]
</script>

<template>
  <el-form :model="query" inline class="receipts-search" @submit.prevent="search">
    <el-form-item :label="t('field.messaging.bulletinReceipt.keyword')">
      <el-input v-model="query.keyword" name="keyword" clearable />
    </el-form-item>
    <el-form-item>
      <el-button type="primary" plain native-type="submit">
        <el-icon class="el-icon--left"><Icon icon="lucide:search" /></el-icon>
        {{ t('crud.action.search') }}
      </el-button>
      <el-button @click="reset">{{ t('crud.action.reset') }}</el-button>
    </el-form-item>
  </el-form>
  <QwTable
    table-id="messaging.bulletinReceipt"
    :columns="columns"
    :data="rows"
    :loading="loading"
    :filtered
    :max-height="420"
    @sort-change="onSortChange"
    @reset-filters="reset"
  >
    <template #cell-deptName="{ row }">{{ row.deptName ? tx(row.deptName) : '' }}</template>
    <template #cell-readAt="{ row }">{{ dayjs(row.readAt).format('YYYY-MM-DD HH:mm') }}</template>
  </QwTable>
  <Pagination
    v-model:page="query.page"
    v-model:page-size="query.pageSize"
    :total="total"
    @change="refresh"
  />
</template>

<style scoped>
.receipts-search {
  margin-bottom: 8px;
}
</style>
