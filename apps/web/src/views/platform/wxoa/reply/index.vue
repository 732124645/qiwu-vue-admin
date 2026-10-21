<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { wxoaPerms, type Page, type WxoaReplyRuleVo } from '@qiwu/shared'
import { wxoaReplyRuleApi } from '@/api/platform/wxoa/reply-rule'
import DictSelect from '@/core/components/DictSelect.vue'
import DictTag from '@/core/components/DictTag.vue'
import QwTable from '@/core/components/QwTable.vue'
import Pagination from '@/core/components/Pagination.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import AccountSwitch from '../components/AccountSwitch.vue'
import { useWxoaAccount } from '../components/use-wxoa-account'
import WxoaReplyForm from './form.vue'

// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'WxoaReply' })

const { t } = useI18n()
const perms = wxoaPerms.reply
const perm = usePerm()
const canModify = computed(() => perm.has(perms.modify))
const { accountId } = useWxoaAccount()

const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange, remove } =
  useCrudList({
    api: {
      // none chosen yet: nothing to load
      page: async (params: Record<string, unknown>): Promise<Page<WxoaReplyRuleVo>> =>
        accountId.value == null
          ? { items: [], total: 0 }
          : wxoaReplyRuleApi.page({ ...params, accountId: accountId.value }),
      remove: ([id]: number[]) => wxoaReplyRuleApi.remove(id!),
    },
    filters: {
      name: '',
      triggerKind: null as string | null,
      enabled: null as string | null,
    },
    sort: '-priority',
  })
const showSearch = ref(true)
const columns: QwColumn[] = [
  { prop: 'name', label: 'field.wxoa.replyRule.name', minWidth: 160, showOverflowTooltip: true },
  { prop: 'triggerKind', label: 'field.wxoa.replyRule.triggerKind', width: 120 },
  { prop: 'match', label: 'wxoa.reply.col.match', minWidth: 220 },
  { prop: 'replyKind', label: 'field.wxoa.replyRule.replyKind', width: 100 },
  { prop: 'priority', label: 'field.wxoa.replyRule.priority', sortable: true, width: 100 },
  { prop: 'enabled', label: 'field.wxoa.replyRule.enabled', width: 100 },
  { prop: 'createdAt', label: 'field.common.createdAt', sortable: true, width: 160 },
]

watch(accountId, () => {
  // nothing of the previous account stays on screen, even if the new list fails to load
  rows.value = []
  total.value = 0
  void search()
})

/** Add (no id) or edit in the form dialog; reload once saved. */
async function openForm(row?: WxoaReplyRuleVo) {
  const account = row?.accountId ?? accountId.value
  if (account == null) return
  const saved = await openDialog(
    WxoaReplyForm,
    { id: row?.id, accountId: account },
    {
      title: () =>
        t(row ? 'crud.title.edit' : 'crud.title.create', { name: t('wxoa.reply.entity') }),
      width: 720,
      top: '6vh',
    },
  )
  if (saved) await refresh()
}
</script>

<template>
  <div class="qw-page">
    <AccountSwitch />
    <template v-if="accountId != null">
      <el-card v-show="showSearch" class="qw-search-panel">
        <el-form :model="query" inline @submit.prevent="search">
          <el-form-item :label="t('field.wxoa.replyRule.name')">
            <el-input v-model="query.name" name="name" clearable />
          </el-form-item>
          <el-form-item :label="t('field.wxoa.replyRule.triggerKind')">
            <DictSelect v-model="query.triggerKind" code="wxoa.reply_trigger" />
          </el-form-item>
          <el-form-item :label="t('field.wxoa.replyRule.enabled')">
            <DictSelect v-model="query.enabled" code="core.enabled" />
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
          table-id="wxoa.reply"
          :columns="columns"
          @refresh="refresh"
        >
          <el-button v-perm="perms.create" type="primary" @click="openForm()">
            <el-icon class="el-icon--left"><Icon icon="lucide:plus" /></el-icon>
            {{ t('crud.action.create') }}
          </el-button>
        </TableToolbar>

        <QwTable
          table-id="wxoa.reply"
          :columns="columns"
          :data="rows"
          :loading="loading"
          :filtered
          @sort-change="onSortChange"
          @reset-filters="reset"
        >
          <template #cell-triggerKind="{ row }">
            <DictTag code="wxoa.reply_trigger" :value="row.triggerKind" />
          </template>
          <template #cell-match="{ row }">
            <template v-if="row.triggerKind === 'keyword'">
              <DictTag code="wxoa.match_mode" :value="row.matchMode" />
              <el-tag v-for="k in row.keywords" :key="k" class="keyword" size="small" type="info">
                {{ k }}
              </el-tag>
            </template>
            <code v-else-if="row.eventKey" class="event-key">{{ row.eventKey }}</code>
            <span v-else-if="row.triggerKind" class="muted">
              {{ t(`wxoa.reply.when.${row.triggerKind}`) }}
            </span>
          </template>
          <template #cell-replyKind="{ row }">
            <DictTag code="wxoa.reply_kind" :value="row.replyKind" />
          </template>
          <template #cell-enabled="{ row }">
            <DictTag code="core.enabled" :value="row.enabled" />
          </template>
          <template #cell-createdAt="{ row }">
            {{ dayjs(row.createdAt).format('YYYY-MM-DD HH:mm') }}
          </template>
          <template #actions="{ row }">
            <el-button v-if="canModify" link type="primary" @click="openForm(row)">
              {{ t('crud.action.edit') }}
            </el-button>
            <el-button v-perm="perms.remove" link type="danger" @click="remove([row.id])">
              {{ t('crud.action.delete') }}
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
    </template>
  </div>
</template>

<style scoped>
.keyword {
  margin-left: 4px;
}
.event-key {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}
.muted {
  color: var(--qw-text-3);
}
</style>
