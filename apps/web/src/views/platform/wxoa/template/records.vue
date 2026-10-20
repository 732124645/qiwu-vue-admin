<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { Page, WxoaMessageVo } from '@qiwu/shared'
import { wxoaMessageApi } from '@/api/platform/wxoa/message'
import DictTag from '@/core/components/DictTag.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { Icon } from '@/core/icons'
import WxoaMessageBody from '../components/MessageBody.vue'

/**
 * The template messages sent from account `accountId`: the message log's `channel=template` rows
 * (`wxoa.message.browse`), with their send state and WeChat's error code. `refresh()` reloads.
 */
defineOptions({ name: 'WxoaTemplateRecords' })
const { accountId } = defineProps<{ accountId: number }>()
const { t } = useI18n()

const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange } = useCrudList(
  {
    api: {
      page: (params: Record<string, unknown>): Promise<Page<WxoaMessageVo>> =>
        wxoaMessageApi.page({ ...params, accountId, channel: 'template' }),
    },
    filters: { openId: '', occurredAtRange: null as [string, string] | null },
    sort: '-occurredAt',
  },
)
const showSearch = ref(true)
const columns: QwColumn[] = [
  { prop: 'occurredAt', label: 'wxoa.template.records.occurredAt', sortable: true, width: 170 },
  { prop: 'openId', label: 'field.wxoa.message.openId', minWidth: 220, showOverflowTooltip: true },
  { prop: 'content', label: 'wxoa.message.col.content', minWidth: 260 },
  { prop: 'sendState', label: 'wxoa.message.col.sendState', width: 120 },
  { prop: 'errcode', label: 'wxoa.message.col.errcode', width: 120 },
  { prop: 'wxMsgId', label: 'wxoa.message.col.wxMsgId', width: 200, hidden: true },
]
const time = (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm:ss')

watch(
  () => accountId,
  () => {
    // nothing of the previous account stays on screen, even if the new list fails to load
    rows.value = []
    total.value = 0
    void search()
  },
)
defineExpose({ refresh })
</script>

<template>
  <el-card v-show="showSearch" class="qw-search-panel">
    <el-form :model="query" inline @submit.prevent="search">
      <el-form-item :label="t('field.wxoa.message.openId')">
        <el-input v-model="query.openId" name="openId" clearable />
      </el-form-item>
      <el-form-item :label="t('wxoa.template.records.occurredAt')">
        <el-date-picker
          v-model="query.occurredAtRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          :start-placeholder="t('field.wxoa.message.occurredAtFrom')"
          :end-placeholder="t('field.wxoa.message.occurredAtTo')"
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
      table-id="wxoa.template-send"
      :columns="columns"
      @refresh="refresh"
    />
    <QwTable
      table-id="wxoa.template-send"
      :columns="columns"
      :data="rows"
      :loading="loading"
      :filtered
      @sort-change="onSortChange"
      @reset-filters="reset"
    >
      <template #cell-occurredAt="{ row }">{{ time(row.occurredAt) }}</template>
      <!-- el-table also renders cell slots with an empty row while collecting its columns -->
      <template #cell-content="{ row }">
        <WxoaMessageBody v-if="row.payload" :message="row" />
      </template>
      <template #cell-sendState="{ row }">
        <DictTag v-if="row.sendState" code="wxoa.send_state" :value="row.sendState" />
      </template>
    </QwTable>
    <Pagination
      v-model:page="query.page"
      v-model:page-size="query.pageSize"
      :total="total"
      @change="refresh"
    />
  </el-card>
</template>
