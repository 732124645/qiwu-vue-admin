<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { ElMessageBox } from 'element-plus'
import { DEFAULT_TENANT_ID, tenantPerms, type TenantVo } from '@qiwu/shared'
import { tenantApi } from '@/api/platform/iam/tenant'
import DictSelect from '@/core/components/DictSelect.vue'
import DictTag from '@/core/components/DictTag.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest, useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import { useTagsStore } from '@/core/stores/tags'
import TenantEnter from './enter.vue'
import TenantForm from './form.vue'
import TenantPassword from './password.vue'

/**
 * Tenant management (see docs/design-notes.md#tenancy): open, edit, disable and enter tenants. A tenant
 * is never deleted. The default tenant cannot be disabled or entered; it has no administrator of its own
 * to reset.
 */
defineOptions({ name: 'IamTenant' })

const { t } = useI18n()
const { query, rows, total, loading, filtered, search, reset, refresh, onSortChange } = useCrudList(
  {
    api: tenantApi,
    filters: { code: '', name: '', enabled: null as string | null },
    sort: '-createdAt',
  },
)
const showSearch = ref(true)
// fits the content area at 1440 wide without a horizontal scroll (the fixed actions column would cover the
// domains): the creation time is in the column settings, hidden at first
const columns: QwColumn[] = [
  {
    prop: 'code',
    label: 'field.iam.tenant.code',
    sortable: true,
    width: 130,
    showOverflowTooltip: true,
  },
  {
    prop: 'name',
    label: 'field.iam.tenant.name',
    sortable: true,
    minWidth: 150,
    showOverflowTooltip: true,
  },
  {
    prop: 'packageName',
    label: 'field.iam.tenant.packageName',
    minWidth: 110,
    showOverflowTooltip: true,
  },
  { prop: 'enabled', label: 'field.iam.tenant.enabled', width: 90 },
  { prop: 'expiresAt', label: 'field.iam.tenant.expiresAt', sortable: true, width: 150 },
  { prop: 'userCount', label: 'field.iam.tenant.userCount', width: 110 },
  { prop: 'domains', label: 'field.iam.tenant.domains', minWidth: 160 },
  {
    prop: 'createdAt',
    label: 'field.common.createdAt',
    sortable: true,
    width: 150,
    hidden: true,
  },
]
const isDefault = (row: TenantVo) => row.id === DEFAULT_TENANT_ID
const fmt = (at: string) => dayjs(at).format('YYYY-MM-DD HH:mm')
// computed: the perms reload when the server's permission version moves
const perm = usePerm()
const canModify = computed(() => perm.has(tenantPerms.modify))
// the edit form loads GET /:id, which needs `view` too
const canEdit = computed(() => perm.all([tenantPerms.modify, tenantPerms.view]))

/** Open (no id) or edit in the form dialog; reload once saved, then show an opened tenant's password. */
async function openForm(id?: number) {
  const saved = await openDialog<{ initialPassword?: string; admin: { username: string } }>(
    TenantForm,
    { id },
    {
      title: () =>
        t(id ? 'crud.title.edit' : 'crud.title.create', { name: t('iam.tenant.entity') }),
      width: '880px',
      top: '5vh',
    },
  )
  if (!saved) return
  await refresh()
  if (saved.initialPassword)
    await showPassword('iam.tenant.created.title', saved.initialPassword, saved.admin.username)
}

/** The initial password is answered this once: ESC does not close it by accident. */
function showPassword(title: string, password: string, username?: string) {
  return openDialog(
    TenantPassword,
    { password, username },
    { title: () => t(title), closeOnPressEscape: false },
  )
}

async function resetPassword(row: TenantVo) {
  const go = await ElMessageBox.confirm(
    t('iam.tenant.resetPassword.confirm', { name: tx(row.name) }),
    t('crud.confirm.title'),
    {
      type: 'warning',
      confirmButtonText: t('iam.tenant.resetPassword.action'),
      cancelButtonText: t('common.action.cancel'),
    },
  ).catch(() => false)
  if (!go) return
  try {
    const { initialPassword } = await tenantApi.resetInitialPassword(row.id)
    await showPassword('iam.tenant.resetPassword.title', initialPassword)
  } catch (e) {
    toastRest(e)
  }
}

