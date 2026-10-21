<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { ElMessageBox } from 'element-plus'
import { tenantPackagePerms, type TenantPackageVo } from '@qiwu/shared'
import { tenantPackageApi } from '@/api/platform/iam/tenant-package'
import DictSelect from '@/core/components/DictSelect.vue'
import DictTag from '@/core/components/DictTag.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import PackageForm from './form.vue'

/**
 * Tenant packages (see docs/design-notes.md#tenancy): the menus a tenant may use. Deleted one at a time; one a
 * tenant uses is refused (409, toasted by the request layer).
 */
defineOptions({ name: 'IamTenantPackage' })

const { t } = useI18n()
const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange, remove } =
  useCrudList({
    api: {
      page: tenantPackageApi.page,
      remove: (ids: number[]) => Promise.all(ids.map((id) => tenantPackageApi.remove(id))),
    },
    filters: { name: '', enabled: null as string | null },
    sort: '-createdAt',
  })
const showSearch = ref(true)
const columns: QwColumn[] = [
  {
    prop: 'name',
    label: 'field.iam.tenantPackage.name',
    sortable: true,
    minWidth: 160,
    showOverflowTooltip: true,
  },
  { prop: 'enabled', label: 'field.iam.tenantPackage.enabled', width: 100 },
  { prop: 'tenantCount', label: 'field.iam.tenantPackage.tenantCount', width: 120 },
  {
    prop: 'note',
    label: 'field.iam.tenantPackage.note',
    minWidth: 200,
    showOverflowTooltip: true,
  },
  { prop: 'createdAt', label: 'field.common.createdAt', sortable: true, width: 160 },
]
// computed: the perms reload when the server's permission version moves
const perm = usePerm()
const canModify = computed(() => perm.has(tenantPackagePerms.modify))
// the edit form loads GET /:id, which needs `view` too
const canEdit = computed(() => perm.all([tenantPackagePerms.modify, tenantPackagePerms.view]))

async function openForm(id?: number) {
  const saved = await openDialog(
    PackageForm,
    { id },
    {
      title: () =>
        t(id ? 'crud.title.edit' : 'crud.title.create', { name: t('iam.tenantPackage.entity') }),
      width: '720px',
      top: '5vh',
    },
  )
  if (saved) await refresh()
}

/** Disabling leaves its tenants with nothing to use: confirmed first. */
async function setEnabled(row: TenantPackageVo, enabled: boolean) {
  if (!enabled) {
    const go = await ElMessageBox.confirm(
      t('iam.tenantPackage.disableConfirm', { name: tx(row.name) }),
      t('crud.confirm.title'),
      {
        type: 'warning',
        confirmButtonText: t('iam.tenantPackage.disable'),
        cancelButtonText: t('common.action.cancel'),
      },
    ).catch(() => false)
    if (!go) return
  }
  // failures are toasted by the request layer; the reload shows the stored state either way
  await tenantPackageApi.update(row.id, { enabled }).catch(() => undefined)
  await refresh()
}
</script>

<template>
  <div class="qw-page">
    <el-card v-show="showSearch" class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('field.iam.tenantPackage.name')">
          <el-input v-model="query.name" name="name" clearable />
        </el-form-item>
        <el-form-item :label="t('field.iam.tenantPackage.enabled')">
          <DictSelect v-model="query.enabled" code="core.enabled" />
        </el-form-item>
        <el-form-item class="qw-search-actions">
          <!-- plain: the toolbar's create stays the page's one solid primary button -->
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
        table-id="iam.tenantPackage"
        :columns="columns"
        @refresh="refresh"
      >
        <el-button v-perm="tenantPackagePerms.create" type="primary" @click="openForm()">
          <el-icon class="el-icon--left"><Icon icon="lucide:plus" /></el-icon>
          {{ t('crud.action.create') }}
        </el-button>
      </TableToolbar>

      <QwTable
        table-id="iam.tenantPackage"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :filtered
        @sort-change="onSortChange"
        @reset-filters="reset"
      >
        <!-- a sample package's name is an i18n key -->
        <template #cell-name="{ row }">{{ tx(row.name) }}</template>
        <template #cell-enabled="{ row }">
          <el-switch
            v-if="canModify"
            size="small"
            :model-value="row.enabled"
            :aria-label="`${t('field.iam.tenantPackage.enabled')} ${tx(row.name)}`"
            @change="setEnabled(row, $event as boolean)"
          />
          <DictTag v-else code="core.enabled" :value="row.enabled" />
        </template>
        <template #cell-createdAt="{ row }">{{
          dayjs(row.createdAt).format('YYYY-MM-DD HH:mm')
        }}</template>
        <template #actions="{ row }">
          <el-button v-if="canEdit" link type="primary" @click="openForm(row.id)">
            {{ t('crud.action.edit') }}
          </el-button>
          <el-button
            v-perm="tenantPackagePerms.remove"
            link
            type="danger"
            @click="remove([row.id])"
          >
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
