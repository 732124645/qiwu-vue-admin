<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { WXOA_DIRECTIONS, type Page, type WxoaMessageVo } from '@qiwu/shared'
import { wxoaMessageApi } from '@/api/platform/wxoa/message'
import DictSelect from '@/core/components/DictSelect.vue'
import DictTag from '@/core/components/DictTag.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { Icon } from '@/core/icons'
import AccountSwitch from '../components/AccountSwitch.vue'
import WxoaMessageBody from '../components/MessageBody.vue'
import { useWxoaAccount } from '../components/use-wxoa-account'

// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'WxoaMessage' })

const { t } = useI18n()
const { accountId } = useWxoaAccount()

const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange } = useCrudList(
  {
    api: {
      // none chosen yet: nothing to load
      page: async (params: Record<string, unknown>): Promise<Page<WxoaMessageVo>> =>
        accountId.value == null
          ? { items: [], total: 0 }
          : wxoaMessageApi.page({ ...params, accountId: accountId.value }),
    },
    filters: {
      openId: '',
      direction: null as string | null,
      channel: null as string | null,
      msgKind: null as string | null,
      occurredAtRange: null as [string, string] | null,
    },
    sort: '-occurredAt',
  },
)
const showSearch = ref(true)

const columns: QwColumn[] = [
  { prop: 'occurredAt', label: 'wxoa.message.col.occurredAt', sortable: true, width: 170 },
  { prop: 'direction', label: 'field.wxoa.message.direction', width: 90 },
  { prop: 'channel', label: 'field.wxoa.message.channel', width: 130 },
  { prop: 'msgKind', label: 'field.wxoa.message.msgKind', width: 110 },
  { prop: 'content', label: 'wxoa.message.col.content', minWidth: 260 },
  { prop: 'openId', label: 'field.wxoa.message.openId', minWidth: 220, showOverflowTooltip: true },
  { prop: 'sendState', label: 'wxoa.message.col.sendState', width: 120 },
  { prop: 'errcode', label: 'wxoa.message.col.errcode', width: 110, hidden: true },
  { prop: 'wxMsgId', label: 'wxoa.message.col.wxMsgId', width: 200, hidden: true },
]
const time = (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm:ss')

watch(accountId, () => {
  // nothing of the previous account stays on screen, even if the new list fails to load
  rows.value = []
  total.value = 0
  void search()
})
</script>

<template>
  <div class="qw-page">
    <AccountSwitch />
    <template v-if="accountId != null">
      <el-card v-show="showSearch" class="qw-search-panel">
        <el-form :model="query" inline @submit.prevent="search">
          <el-form-item :label="t('field.wxoa.message.openId')">
            <el-input v-model="query.openId" name="openId" clearable />
          </el-form-item>
          <el-form-item :label="t('field.wxoa.message.direction')">
            <el-select
              v-model="query.direction"
              clearable
              :aria-label="t('field.wxoa.message.direction')"
            >
              <el-option
                v-for="d in WXOA_DIRECTIONS"
                :key="d"
                :value="d"
                :label="t(`wxoa.message.direction.${d}`)"
              />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('field.wxoa.message.channel')">
            <DictSelect v-model="query.channel" code="wxoa.channel" />
          </el-form-item>
          <el-form-item :label="t('field.wxoa.message.msgKind')">
            <DictSelect v-model="query.msgKind" code="wxoa.msg_kind" />
          </el-form-item>
          <el-form-item :label="t('wxoa.message.col.occurredAt')">
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
          table-id="wxoa.message"
          :columns="columns"
          @refresh="refresh"
        />
        <QwTable
          table-id="wxoa.message"
          :columns="columns"
          :data="rows"
          :loading="loading"
          :filtered
          @sort-change="onSortChange"
          @reset-filters="reset"
        >
          <template #cell-occurredAt="{ row }">{{ time(row.occurredAt) }}</template>
          <template #cell-direction="{ row }">
            {{ t(`wxoa.message.direction.${row.direction}`) }}
          </template>
          <template #cell-channel="{ row }">
            <DictTag code="wxoa.channel" :value="row.channel" />
          </template>
          <template #cell-msgKind="{ row }">
            <DictTag code="wxoa.msg_kind" :value="row.msgKind" />
          </template>
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
  </div>
</template>
