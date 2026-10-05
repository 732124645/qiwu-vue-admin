<script setup lang="ts">
import { computed, onActivated, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { PAGE_SIZE_MAX, wfPerms, type WfModelVo } from '@qiwu/shared'
import { wfModelApi } from '@/api/workflow/model'
import DictSelect from '@/core/components/DictSelect.vue'
import DictTag from '@/core/components/DictTag.vue'
import IconButton from '@/core/components/IconButton.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest, useCrudList } from '@/core/composables/use-crud'
import { useDict } from '@/core/composables/use-dict'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { openDialog } from '@/core/dialog'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { usePerm } from '@/core/permission'
import { byCategory, categorySpan, moveInCategory } from './model-list'
import WfModelForm from './WfModelForm.vue'
import WfModelVersions from './WfModelVersions.vue'

/**
 * 模型管理 (see docs/design-notes.md#workflow) on the model API (`wfPerms.model`): the models grouped by category (dict
 * `wf.category`, in its order), each category in `sortNo` order, moved up / down in place; add / edit in
 * `WfModelForm`, enable / disable, the published versions (each exported as JSON, a JSON imported as the
 * next one, a BPMN model's exported as `.bpmn`, imported only in its designer), delete one never
 * published; 设计 opens the designer page (`model-design.vue`), 向导 a dynamic tree model's form and flow
 * in the new-approval wizard (`wizard/index.vue`).
 * More models than one request loads: a hint to filter, and no moves (they renumber shown rows only).
 */
defineOptions({ name: 'WfModel' })
const { t } = useI18n()
const category = useDict('wf.category')
// One request of up to PAGE_SIZE_MAX models, grouped here; page per category if a deployment has more
const { query, rows, total, loading, filtered, search, reset, refresh, remove } = useCrudList({
  api: {
    page: (params) => wfModelApi.page({ ...params, page: 1, pageSize: PAGE_SIZE_MAX }),
    remove: wfModelApi.remove,
  },
  filters: { name: '', modelKey: '', category: '', enabled: null as string | null },
  sort: 'sortNo',
})
const truncated = computed(() => total.value > rows.value.length)
const grouped = computed(() =>
  byCategory(
    rows.value,
    category.options.value.map((o) => o.value),
  ),
)
const showSearch = ref(true)
// the order is the category's sort order (moved with the arrows): no sortable columns
const columns: QwColumn[] = [
  { prop: 'category', label: 'field.wf.model.category', width: 120 },
  { prop: 'name', label: 'field.wf.model.name', minWidth: 180, showOverflowTooltip: true },
  { prop: 'modelKey', label: 'field.wf.model.modelKey', width: 160, showOverflowTooltip: true },
  { prop: 'formKind', label: 'field.wf.model.formKind', width: 120 },
  { prop: 'flowKind', label: 'field.wf.model.flowKind', width: 110 },
  { prop: 'currentVersionId', label: 'wf.model.list.published', width: 110 },
  { prop: 'sortNo', label: 'field.wf.model.sortNo', width: 100, align: 'right' },
  { prop: 'enabled', label: 'field.wf.model.enabled', width: 100 },
]
const perm = usePerm()
const canModify = computed(() => perm.has(wfPerms.model.modify))
// the edit form loads GET /:id, which needs `view` too
const canEdit = computed(() => perm.all([wfPerms.model.modify, wfPerms.model.view]))
// the design page loads GET /:id; it holds publish (menu seed: its holders get the route)
const canDesign = computed(() => perm.all([wfPerms.model.publish, wfPerms.model.view]))
// the wizard loads the model and its form, saves both and publishes
const canWizard = computed(() =>
  perm.all([
    wfPerms.model.view,
    wfPerms.model.modify,
    wfPerms.model.publish,
    wfPerms.form.view,
    wfPerms.form.modify,
  ]),
)
const router = useRouter()
// kept alive: reload when shown again (a model published or its draft saved on the design page meanwhile)
let shown = false
onActivated(() => {
  if (shown) void refresh()
  shown = true
})

/** one category cell per group (el-table span-method) */
function spanMethod({ column, rowIndex }: { column: { property?: string }; rowIndex: number }) {
  if (column.property !== 'category') return
  const rowspan = categorySpan(grouped.value, rowIndex)
  return { rowspan, colspan: rowspan ? 1 : 0 }
}

async function openForm(id?: number) {
  const name = () => t('wf.model.entity')
  const saved = await openDialog(
    WfModelForm,
    { id },
    {
      title: () => t(id ? 'crud.title.edit' : 'crud.title.create', { name: name() }),
      width: 680,
    },
  )
  if (saved) await refresh()
}

function openVersions(row: WfModelVo) {
  void openDialog(
    WfModelVersions,
    // an imported JSON publishes a version: the list's published / delete follow
    { model: row, onPublished: refresh },
    { title: () => t('wf.model.versions.title', { name: tx(row.name) }), width: 720 },
  )
}

async function setEnabled(row: WfModelVo, enabled: boolean) {
  // failures are toasted by the request layer; the reload shows the stored state either way
  await wfModelApi.setEnabled(row.id, enabled).catch(() => undefined)
  await refresh()
}

const moving = ref(false)
/** within the row's category on the whole list (a filtered or truncated one may show part of a category) */
const canMove = (row: WfModelVo, delta: -1 | 1) =>
  !moving.value &&
  !filtered.value &&
  !truncated.value &&
  !!moveInCategory(grouped.value, row, delta)
async function move(row: WfModelVo, delta: -1 | 1) {
  const items = moveInCategory(grouped.value, row, delta)
  if (!items || !canMove(row, delta)) return
  moving.value = true
  try {
    await wfModelApi.sort({ items })
  } catch (e) {
    toastRest(e)
  }
  // the reload shows the stored order either way; no move on the old one meanwhile
  await refresh()
  moving.value = false
}
</script>

<template>
  <div class="qw-page">
    <el-card v-show="showSearch" class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('field.wf.model.name')">
          <el-input v-model="query.name" name="name" clearable />
        </el-form-item>
        <el-form-item :label="t('field.wf.model.modelKey')">
          <el-input v-model="query.modelKey" name="modelKey" clearable />
        </el-form-item>
        <el-form-item :label="t('field.wf.model.category')">
          <DictSelect
            v-model="query.category"
            code="wf.category"
            :aria-label="t('field.wf.model.category')"
          />
        </el-form-item>
        <el-form-item :label="t('field.wf.model.enabled')">
          <DictSelect
            v-model="query.enabled"
            code="core.enabled"
            :aria-label="t('field.wf.model.enabled')"
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
        table-id="wf.model"
        :columns="columns"
        @refresh="refresh"
      >
        <el-button v-perm="wfPerms.model.create" type="primary" @click="openForm()">
          <el-icon class="el-icon--left"><Icon icon="lucide:plus" /></el-icon>
          {{ t('crud.action.create') }}
        </el-button>
      </TableToolbar>

      <el-alert
        v-if="truncated"
        class="wf-model__truncated"
        type="warning"
        :closable="false"
        show-icon
        :title="t('wf.model.list.truncated', { max: PAGE_SIZE_MAX, total })"
      />

      <QwTable
        table-id="wf.model"
        :columns="columns"
        :data="grouped"
        :loading="loading"
        :filtered
        :span-method="spanMethod"
        :actions-width="340"
        @reset-filters="reset"
      >
        <template #cell-category="{ row }">
          <DictTag code="wf.category" :value="row.category" />
        </template>
        <!-- seeded names are i18n keys (seed.wf.*) -->
        <template #cell-name="{ row }">
          <span class="wf-model__name">
            <Icon :icon="row.icon || 'lucide:file-text'" class="wf-model__icon" />
            {{ tx(row.name) }}
          </span>
        </template>
        <template #cell-formKind="{ row }">{{ t(`wf.model.formKinds.${row.formKind}`) }}</template>
        <template #cell-flowKind="{ row }">{{ t(`wf.model.flowKinds.${row.flowKind}`) }}</template>
        <template #cell-currentVersionId="{ row }">
          <el-tag v-if="row.currentVersionId" type="success" disable-transitions>
            {{ t('wf.model.list.yes') }}
          </el-tag>
          <el-tag v-else type="info" disable-transitions>{{ t('wf.model.list.no') }}</el-tag>
        </template>
        <template #cell-enabled="{ row }">
          <el-switch
            v-if="canModify"
            size="small"
            :model-value="row.enabled"
            :aria-label="`${t('field.wf.model.enabled')} ${tx(row.name)}`"
            @change="setEnabled(row, $event as boolean)"
          />
          <DictTag v-else code="core.enabled" :value="row.enabled" />
        </template>
        <template #actions="{ row }">
          <span v-if="canModify" class="wf-model__move">
            <IconButton
              icon="lucide:arrow-up"
              :label="t('wf.model.list.moveUp', { name: tx(row.name) })"
              :disabled="!canMove(row, -1)"
              @click="move(row, -1)"
            />
            <IconButton
              icon="lucide:arrow-down"
              :label="t('wf.model.list.moveDown', { name: tx(row.name) })"
              :disabled="!canMove(row, 1)"
              @click="move(row, 1)"
            />
          </span>
          <el-button v-if="canEdit" link type="primary" @click="openForm(row.id)">
            {{ t('crud.action.edit') }}
          </el-button>
          <el-button
            v-if="canDesign"
            link
            type="primary"
            @click="router.push(`/wf/models/${row.id}/design`)"
          >
            {{ t('wf.model.list.design') }}
          </el-button>
          <!-- a dynamic tree model's form and flow in one place (新建审批's page, no BPMN) -->
          <el-button
            v-if="canWizard && row.formKind === 'dynamic' && row.flowKind === 'tree'"
            link
            type="primary"
            @click="router.push(`/wf/wizard/${row.id}`)"
          >
            {{ t('wf.model.list.wizard') }}
          </el-button>
          <el-button v-perm="wfPerms.model.view" link type="primary" @click="openVersions(row)">
            {{ t('wf.model.list.versions') }}
          </el-button>
          <el-button
            v-if="!row.currentVersionId"
            v-perm="wfPerms.model.remove"
            link
            type="danger"
            @click="remove([row.id])"
          >
            {{ t('crud.action.delete') }}
          </el-button>
        </template>
      </QwTable>
    </el-card>
  </div>
</template>

<style scoped>
.wf-model__truncated {
  margin-bottom: 12px;
}
.wf-model__name {
  display: inline-flex;
  gap: 8px;
  align-items: center;
}
.wf-model__icon {
  flex: none;
  color: var(--qw-text-3);
}
.wf-model__move {
  display: inline-flex;
  gap: 2px;
  margin-right: 8px;
  vertical-align: middle;
}
.wf-model__move .icon-button {
  width: 24px;
  height: 24px;
}
.wf-model__move .icon-button:disabled {
  cursor: not-allowed;
  background: transparent;
  opacity: 0.35;
}
</style>
