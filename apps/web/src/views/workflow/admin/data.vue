<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PAGE_SIZE_MAX,
  WF_DATA_BASE_COLUMNS,
  WF_DATA_FILTERS_MAX,
  WF_FIELD_OPS,
  WF_TEMPLATE_KEY_PREFIX,
  wfPerms,
  type WfDataFilter,
  type WfDataPageVo,
  type WfDataRowVo,
  type WfModelVo,
  type WfOp,
} from '@qiwu/shared'
import { wfAdminApi } from '@/api/workflow/admin'
import { wfModelApi } from '@/api/workflow/model'
import DeptTreeSelect from '@/core/components/DeptTreeSelect.vue'
import DictSelect from '@/core/components/DictSelect.vue'
import DictTag from '@/core/components/DictTag.vue'
import EmptyState from '@/core/components/EmptyState.vue'
import IconButton from '@/core/components/IconButton.vue'
import Pagination from '@/core/components/Pagination.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import UserSelect from '@/core/components/UserSelect.vue'
import { useCrudList } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { currentLocale, refName, tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { at } from '../center/use-center-list'
import WfUserIds from '../designer/WfUserIds.vue'
import { blankFilter, cellText, fieldProp, filtersParam, withheldHint, withOp } from './data-page'

/**
 * 审批数据: a model's instances (all its versions) with the picked version's form fields
 * as columns (default the current version), filtered by state, initiator, start date and field values (each
 * field type its own ops, as fork conditions), exported with the same columns and filters. The server
 * limits the rows to the caller's data scope on the initiator's dept, and the fields to the ones no step
 * hides unless the caller is root or a process admin of the model (a hint says how many it withheld).
 */
defineOptions({ name: 'WfData' })
const { t } = useI18n()

const models = shallowRef<WfModelVo[]>([])
// The first PAGE_SIZE_MAX models by sort order; a remote search when a deployment has more
wfModelApi
  .page({ pageSize: PAGE_SIZE_MAX, sort: 'sortNo,id' })
  .then(
    (p) => (models.value = p.items.filter((m) => !m.modelKey.startsWith(WF_TEMPLATE_KEY_PREFIX))),
  )
  .catch(() => undefined) // the request layer showed it
const modelKey = ref('')
/** null = the model's current version */
const version = ref<number | null>(null)
/** the last answer's version, versions and columns */
const head = shallowRef<Omit<WfDataPageVo, 'items' | 'total'>>()
const fieldColumns = computed(() => head.value?.columns ?? [])
const typeOf = (field: string) => fieldColumns.value.find((c) => c.field === field)?.type

/** list params as the data route takes them: the version, the ready field filters as JSON */
function params({ fieldFilters, ...rest }: Record<string, unknown>) {
  const filters = filtersParam(fieldFilters as WfDataFilter[], fieldColumns.value)
  return { ...rest, version: version.value ?? undefined, filters }
}
let seq = 0
const {
  query,
  rows,
  total,
  loading,
  filtered,
  search,
  reset,
  refresh,
  onSortChange,
  exporting,
  exportXlsx,
} = useCrudList<
  WfDataRowVo,
  {
    state: string
    initiatorId: number | null
    startedAtRange: [string, string] | null
    fieldFilters: WfDataFilter[]
  }
>({
  api: {
    page: async (p) => {
      const mine = ++seq
      if (!modelKey.value) {
        head.value = undefined
        return { items: [], total: 0 }
      }
      const { items, total, ...rest } = await wfAdminApi.data(modelKey.value, params(p))
      if (mine === seq) head.value = rest
      return { items, total }
    },
    exportFile: (p, filename) => wfAdminApi.exportData(modelKey.value, params(p), filename),
  },
  filters: { state: '', initiatorId: null, startedAtRange: null, fieldFilters: [] },
  sort: '-startedAt',
})
const showSearch = ref(true)
// the form titles come in the reader's language
watch(currentLocale, () => void refresh())

/** another model or version has other fields: its filters start over */
function pick() {
  query.fieldFilters = []
  return search()
}
function pickModel() {
  version.value = null
  return pick()
}

const WIDTH: Record<(typeof WF_DATA_BASE_COLUMNS)[number], Partial<QwColumn>> = {
  id: { width: 90, sortable: true },
  state: { width: 110 },
  initiator: { width: 140, showOverflowTooltip: true },
  dept: { width: 140, showOverflowTooltip: true },
  startedAt: { width: 170, sortable: true },
  endedAt: { width: 170, sortable: true },
}
const baseColumns: QwColumn[] = WF_DATA_BASE_COLUMNS.map((prop) => ({
  prop,
  label: `field.wf.data.${prop}`,
  ...WIDTH[prop],
}))
// the export's columns in its order: the fixed ones, then the form fields titled as the form shows them
const columns = computed<QwColumn[]>(() => [
  ...baseColumns,
  ...fieldColumns.value.map((c) => ({
    prop: fieldProp(c.field),
    label: c.label,
    literal: true,
    minWidth: 120,
    showOverflowTooltip: true,
  })),
])
const slotOf = (field: string) => `cell-${fieldProp(field)}`

function addFilter() {
  const first = fieldColumns.value[0]
  if (first) query.fieldFilters.push(blankFilter(first.field, first.type))
}
function setField(i: number, field: string) {
  const type = typeOf(field)
  if (type) query.fieldFilters[i] = blankFilter(field, type)
}
const setOp = (i: number, op: WfOp) => (query.fieldFilters[i] = withOp(query.fieldFilters[i]!, op))
/** which value input a filter gets: its field's type, a list of them for `in` */
const editor = (f: WfDataFilter) => `${typeOf(f.field) ?? 'string'}${f.op === 'in' ? 's' : ''}`
const numberOrNull = (v: WfDataFilter['value']) => (typeof v === 'number' ? v : null)
const ids = (v: WfDataFilter['value']) =>
  (Array.isArray(v) ? v : []).filter((x): x is number => typeof x === 'number')
const texts = (v: WfDataFilter['value']) => (Array.isArray(v) ? v.map(String) : [])
const numbers = (v?: string[]) => (v ?? []).map(Number).filter((n) => Number.isFinite(n))
</script>

<template>
  <div class="qw-page">
    <el-card v-show="showSearch" class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('wf.data.model')">
          <el-select
            v-model="modelKey"
            filterable
            :placeholder="t('wf.data.pickModel')"
            :aria-label="t('wf.data.model')"
            @change="pickModel"
          >
            <el-option
              v-for="m in models"
              :key="m.modelKey"
              :label="tx(m.name)"
              :value="m.modelKey"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('field.wf.data.version')">
          <el-select
            v-model="version"
            clearable
            :disabled="!head?.versions.length"
            :placeholder="
              head?.version ? t('wf.data.currentVersion', { version: head.version }) : ''
            "
            :aria-label="t('field.wf.data.version')"
            @change="pick"
          >
            <el-option
              v-for="v in head?.versions"
              :key="v"
              :label="t('wf.data.versionOption', { version: v })"
              :value="v"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('field.wf.data.state')">
          <DictSelect
            v-model="query.state"
            code="wf.instance_state"
            :aria-label="t('field.wf.data.state')"
          />
        </el-form-item>
        <el-form-item :label="t('field.wf.data.initiatorId')">
          <UserSelect v-model="query.initiatorId" />
        </el-form-item>
        <el-form-item :label="t('field.wf.data.startedAt')" class="qw-search-wide">
          <el-date-picker
            v-model="query.startedAtRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            :start-placeholder="t('field.wf.data.startedAtFrom')"
            :end-placeholder="t('field.wf.data.startedAtTo')"
          />
        </el-form-item>
        <el-form-item :label="t('field.wf.data.filters')" class="wf-data__filters">
          <div v-for="(f, i) in query.fieldFilters" :key="i" class="wf-data__filter">
            <el-select
              :model-value="f.field"
              class="wf-data__field"
              filterable
              :aria-label="t('wf.designer.cond.field')"
              @update:model-value="(v: string) => setField(i, v)"
            >
              <el-option
                v-for="c in fieldColumns"
                :key="c.field"
                :label="c.label"
                :value="c.field"
              />
            </el-select>
            <el-select
              :model-value="f.op"
              class="wf-data__op"
              :aria-label="t('wf.designer.cond.op')"
              @update:model-value="(op: WfOp) => setOp(i, op)"
            >
              <el-option
                v-for="op in WF_FIELD_OPS[typeOf(f.field) ?? 'string']"
                :key="op"
                :label="t(`wf.designer.op.${op}`)"
                :value="op"
              />
            </el-select>
            <div class="wf-data__value">
              <el-input-number
                v-if="editor(f) === 'number'"
                :model-value="numberOrNull(f.value)"
                controls-position="right"
                :aria-label="t('wf.designer.cond.value')"
                @update:model-value="(v?: number | null) => (f.value = v ?? '')"
              />
              <el-date-picker
                v-else-if="editor(f) === 'date'"
                :model-value="typeof f.value === 'string' ? f.value : ''"
                type="date"
                value-format="YYYY-MM-DD"
                :aria-label="t('wf.designer.cond.value')"
                @update:model-value="(v: string | null) => (f.value = v ?? '')"
              />
              <UserSelect
                v-else-if="editor(f) === 'user'"
                :model-value="numberOrNull(f.value)"
                @update:model-value="(v) => (f.value = v ?? '')"
              />
              <WfUserIds
                v-else-if="editor(f) === 'users'"
                :model-value="ids(f.value)"
                @update:model-value="(v) => (f.value = v)"
              />
              <DeptTreeSelect
                v-else-if="editor(f) === 'dept' || editor(f) === 'depts'"
                :model-value="editor(f) === 'dept' ? numberOrNull(f.value) : ids(f.value)"
                :multiple="editor(f) === 'depts'"
                :aria-label="t('wf.designer.cond.value')"
                @update:model-value="(v) => (f.value = v ?? '')"
              />
              <el-input-tag
                v-else-if="editor(f) === 'numbers' || editor(f) === 'strings'"
                :model-value="texts(f.value)"
                :placeholder="t('wf.designer.cond.values')"
                :aria-label="t('wf.designer.cond.value')"
                @update:model-value="
                  (v?: string[]) => (f.value = editor(f) === 'numbers' ? numbers(v) : (v ?? []))
                "
              />
              <el-input
                v-else
                :model-value="String(f.value)"
                :aria-label="t('wf.designer.cond.value')"
                @update:model-value="(v: string) => (f.value = v)"
              />
            </div>
            <IconButton
              icon="lucide:x"
              :label="t('wf.designer.cond.remove')"
              @click="query.fieldFilters.splice(i, 1)"
            />
          </div>
          <el-button
            link
            type="primary"
            :disabled="!fieldColumns.length || query.fieldFilters.length >= WF_DATA_FILTERS_MAX"
            @click="addFilter"
          >
            <el-icon class="el-icon--left"><Icon icon="lucide:plus" /></el-icon>
            {{ t('wf.data.addFilter') }}
          </el-button>
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
      <!-- Column settings cover the fixed columns only, the form fields always follow them (the
        stored props take `[\w.]`, a field name may be anything; per-model settings if users ask) -->
      <TableToolbar
        v-model:search="showSearch"
        table-id="wf.data"
        :columns="baseColumns"
        @refresh="refresh"
      >
        <el-button
          v-perm="wfPerms.data.export"
          :loading="exporting"
          :disabled="!head?.version"
          @click="exportXlsx(`${t('menu.wf.data')}.xlsx`)"
        >
          <el-icon class="el-icon--left"><Icon icon="lucide:download" /></el-icon>
          {{ t('crud.action.export') }}
        </el-button>
      </TableToolbar>
      <el-alert
        v-if="head?.withheld"
        class="wf-data__withheld"
        type="info"
        show-icon
        :closable="false"
        :title="withheldHint(head.withheld)"
      />
      <QwTable
        table-id="wf.data"
        :columns="columns"
        :data="rows"
        :loading="loading"
        :filtered
        @sort-change="onSortChange"
        @reset-filters="reset"
      >
        <template #cell-state="{ row }">
          <DictTag code="wf.instance_state" :value="row.state" />
        </template>
        <template #cell-initiator="{ row }">
          {{ refName(row.initiator.id, row.initiator.name) }}
        </template>
        <template #cell-dept="{ row }">{{ row.dept?.name ? tx(row.dept.name) : '' }}</template>
        <template #cell-startedAt="{ row }">{{ at(row.startedAt) }}</template>
        <template #cell-endedAt="{ row }">{{ at(row.endedAt) }}</template>
        <template v-for="c in fieldColumns" :key="c.field" #[slotOf(c.field)]="{ row }">
          {{ cellText(row.values[c.field], c.type) }}
        </template>
        <template v-if="!modelKey" #empty>
          <EmptyState :title="t('wf.data.pickModel')" />
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
.wf-data__withheld {
  margin-bottom: 12px;
}
.wf-data__filters {
  grid-column: 1 / -1;
}
.wf-data__filters :deep(.el-form-item__content) {
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
.wf-data__filter {
  display: flex;
  gap: 6px;
  align-items: center;
  width: 100%;
  max-width: 720px;
}
.wf-data__field {
  flex: 0 0 180px;
}
.wf-data__op {
  flex: 0 0 136px;
}
.wf-data__value {
  flex: 1;
  min-width: 0;
}
.wf-data__value > * {
  width: 100%;
}
</style>