async function setEnabled(row: TenantVo, enabled: boolean) {
  const name = tx(row.name)
  const go = await ElMessageBox.confirm(
    t(enabled ? 'iam.tenant.enableConfirm' : 'iam.tenant.disableConfirm', { name }),
    t('crud.confirm.title'),
    {
      type: 'warning',
      confirmButtonText: t(enabled ? 'iam.tenant.enable' : 'iam.tenant.disable'),
      cancelButtonText: t('common.action.cancel'),
    },
  ).catch(() => false)
  if (!go) return
  // failures are toasted by the request layer; the reload shows the stored state either way
  await tenantApi.setEnabled(row.id, enabled).catch(() => undefined)
  await refresh()
}

/**
 * Enters the tenant once a reason is given, then reloads the whole page from the start: the open tags are
 * kept across reloads, so they are dropped first (written out before the page goes); the reload also drops
 * the cached dicts, kept-alive pages and the socket's rooms.
 */
async function enter(row: TenantVo) {
  const entered = await openDialog<true>(
    TenantEnter,
    { id: row.id },
    { title: () => t('iam.tenant.enter.title', { name: tx(row.name) }) },
  )
  if (!entered) return
  useTagsStore().reset()
  await nextTick()
  location.replace('/')
}
</script>

<template>
  <div class="qw-page">
    <el-card v-show="showSearch" class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('field.iam.tenant.code')">
          <el-input v-model="query.code" name="code" clearable />
        </el-form-item>
        <el-form-item :label="t('field.iam.tenant.name')">
          <el-input v-model="query.name" name="name" clearable />
        </el-form-item>
        <el-form-item :label="t('field.iam.tenant.enabled')">
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
        table-id="iam.tenant"
        :columns="columns"
        @refresh="refresh"
      >
        <el-button v-perm="tenantPerms.create" type="primary" @click="openForm()">
          <el-icon class="el-icon--left"><Icon icon="lucide:plus" /></el-icon>
          {{ t('crud.action.create') }}
        </el-button>
      </TableToolbar>

      <QwTable
        table-id="iam.tenant"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :filtered
        :actions-width="260"
        @sort-change="onSortChange"
        @reset-filters="reset"
      >
        <!-- the default tenant's name is an i18n key -->
        <template #cell-name="{ row }">
          {{ tx(row.name) }}
          <el-tag v-if="isDefault(row)" size="small" type="info" class="tenant-tag">
            {{ t('iam.tenant.defaultTag') }}
          </el-tag>
        </template>
        <template #cell-packageName="{ row }">
          {{
            row.packageName ? tx(row.packageName) : isDefault(row) ? t('iam.tenant.unlimited') : ''
          }}
        </template>
        <template #cell-enabled="{ row }">
          <el-switch
            v-if="canModify"
            size="small"
            :model-value="row.enabled"
            :disabled="isDefault(row)"
            :aria-label="`${t('field.iam.tenant.enabled')} ${tx(row.name)}`"
            @change="setEnabled(row, $event as boolean)"
          />
          <DictTag v-else code="core.enabled" :value="row.enabled" />
        </template>
        <template #cell-expiresAt="{ row }">
          {{ row.expiresAt ? fmt(row.expiresAt) : t('iam.tenant.permanent') }}
        </template>
        <template #cell-userCount="{ row }">
          {{
            t('iam.tenant.usage', {
              used: row.userCount,
              quota: row.userQuota ?? t('iam.tenant.unlimited'),
            })
          }}
        </template>
        <template #cell-domains="{ row }">
          <template v-if="row.domains.length">
            <el-tag v-for="d in row.domains" :key="d" size="small" class="tenant-tag">
              {{ d }}
            </el-tag>
          </template>
          <span v-else class="tenant-none">{{ t('iam.tenant.noDomains') }}</span>
        </template>
        <template #cell-createdAt="{ row }">{{ fmt(row.createdAt) }}</template>
        <template #actions="{ row }">
          <el-button v-if="canEdit" link type="primary" @click="openForm(row.id)">
            {{ t('crud.action.edit') }}
          </el-button>
          <el-button
            v-perm="tenantPerms.enter"
            link
            type="primary"
            :disabled="isDefault(row)"
            @click="enter(row)"
          >
            {{ t('iam.tenant.enter.action') }}
          </el-button>
          <el-button
            v-perm="tenantPerms['reset-password']"
            link
            type="primary"
            :disabled="row.ownerUserId == null"
            @click="resetPassword(row)"
          >
            {{ t('iam.tenant.resetPassword.action') }}
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
.tenant-tag {
  margin-right: 4px;
}
.tenant-none {
  color: var(--qw-text-3);
}
</style>
