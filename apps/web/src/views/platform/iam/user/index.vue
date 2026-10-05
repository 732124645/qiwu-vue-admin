<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { userPerms, type DeptTreeNode, type UserVo } from '@qiwu/shared'
import { deptApi } from '@/api/platform/iam/dept'
import { userApi } from '@/api/platform/iam/user'
import DictSelect from '@/core/components/DictSelect.vue'
import DictTag from '@/core/components/DictTag.vue'
import ImportDialog from '@/core/components/ImportDialog.vue'
import QwTable from '@/core/components/QwTable.vue'
import Pagination from '@/core/components/Pagination.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import TreePanel from '@/core/components/TreePanel.vue'
import { useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { tx } from '@/core/i18n'
import { useDateRangeShortcuts } from '@/core/date-shortcuts'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import { useAuthStore } from '@/core/stores/auth'
import UserDetail from './detail.vue'
import UserForm from './form.vue'
import ResetPassword from './reset-password.vue'

// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'IamUser' })

const { t } = useI18n()
const dateRangeShortcuts = useDateRangeShortcuts()
const router = useRouter()
const auth = useAuthStore()
const {
  query,
  rows,
  total,
  loading,
  filtered,
  selection,
  search,
  reset,
  refresh,
  onSelectionChange,
  onSortChange,
  remove,
  batchRemove,
  exporting,
  exportXlsx,
} = useCrudList({
  api: userApi,
  filters: {
    // the dept picked in the tree: that dept and its whole subtree
    deptId: null as number | null,
    keyword: '',
    mobile: '',
    enabled: null as string | null,
    // YYYY-MM-DD: listParams sends the whole days
    createdAtRange: null as [string, string] | null,
  },
  sort: '-createdAt',
})
const showSearch = ref(true)

const depts = shallowRef<DeptTreeNode[]>([])
const deptsLoading = ref(true)
deptApi
  .tree()
  .then((d) => (depts.value = d))
  .catch(() => undefined) // the request layer showed it; the list still works without the tree
  .finally(() => (deptsLoading.value = false))
function pickDept(id: number | null) {
  query.deptId = id
  void search()
}

// order and visibility are the user's column settings (table id `iam.user`); beside the tree the default
// set fits 1440 wide, the rest can be shown from the settings
const columns: QwColumn[] = [
  {
    prop: 'username',
    label: 'field.iam.user.username',
    sortable: true,
    width: 140,
    showOverflowTooltip: true,
  },
  {
    prop: 'displayName',
    label: 'field.iam.user.displayName',
    sortable: true,
    minWidth: 140,
    showOverflowTooltip: true,
  },
  { prop: 'deptName', label: 'field.iam.user.deptName', width: 140, showOverflowTooltip: true },
  { prop: 'mobile', label: 'field.iam.user.mobile', width: 130 },
  {
    prop: 'email',
    label: 'field.iam.user.email',
    width: 200,
    showOverflowTooltip: true,
    hidden: true,
  },
  { prop: 'enabled', label: 'field.iam.user.enabled', width: 100 },
  {
    prop: 'lastLoginAt',
    label: 'field.iam.user.lastLoginAt',
    sortable: true,
    width: 160,
    hidden: true,
  },
  { prop: 'createdAt', label: 'field.common.createdAt', sortable: true, width: 160, hidden: true },
  {
    prop: 'note',
    label: 'field.iam.user.note',
    minWidth: 160,
    showOverflowTooltip: true,
    hidden: true,
  },
]

const perm = usePerm()
const canModify = computed(() => perm.has(userPerms.modify))
// the edit form, the detail drawer and the assign-roles page load GET /:id, which needs `view`
const canView = computed(() => perm.has(userPerms.view))
const canEdit = computed(() => perm.all([userPerms.modify, userPerms.view]))
const canReset = computed(() => perm.has(userPerms['reset-password']))
const canAssign = computed(() => perm.all([userPerms['assign-roles'], userPerms.view]))
const isRoot = computed(() => auth.roles.includes('root'))
const myId = computed(() => auth.me?.user.id)
// the server refuses these anyway (see docs/design-notes.md#auth-sessions): root users only change through a root caller, and
// nobody disables, deletes or re-roles a root user or their own account
const locked = (row: UserVo) => row.root || row.id === myId.value
const rootOnly = (row: UserVo) => row.root && !isRoot.value
const time = (iso: string | null) => (iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : '')

async function openForm(id?: number) {
  const name = () => t('iam.user.entity')
  const saved = await openDialog(
    UserForm,
    { id },
    {
      title: () => t(id ? 'crud.title.edit' : 'crud.title.create', { name: name() }),
      width: '600px',
    },
  )
  if (saved) await refresh()
}

async function setEnabled(row: UserVo, enabled: boolean) {
  // failures are toasted by the request layer; the reload shows the stored state either way
  await userApi.setEnabled(row.id, enabled).catch(() => undefined)
  await refresh()
}

const detailId = ref<number>()
const detailOpen = ref(false)
function openDetail(row: UserVo) {
  detailId.value = row.id
  detailOpen.value = true
}

function more(command: string, row: UserVo) {
  if (command === 'reset-password')
    void openDialog(
      ResetPassword,
      { id: row.id },
      { title: () => t('iam.user.resetPassword.title', { name: row.username }) },
    )
  // the hidden assign-roles page (visible = 0 menu row, delivered with the action)
  else if (command === 'assign-roles') void router.push(`/iam/users/${row.id}/roles`)
}

/** The list reloads as soon as an import wrote rows; the dialog stays open with the result. */
function openImport() {
  void openDialog(
    ImportDialog,
    {
      name: () => t('menu.iam.user'),
      template: (filename: string) => userApi.importTemplate(filename),
      upload: async (...args: Parameters<typeof userApi.importFile>) => {
        const result = await userApi.importFile(...args)
        if (result.inserted || result.updated) void refresh()
        return result
      },
    },
    { title: () => t('crud.title.import', { name: t('iam.user.entity') }), width: '560px' },
  )
}
</script>

<template>
  <div class="qw-page">
    <TreePanel
      :model-value="query.deptId"
      :data="depts"
      :label="(d) => tx(d.name)"
      :title="t('picker.dept.title')"
      storage-key="iam.user"
      :loading="deptsLoading"
      @update:model-value="pickDept"
    >
      <el-card v-show="showSearch" class="qw-search-panel">
        <el-form :model="query" inline @submit.prevent="search">
          <el-form-item :label="t('field.iam.user.keyword')">
            <el-input
              v-model="query.keyword"
              name="keyword"
              clearable
              :placeholder="t('iam.user.keywordHint')"
            />
          </el-form-item>
          <!-- masked contacts (no modify): the server ignores this filter, it would reveal the digits -->
          <el-form-item v-if="canModify" :label="t('field.iam.user.mobile')">
            <el-input v-model="query.mobile" name="mobile" clearable />
          </el-form-item>
          <el-form-item :label="t('field.iam.user.enabled')">
            <DictSelect v-model="query.enabled" code="core.enabled" />
          </el-form-item>
          <el-form-item :label="t('field.common.createdAt')" class="qw-search-wide">
            <el-date-picker
              v-model="query.createdAtRange"
              type="daterange"
              :shortcuts="dateRangeShortcuts"
              value-format="YYYY-MM-DD"
              :start-placeholder="t('field.common.createdAtFrom')"
              :end-placeholder="t('field.common.createdAtTo')"
            />
          </el-form-item>
          <el-form-item class="qw-search-actions">
            <!-- plain: the toolbar's create stays the page's one solid primary button (§1) -->
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
          table-id="iam.user"
          :columns="columns"
          @refresh="refresh"
        >
          <el-button v-perm="userPerms.create" type="primary" @click="openForm()">
            <el-icon class="el-icon--left"><Icon icon="lucide:plus" /></el-icon>
            {{ t('crud.action.create') }}
          </el-button>
          <el-button v-perm="userPerms.import" @click="openImport">
            <el-icon class="el-icon--left"><Icon icon="lucide:upload" /></el-icon>
            {{ t('crud.action.import') }}
          </el-button>
          <el-button
            v-perm="userPerms.export"
            :loading="exporting"
            @click="exportXlsx(`${t('menu.iam.user')}.xlsx`)"
          >
            <el-icon class="el-icon--left"><Icon icon="lucide:download" /></el-icon>
            {{ t('crud.action.export') }}
          </el-button>
          <el-button
            v-if="selection.length"
            v-perm="userPerms.remove"
            type="danger"
            plain
            @click="batchRemove"
          >
            {{ t('crud.action.batchDelete') }}
          </el-button>
        </TableToolbar>

        <QwTable
          table-id="iam.user"
          :columns="columns"
          :data="rows"
          :loading="loading"
          :filtered
          selection
          :actions-width="210"
          @selection-change="onSelectionChange"
          @sort-change="onSortChange"
          @reset-filters="reset"
        >
          <template #cell-username="{ row }">
            <el-button
              v-if="canView"
              link
              type="primary"
              class="user-name"
              @click="openDetail(row)"
            >
              {{ row.username }}
            </el-button>
            <template v-else>{{ row.username }}</template>
          </template>
          <!-- seeded dept names are i18n keys (seed.dept.*) -->
          <template #cell-deptName="{ row }">{{ row.deptName ? tx(row.deptName) : '' }}</template>
          <template #cell-enabled="{ row }">
            <el-switch
              v-if="canModify"
              size="small"
              :model-value="row.enabled"
              :disabled="locked(row)"
              :aria-label="`${t('field.iam.user.enabled')} ${row.username}`"
              @change="setEnabled(row, $event as boolean)"
            />
            <DictTag v-else code="core.enabled" :value="row.enabled" />
          </template>
          <template #cell-lastLoginAt="{ row }">{{ time(row.lastLoginAt) }}</template>
          <template #cell-createdAt="{ row }">{{ time(row.createdAt) }}</template>
          <template #actions="{ row }">
            <el-button
              v-if="canEdit"
              link
              type="primary"
              :disabled="rootOnly(row)"
              @click="openForm(row.id)"
            >
              {{ t('crud.action.edit') }}
            </el-button>
            <el-button
              v-perm="userPerms.remove"
              link
              type="danger"
              :disabled="locked(row)"
              @click="remove([row.id])"
            >
              {{ t('crud.action.delete') }}
            </el-button>
            <el-dropdown
              v-if="canReset || canAssign"
              class="user-more"
              trigger="click"
              @command="(c: string) => more(c, row)"
            >
              <el-button link type="primary">
                {{ t('crud.action.more') }}
                <el-icon class="el-icon--right"><Icon icon="lucide:chevron-down" /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item
                    v-if="canReset"
                    command="reset-password"
                    :disabled="rootOnly(row)"
                  >
                    <el-icon><Icon icon="lucide:key-round" /></el-icon>
                    {{ t('menu.action.resetPassword') }}
                  </el-dropdown-item>
                  <el-dropdown-item v-if="canAssign" command="assign-roles" :disabled="row.root">
                    <el-icon><Icon icon="lucide:user-cog" /></el-icon>
                    {{ t('menu.action.assignRoles') }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </QwTable>

        <Pagination
          v-model:page="query.page"
          v-model:page-size="query.pageSize"
          :total="total"
          @change="refresh"
        />
      </el-card>
    </TreePanel>

    <!-- destroy-on-close: each opening loads the user anew (it may have been edited meanwhile) -->
    <el-drawer v-model="detailOpen" :title="t('iam.user.detail')" size="480px" destroy-on-close>
      <UserDetail v-if="detailId" :id="detailId" />
    </el-drawer>
  </div>
</template>

<style scoped>
/* the name opening the detail drawer reads as a link on the row's text line */
.user-name {
  --el-button-font-weight: 500;
  height: auto;
  padding: 0;
  vertical-align: baseline;
}
/* the dropdown trigger sits in the actions row like the other text buttons */
.user-more {
  margin-left: 12px;
  vertical-align: middle;
}
</style>
