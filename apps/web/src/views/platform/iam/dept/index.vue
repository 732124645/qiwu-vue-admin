<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { deptPerms, type DeptNode } from '@qiwu/shared'
import { deptApi } from '@/api/platform/iam/dept'
import DictSelect from '@/core/components/DictSelect.vue'
import DictTag from '@/core/components/DictTag.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { useTreeList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import DeptForm from './form.vue'

// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'IamDept' })

const { t } = useI18n()
const { query, rows, loading, filtered, search, reset, refresh, remove, expanded, toggleExpand } =
  useTreeList({
    api: deptApi,
    filters: { name: '', enabled: null as string | null },
  })
const showSearch = ref(true)
// the tree column (expand arrows) is the first shown one; order and visibility are the user's column
// settings (table id `iam.dept`); no server sort: siblings come by sort order
const columns: QwColumn[] = [
  { prop: 'name', label: 'field.iam.dept.name', minWidth: 240, showOverflowTooltip: true },
  { prop: 'headUserName', label: 'field.iam.dept.headUserName', width: 140 },
  { prop: 'phone', label: 'field.iam.dept.phone', width: 140, hidden: true },
  { prop: 'email', label: 'field.iam.dept.email', width: 200, hidden: true },
  { prop: 'sortNo', label: 'field.iam.dept.sortNo', width: 100, align: 'right' },
  { prop: 'enabled', label: 'field.iam.dept.enabled', width: 100 },
  { prop: 'createdAt', label: 'field.common.createdAt', width: 160 },
]
const perm = usePerm()
const canModify = computed(() => perm.has(deptPerms.modify))
// the edit form loads GET /:id, which needs `view` too
const canEdit = computed(() => perm.all([deptPerms.modify, deptPerms.view]))

/** Add (no id; under `parentId`, else at the top) or edit in the form dialog; reload once saved. */
async function openForm(id?: number, parentId?: number) {
  const name = () => t('iam.dept.entity')
  const saved = await openDialog(
    DeptForm,
    { id, parentId },
    { title: () => t(id ? 'crud.title.edit' : 'crud.title.create', { name: name() }) },
  )
  if (saved) await refresh()
}

async function setEnabled(row: DeptNode, enabled: boolean) {
  // failures (an enabled child) are toasted by the request layer; the reload shows the stored state
  await deptApi.setEnabled(row.id, enabled).catch(() => undefined)
  await refresh()
}
</script>

<template>
  <div class="qw-page">
    <el-card v-show="showSearch" class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('field.iam.dept.name')">
          <el-input v-model="query.name" name="name" clearable />
        </el-form-item>
        <el-form-item :label="t('field.iam.dept.enabled')">
          <DictSelect v-model="query.enabled" code="core.enabled" />
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
        table-id="iam.dept"
        :columns="columns"
        @refresh="refresh"
      >
        <el-button v-perm="deptPerms.create" type="primary" @click="openForm()">
          <el-icon class="el-icon--left"><Icon icon="lucide:plus" /></el-icon>
          {{ t('crud.action.create') }}
        </el-button>
        <el-button @click="toggleExpand">
          <el-icon class="el-icon--left">
            <Icon :icon="expanded ? 'lucide:chevrons-down-up' : 'lucide:chevrons-up-down'" />
          </el-icon>
          {{ t(expanded ? 'crud.action.collapseAll' : 'crud.action.expandAll') }}
        </el-button>
      </TableToolbar>

      <!-- a new key re-renders the rows with every node expanded or collapsed -->
      <QwTable
        :key="`${expanded}`"
        table-id="iam.dept"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :filtered
        :default-expand-all="expanded"
        :actions-width="230"
        @reset-filters="reset"
      >
        <!-- seeded names are i18n keys (seed.dept.*) -->
        <template #cell-name="{ row }">{{ tx(row.name) }}</template>
        <template #cell-enabled="{ row }">
          <el-switch
            v-if="canModify"
            size="small"
            :model-value="row.enabled"
            :aria-label="`${t('field.iam.dept.enabled')} ${tx(row.name)}`"
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
          <!-- nothing is added under a disabled dept (the server refuses it too) -->
          <el-button
            v-perm="deptPerms.create"
            link
            type="primary"
            :disabled="!row.enabled"
            @click="openForm(undefined, row.id)"
          >
            {{ t('crud.action.addChild') }}
          </el-button>
          <el-button
            v-perm="deptPerms.remove"
            link
            type="danger"
            :disabled="row.children.length > 0"
            @click="remove(row.id)"
          >
            {{ t('crud.action.delete') }}
          </el-button>
        </template>
      </QwTable>
    </el-card>
  </div>
</template>
