<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import { codegenPerms, type CgTableVo } from '@qiwu/shared'
import { codegenApi } from '@/api/platform/codegen'
import QwTable from '@/core/components/QwTable.vue'
import Pagination from '@/core/components/Pagination.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { localized } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import ImportTables from './import-tables.vue'
import { downloadZip, writeConfigs } from './output'
import CodegenPreview from './preview.vue'

/**
 * The generator's tables (see docs/design-notes.md#codegen): imported configs, the import dialog, sync with the
 * DDL, delete one or many; preview, download (one or the selected ones as one zip) and write into the
 * repository where the server allows it. Editing opens the hidden page `/codegen/tables/:id` (edit.vue).
 */
defineOptions({ name: 'CodegenTable' })
const { t } = useI18n()
const router = useRouter()
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
} = useCrudList({
  api: codegenApi,
  filters: { tableName: '', tableComment: '' },
  sort: '-updatedAt',
})
const showSearch = ref(true)
const columns: QwColumn[] = [
  {
    prop: 'tableName',
    label: 'field.codegen.tableName',
    sortable: true,
    width: 220,
    showOverflowTooltip: true,
  },
  {
    prop: 'featureName',
    label: 'field.codegen.featureName',
    width: 180,
    showOverflowTooltip: true,
  },
  { prop: 'className', label: 'field.codegen.className', width: 160, showOverflowTooltip: true },
  { prop: 'template', label: 'field.codegen.template', width: 140 },
  { prop: 'updatedAt', label: 'field.codegen.updatedAt', sortable: true, width: 160 },
  {
    prop: 'tableComment',
    label: 'field.codegen.tableComment',
    minWidth: 200,
    showOverflowTooltip: true,
  },
]
// computed: the perms reload when the server's permission version moves
const perm = usePerm()
// the edit page loads GET /:id (view) and saves (modify)
const canEdit = computed(() => perm.all([codegenPerms.modify, codegenPerms.view]))
const canSync = computed(() => perm.has(codegenPerms.modify))
const canRemove = computed(() => perm.has(codegenPerms.remove))
const canGenerate = computed(() => perm.has(codegenPerms.generate))
// writing only where the server runs in development with CODEGEN_WRITE (else the button stays hidden)
const writable = ref(false)
codegenApi
  .writable()
  .then((w) => (writable.value = w.writable))
  .catch(() => undefined)
const canWrite = computed(() => writable.value && perm.has(codegenPerms.write))

const edit = (row: CgTableVo) => router.push(`/codegen/tables/${row.id}`)

async function openImport() {
  const imported = await openDialog(
    ImportTables,
    {},
    { title: () => t('codegen.table.import.title'), width: '720px' },
  )
  if (imported) await refresh()
}

async function sync(row: CgTableVo) {
  try {
    await ElMessageBox.confirm(
      t('codegen.table.sync.confirm', { table: row.tableName }),
      t('crud.confirm.title'),
      {
        type: 'warning',
        confirmButtonText: t('codegen.table.action.sync'),
        cancelButtonText: t('common.action.cancel'),
      },
    )
  } catch {
    return
  }
  try {
    const { added, removed, changed } = await codegenApi.sync(row.id)
    ElMessage.success(
      t('codegen.table.sync.done', {
        added: added.length,
        removed: removed.length,
        changed: changed.length,
      }),
    )
    await refresh()
  } catch {
    // toasted by the request layer (422: the table is gone)
  }
}

const preview = (row: CgTableVo) =>
  openDialog(
    CodegenPreview,
    { id: row.id, tableName: row.tableName, writable: writable.value },
    { title: () => t('codegen.table.preview.title', { table: row.tableName }), width: '1200px' },
  )

/** the batch download / write running (their buttons show it) */
const busy = ref<'download' | 'write'>()
async function batch(kind: 'download' | 'write') {
  busy.value = kind
  if (kind === 'download') await downloadZip(selection.value)
  else await writeConfigs(selection.value.map((r) => r.id))
  busy.value = undefined
}

