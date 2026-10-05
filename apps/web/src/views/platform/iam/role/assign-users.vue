<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { RoleMemberVo, RoleVo } from '@qiwu/shared'
import { roleApi } from '@/api/platform/iam/role'
import DictTag from '@/core/components/DictTag.vue'
import QwTable from '@/core/components/QwTable.vue'
import Pagination from '@/core/components/Pagination.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { useTagsStore } from '@/core/stores/tags'

/**
 * The members of a role (hidden page `/iam/roles/:id/users`, the `visible = 0` menu row delivered with the
 * `iam.role.assign-users` action): the users holding it and the ones who do not, in two tabs,
 * both only among the users of the caller's data scope (GET /:id/members). Add the ticked users (or one
 * row) to the role, or take them out of it (POST /:id/members, /:id/members/revoke); the server's grant
 * policy judges each add, and the users get the change at their next request.
 */
defineOptions({ name: 'IamRoleAssignUsers' })
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const tags = useTagsStore()
const id = Number(route.params.id)

const role = shallowRef<RoleVo>()
roleApi
  .get(id)
  .then((r) => (role.value = r))
  .catch(() => undefined) // the request layer showed it (404)

/** the tab: the users holding the role ('true') or the others */
const assigned = ref('true')
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
} = useCrudList<RoleMemberVo>({
  // the tab rides along outside the filters: reset keeps it, `filtered` ignores it
  api: { page: (params) => roleApi.members(id, { ...params, assigned: assigned.value }) },
  filters: { keyword: '' },
  sort: 'username',
})
const showSearch = ref(true)

const columns: QwColumn[] = [
  {
    prop: 'username',
    label: 'field.iam.user.username',
    sortable: true,
    width: 160,
    showOverflowTooltip: true,
  },
  {
    prop: 'displayName',
    label: 'field.iam.user.displayName',
    sortable: true,
    minWidth: 160,
    showOverflowTooltip: true,
  },
  { prop: 'deptName', label: 'field.iam.user.deptName', width: 160, showOverflowTooltip: true },
  { prop: 'enabled', label: 'field.iam.user.enabled', width: 100 },
  { prop: 'createdAt', label: 'field.common.createdAt', sortable: true, width: 160 },
]

const busy = ref(false)
/** Adds (`add`) or takes out the users `ids`; a removal asks first. */
async function change(add: boolean, ids: number[]) {
  if (!ids.length || busy.value) return
  if (!add)
    try {
      await ElMessageBox.confirm(
        t('iam.role.members.confirmRevoke', { count: ids.length }),
        t('crud.confirm.title'),
        {
          type: 'warning',
          confirmButtonText: t('iam.role.members.revoke'),
          cancelButtonText: t('common.action.cancel'),
        },
      )
    } catch {
      return
    }
  busy.value = true
  try {
    await (add ? roleApi.addMembers(id, ids) : roleApi.revokeMembers(id, ids))
    ElMessage.success(t(add ? 'iam.role.members.added' : 'iam.role.members.revoked'))
    await refresh()
  } catch {
    // toasted by the request layer (403 grant_exceeds_own, 404 out of scope, 422 root)
  } finally {
    busy.value = false
  }
}
const picked = () => selection.value.map((u) => u.id)

function back() {
  tags.close((tag) => tag.path === route.path)
  return router.push('/iam/roles')
}
</script>

<template>
  <div class="qw-page">
    <div class="qw-page-bar">
      <el-button @click="back">
        <el-icon class="el-icon--left"><Icon icon="lucide:arrow-left" /></el-icon>
        {{ t('iam.role.members.back') }}
      </el-button>
    </div>

    <el-card class="assign-users__role">
      <el-descriptions v-if="role" :title="t('iam.role.members.role')" :column="3">
        <el-descriptions-item :label="t('field.iam.role.name')">
          {{ tx(role.name) }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('field.iam.role.code')">{{
          role.code
        }}</el-descriptions-item>
        <el-descriptions-item :label="t('field.iam.role.dataScope')">
          <DictTag code="iam.data_scope" :value="role.dataScope" />
        </el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card v-show="showSearch" class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('field.iam.role.keyword')">
          <el-input v-model="query.keyword" name="keyword" clearable />
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
      <el-tabs v-model="assigned" class="assign-users__tabs" @tab-change="search">
        <el-tab-pane :label="t('iam.role.members.assigned')" name="true" />
        <el-tab-pane :label="t('iam.role.members.unassigned')" name="false" />
      </el-tabs>
      <TableToolbar
        v-model:search="showSearch"
        table-id="iam.role.members"
        :columns="columns"
        @refresh="refresh"
      >
        <el-button
          v-if="assigned === 'false'"
          type="primary"
          :disabled="!selection.length"
          :loading="busy"
          @click="change(true, picked())"
        >
          <el-icon class="el-icon--left"><Icon icon="lucide:user-plus" /></el-icon>
          {{ t('iam.role.members.batchAdd') }}
        </el-button>
        <el-button
          v-else
          type="danger"
          plain
          :disabled="!selection.length"
          :loading="busy"
          @click="change(false, picked())"
        >
          <el-icon class="el-icon--left"><Icon icon="lucide:user-minus" /></el-icon>
          {{ t('iam.role.members.batchRevoke') }}
        </el-button>
      </TableToolbar>

      <QwTable
        table-id="iam.role.members"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :filtered
        selection
        @selection-change="onSelectionChange"
        @sort-change="onSortChange"
        @reset-filters="reset"
      >
        <!-- seeded dept names are i18n keys (seed.dept.*) -->
        <template #cell-deptName="{ row }">{{ row.deptName ? tx(row.deptName) : '' }}</template>
        <template #cell-enabled="{ row }">
          <DictTag code="core.enabled" :value="row.enabled" />
        </template>
        <template #cell-createdAt="{ row }">
          {{ dayjs(row.createdAt).format('YYYY-MM-DD HH:mm') }}
        </template>
        <template #actions="{ row }">
          <el-button
            v-if="assigned === 'false'"
            link
            type="primary"
            :disabled="busy"
            @click="change(true, [row.id])"
          >
            {{ t('iam.role.members.add') }}
          </el-button>
          <el-button v-else link type="danger" :disabled="busy" @click="change(false, [row.id])">
            {{ t('iam.role.members.revoke') }}
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
.assign-users__role :deep(.el-descriptions__header) {
  margin-bottom: 12px;
}
.assign-users__tabs {
  padding: 0 16px;
}
.assign-users__tabs :deep(.el-tabs__header) {
  margin: 0;
}
</style>
