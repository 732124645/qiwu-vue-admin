<script setup lang="ts">
import { computed, h, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { ElMessageBox } from 'element-plus'
import { wxoaPerms } from '@qiwu/shared'
import { wxoaAccountApi } from '@/api/platform/wxoa/account'
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
import WxoaAccountForm from './form.vue'
import WxoaAccountQuota from './quota.vue'
import WxoaAccountTest from './test.vue'

// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'WxoaAccount' })

const { t } = useI18n()
const perms = wxoaPerms.account
const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange, remove } =
  useCrudList({
    api: wxoaAccountApi,
    filters: {
      label: '',
      appId: '',
      accountKind: null as string | null,
      enabled: null as string | null,
    },
    sort: '-createdAt',
  })
const showSearch = ref(true)
const columns: QwColumn[] = [
  {
    prop: 'label',
    label: 'field.wxoa.account.label',
    sortable: true,
    minWidth: 160,
    showOverflowTooltip: true,
  },
  { prop: 'appId', label: 'field.wxoa.account.appId', sortable: true, width: 190 },
  { prop: 'accountKind', label: 'field.wxoa.account.accountKind', width: 170 },
  { prop: 'verified', label: 'field.wxoa.account.verified', width: 100 },
  { prop: 'cryptoMode', label: 'field.wxoa.account.cryptoMode', width: 150 },
  { prop: 'enabled', label: 'field.wxoa.account.enabled', width: 100 },
  { prop: 'lastPushAt', label: 'wxoa.account.lastPushAt', width: 160 },
  { prop: 'createdAt', label: 'field.common.createdAt', sortable: true, width: 160 },
]
const perm = usePerm()
const canModify = computed(() => perm.has(perms.modify))

const entity = () => t('wxoa.account.entity')
/**
 * Add (no id) or edit in the form dialog; reload once saved. A new one shows its callback URL: in the
 * edit form again, or read-only without the permission to edit.
 */
async function openForm(id?: number): Promise<void> {
  const saved = await openDialog<{ id: number; callbackPath?: string }>(
    WxoaAccountForm,
    { id },
    {
      title: () => t(id ? 'crud.title.edit' : 'crud.title.create', { name: entity() }),
      width: 640,
    },
  )
  if (!saved) return
  await refresh()
  if (id != null) return
  if (canModify.value) await openForm(saved.id)
  else
    await ElMessageBox.alert(
      h('div', [
        h('code', `${location.origin}${saved.callbackPath ?? ''}`),
        h('p', t('wxoa.account.callbackHint')),
      ]),
      t('wxoa.account.callbackUrl'),
      { confirmButtonText: t('wxoa.account.close') },
    ).catch(() => undefined)
}

const openTest = (id: number) =>
  openDialog(WxoaAccountTest, { id }, { title: () => t('wxoa.account.test.title') })
const openQuota = (id: number) =>
  openDialog(WxoaAccountQuota, { id }, { title: () => t('wxoa.account.quota.title'), width: 640 })
</script>

<template>
  <div class="qw-page">
    <el-card v-show="showSearch" class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('field.wxoa.account.label')">
          <el-input v-model="query.label" name="label" clearable />
        </el-form-item>
        <el-form-item :label="t('field.wxoa.account.appId')">
          <el-input v-model="query.appId" name="appId" clearable />
        </el-form-item>
        <el-form-item :label="t('field.wxoa.account.accountKind')">
          <DictSelect v-model="query.accountKind" code="wxoa.account_kind" />
        </el-form-item>
        <el-form-item :label="t('field.wxoa.account.enabled')">
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
        table-id="wxoa.account"
        :columns="columns"
        @refresh="refresh"
      >
        <el-button v-perm="perms.create" type="primary" @click="openForm()">
          <el-icon class="el-icon--left"><Icon icon="lucide:plus" /></el-icon>
          {{ t('crud.action.create') }}
        </el-button>
      </TableToolbar>

      <QwTable
        table-id="wxoa.account"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :filtered
        @sort-change="onSortChange"
        @reset-filters="reset"
      >
        <template #cell-accountKind="{ row }">
          <DictTag code="wxoa.account_kind" :value="row.accountKind" />
        </template>
        <template #cell-verified="{ row }">
          <DictTag code="core.yes_no" :value="row.verified" />
        </template>
        <template #cell-cryptoMode="{ row }">
          <DictTag code="wxoa.crypto_mode" :value="row.cryptoMode" />
        </template>
        <template #cell-enabled="{ row }">
          <DictTag code="core.enabled" :value="row.enabled" />
        </template>
        <template #cell-lastPushAt="{ row }">
          <span v-if="row.lastPushAt">{{ dayjs(row.lastPushAt).format('YYYY-MM-DD HH:mm') }}</span>
          <span v-else class="muted">{{ t('wxoa.account.noPush') }}</span>
        </template>
        <template #cell-createdAt="{ row }">{{
          dayjs(row.createdAt).format('YYYY-MM-DD HH:mm')
        }}</template>
        <template #actions="{ row }">
          <el-button v-if="canModify" link type="primary" @click="openTest(row.id)">
            {{ t('wxoa.account.test.action') }}
          </el-button>
          <el-button link type="primary" @click="openQuota(row.id)">
            {{ t('wxoa.account.quota.action') }}
          </el-button>
          <el-button v-if="canModify" link type="primary" @click="openForm(row.id)">
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
  </div>
</template>

<style scoped>
.muted {
  color: var(--qw-text-3);
}
</style>