function more(command: string, row: CgTableVo) {
  if (command === 'sync') return sync(row)
  if (command === 'download') return downloadZip([row])
  if (command === 'write') return writeConfigs([row.id])
  if (command === 'remove') return remove([row.id])
}
</script>

<template>
  <div class="qw-page">
    <el-card v-show="showSearch" class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('field.codegen.tableName')">
          <el-input v-model="query.tableName" name="tableName" clearable />
        </el-form-item>
        <el-form-item :label="t('field.codegen.tableComment')">
          <el-input v-model="query.tableComment" name="tableComment" clearable />
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
        table-id="codegen.table"
        :columns="columns"
        @refresh="refresh"
      >
        <el-button v-perm="codegenPerms.import" type="primary" @click="openImport">
          <el-icon class="el-icon--left"><Icon icon="lucide:database" /></el-icon>
          {{ t('codegen.table.action.import') }}
        </el-button>
        <template v-if="selection.length">
          <el-button
            v-if="canGenerate"
            :loading="busy === 'download'"
            :disabled="!!busy"
            @click="batch('download')"
          >
            <el-icon class="el-icon--left"><Icon icon="lucide:download" /></el-icon>
            {{ t('codegen.table.action.batchDownload') }}
          </el-button>
          <el-button
            v-if="canWrite"
            :loading="busy === 'write'"
            :disabled="!!busy"
            @click="batch('write')"
          >
            <el-icon class="el-icon--left"><Icon icon="lucide:file-plus-2" /></el-icon>
            {{ t('codegen.table.action.batchWrite') }}
          </el-button>
        </template>
        <el-button
          v-if="selection.length"
          v-perm="codegenPerms.remove"
          type="danger"
          plain
          @click="batchRemove"
        >
          {{ t('crud.action.batchDelete') }}
        </el-button>
      </TableToolbar>

      <QwTable
        table-id="codegen.table"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :filtered
        :actions-width="210"
        selection
        @selection-change="onSelectionChange"
        @sort-change="onSortChange"
        @reset-filters="reset"
      >
        <template #cell-featureName="{ row }">
          {{ localized(row.featureNameI18n, row.featureName) }}
        </template>
        <!-- el-table also renders every cell once without a row: no key lookup then -->
        <template #cell-template="{ row }">{{
          row.template && t(`codegen.table.templates.${row.template}`)
        }}</template>
        <template #cell-updatedAt="{ row }">{{
          dayjs(row.updatedAt).format('YYYY-MM-DD HH:mm')
        }}</template>
        <template #actions="{ row }">
          <el-button v-if="canEdit" link type="primary" @click="edit(row)">
            {{ t('crud.action.edit') }}
          </el-button>
          <el-button v-if="canGenerate" link type="primary" @click="preview(row)">
            {{ t('codegen.table.action.preview') }}
          </el-button>
          <el-dropdown
            v-if="canSync || canGenerate || canWrite || canRemove"
            class="codegen-more"
            trigger="click"
            @command="(c: string) => more(c, row)"
          >
            <el-button link type="primary">
              {{ t('crud.action.more') }}
              <el-icon class="el-icon--right"><Icon icon="lucide:chevron-down" /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-if="canSync" command="sync">
                  <el-icon><Icon icon="lucide:refresh-cw" /></el-icon>
                  {{ t('codegen.table.action.sync') }}
                </el-dropdown-item>
                <el-dropdown-item v-if="canGenerate" command="download">
                  <el-icon><Icon icon="lucide:download" /></el-icon>
                  {{ t('codegen.table.action.download') }}
                </el-dropdown-item>
                <el-dropdown-item v-if="canWrite" command="write">
                  <el-icon><Icon icon="lucide:file-plus-2" /></el-icon>
                  {{ t('codegen.table.action.write') }}
                </el-dropdown-item>
                <el-dropdown-item v-if="canRemove" command="remove" divided>
                  <el-icon><Icon icon="lucide:trash-2" /></el-icon>
                  {{ t('crud.action.delete') }}
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
  </div>
</template>

<style scoped>
.codegen-more {
  margin-left: 12px;
  vertical-align: middle;
}
</style>
