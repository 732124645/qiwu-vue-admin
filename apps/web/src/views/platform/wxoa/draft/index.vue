<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { wxoaPerms } from '@qiwu/shared'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import { wxoaDraftApi, wxoaDraftSynced, type WxoaDraftVo } from '@/api/platform/wxoa/draft'
import EmptyState from '@/core/components/EmptyState.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { openDialog } from '@/core/dialog'
import { toastRest, useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import AccountSwitch from '../components/AccountSwitch.vue'
import VerifiedHint from '../components/VerifiedHint.vue'
import { useWxoaAccount } from '../components/use-wxoa-account'
import DraftForm from './form.vue'
import { publishDraft } from './publish-draft'

/** 图文草稿列表：本地草稿与从微信草稿箱拉取的草稿，可同步、发布与删除。 */
defineOptions({ name: 'WxoaDraft' })
const { t } = useI18n()
const perms = wxoaPerms.draft
const perm = usePerm()
const { accountId } = useWxoaAccount()
const can = computed(() => ({
  create: perm.has(perms.create),
  modify: perm.has(perms.modify),
  remove: perm.has(perms.remove),
  sync: perm.has(perms.sync),
  publish: perm.has(wxoaPerms.publish.create),
}))
const { query, rows, total, loading, filtered, search, refresh, reset } = useCrudList({
  api: {
    page: (params: Record<string, unknown>) =>
      accountId.value == null
        ? Promise.resolve({ items: [], total: 0 })
        : wxoaDraftApi.page({ ...params, accountId: accountId.value }),
  },
  filters: { title: '' },
  sort: '-updatedAt',
})
const columns: QwColumn[] = [
  { prop: 'title', label: 'wxoa.draft.col.title', minWidth: 220, showOverflowTooltip: true },
  { prop: 'articleCount', label: 'wxoa.draft.col.articleCount', width: 100 },
  { prop: 'origin', label: 'wxoa.draft.col.origin', width: 120 },
  { prop: 'mediaId', label: 'wxoa.draft.col.mediaId', minWidth: 180, showOverflowTooltip: true },
  { prop: 'syncedAt', label: 'wxoa.draft.col.syncedAt', width: 170 },
  { prop: 'updatedAt', label: 'wxoa.draft.col.updatedAt', width: 170, sortable: true },
]
const showSearch = ref(true)
const syncLoading = ref(false)
const displayDate = (value: string | null) => (value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '')
/** 正在删除或发布的行，按钮显示加载并互斥 */
const acting = ref<number | null>(null)
async function openEditor(row?: WxoaDraftVo) {
  const id = accountId.value
  if (id == null) return
  const saved = await openDialog<WxoaDraftVo>(
    DraftForm,
    { accountId: id, draft: row ?? null },
    {
      title: () => (row ? t('wxoa.draft.edit') : t('wxoa.draft.create')),
      width: '980px',
      top: '5vh',
    },
  )
  if (saved) await refresh()
}
async function remove(row: WxoaDraftVo) {
  if (acting.value != null) return
  try {
    await ElMessageBox.confirm(
      t('wxoa.draft.removeConfirm', { title: row.title }),
      t('crud.confirm.title'),
      {
        type: 'warning',
        confirmButtonText: t('crud.action.delete'),
        cancelButtonText: t('common.action.cancel'),
      },
    )
  } catch {
    return
  }
  acting.value = row.id
  try {
    await wxoaDraftApi.remove(row.id)
    ElMessage.success(t('crud.msg.deleted'))
    await refresh()
  } catch (e) {
    toastRest(e)
  } finally {
    acting.value = null
  }
}
/** 确认后发布一份已同步的草稿。 */
async function publish(row: WxoaDraftVo) {
  const id = accountId.value
  if (id == null || acting.value != null) return
  acting.value = row.id
  try {
    await publishDraft(id, row)
  } finally {
    acting.value = null
  }
}
async function pull() {
  const id = accountId.value
  if (id == null || syncLoading.value) return
  syncLoading.value = true
  try {
    const result = await wxoaDraftApi.pull(id)
    ElMessage.success(t('wxoa.draft.pull.done', { count: result.items.length }))
    if (result.failed.length)
      ElMessage.warning(t('wxoa.draft.pull.partial', { count: result.failed.length }))
    await refresh()
  } catch (e) {
    toastRest(e)
  } finally {
    syncLoading.value = false
  }
}
watch(accountId, () => {
  rows.value = []
  total.value = 0
  void refresh()
})
</script>

<template>
  <div class="qw-page wxoa-draft-page">
    <AccountSwitch />
    <template v-if="accountId != null">
      <VerifiedHint />
      <el-card v-show="showSearch" class="qw-search-panel">
        <el-form :model="query" inline @submit.prevent="search">
          <el-form-item :label="t('wxoa.draft.col.title')"
            ><el-input v-model="query.title" clearable
          /></el-form-item>
          <el-form-item class="qw-search-actions"
            ><el-button type="primary" plain native-type="submit">{{
              t('crud.action.search')
            }}</el-button
            ><el-button @click="reset">{{ t('crud.action.reset') }}</el-button></el-form-item
          >
        </el-form>
      </el-card>
      <el-card class="qw-table-panel">
        <TableToolbar
          v-model:search="showSearch"
          table-id="wxoa.draft"
          :columns="columns"
          @refresh="refresh"
        >
          <el-button v-if="can.create" type="primary" @click="openEditor()"
            ><el-icon class="el-icon--left"><Icon icon="lucide:plus" /></el-icon
            >{{ t('wxoa.draft.create') }}</el-button
          >
          <el-button v-if="can.sync" :loading="syncLoading" @click="pull"
            ><el-icon v-if="!syncLoading" class="el-icon--left"
              ><Icon icon="lucide:download" /></el-icon
            >{{ t('wxoa.draft.pull.action') }}</el-button
          >
        </TableToolbar>
        <QwTable table-id="wxoa.draft" :columns="columns" :data="rows" :loading="loading" :filtered>
          <template #cell-articleCount="{ row }">{{ row.articles.length }}</template>
          <template #cell-origin="{ row }">{{ t(`wxoa.draft.origin.${row.origin}`) }}</template>
          <template #cell-syncedAt="{ row }"
            >{{ displayDate(row.syncedAt) }}
            <el-tag v-if="row.mediaId && row.dirty" size="small" type="warning">{{
              t('wxoa.draft.picker.dirty')
            }}</el-tag></template
          >
          <template #cell-updatedAt="{ row }">{{ displayDate(row.updatedAt) }}</template>
          <template #actions="{ row }">
            <el-button v-if="can.modify" link type="primary" @click="openEditor(row)">{{
              t('crud.action.edit')
            }}</el-button>
            <el-button
              v-if="can.publish && wxoaDraftSynced(row)"
              link
              type="primary"
              :loading="acting === row.id"
              :disabled="acting != null && acting !== row.id"
              @click="publish(row)"
              >{{ t('wxoa.publish.create.action') }}</el-button
            >
            <el-button
              v-if="can.remove"
              link
              type="danger"
              :loading="acting === row.id"
              :disabled="acting != null && acting !== row.id"
              @click="remove(row)"
              >{{ t('crud.action.delete') }}</el-button
            >
          </template>
          <template #empty><EmptyState :description="t('wxoa.draft.empty')" /></template>
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
