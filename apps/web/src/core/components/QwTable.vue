<script setup lang="ts" generic="T extends object">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTablePrefs, type QwColumn } from '@/core/composables/use-table-prefs'
import EmptyState from './EmptyState.vue'

/**
 * el-table from a column array (see docs/design-notes.md#crud-kit): the `columns` in the user's order and visibility
 * (`useTablePrefs(tableId)`, edited in `TableToolbar`); a cell shows `row[prop]` unless the page gives
 * `#cell-<prop>="{ row }"`. `#actions="{ row }"` adds the fixed right actions column (not in the settings),
 * `selection` a checkbox column (`selectable(row)` false: that row's box is disabled). Other el-table
 * props and events (`@sort-change`, `@selection-change`) pass through to the el-table. Without rows it
 * shows `#empty`, by default an `EmptyState`: "no data", or with `filtered` (`useCrudList().filtered`)
 * "no match" and a clear-filters button (`@reset-filters`).
 */
defineOptions({ name: 'QwTable', inheritAttrs: false })
const {
  tableId,
  columns,
  data,
  loading = false,
  rowKey = 'id',
  selection = false,
  selectable,
  filtered = false,
  actionsWidth = 140,
} = defineProps<{
  /** `<domain>.<biz>`, e.g. `iam.position`: the settings key `table.<tableId>` */
  tableId: string
  columns: QwColumn[]
  data: T[]
  loading?: boolean
  rowKey?: string
  selection?: boolean
  /** rows the selection may take (default all), e.g. not the protected ones a batch action would refuse */
  selectable?: (row: T) => boolean
  /** the rows were loaded with a filter set: the empty state offers to clear it */
  filtered?: boolean
  actionsWidth?: number | string
}>()
const emit = defineEmits<{ resetFilters: [] }>()
defineSlots<
  { [slot: `cell-${string}`]: (scope: { row: T }) => unknown } & {
    actions?: (scope: { row: T }) => unknown
    empty?: () => unknown
  }
>()
const { t } = useI18n()
const { visibleColumns } = useTablePrefs(tableId, () => columns)
const hasLoaded = ref(false)
watch(
  () => loading,
  (busy, wasBusy) => {
    if (wasBusy && !busy) hasLoaded.value = true
  },
  { flush: 'sync' },
)
const columnWidth = (width: number | string) => `${Number.parseInt(String(width), 10)}px`
</script>

<template>
  <div v-if="loading && !hasLoaded" class="qw-table-skeleton" aria-busy="true">
    <p role="status">{{ t('crud.loading') }}</p>
    <el-skeleton :count="5" aria-hidden="true" inert>
      <template #template>
        <div class="qw-table-skeleton__row">
          <span v-if="selection" class="qw-table-skeleton__cell" style="flex: 0 0 48px">
            <el-skeleton-item />
          </span>
          <span
            v-for="c in visibleColumns"
            :key="c.prop"
            class="qw-table-skeleton__cell"
            :data-column="c.prop"
            :style="{
              flex: c.width
                ? `0 0 ${columnWidth(c.width)}`
                : `1 0 ${columnWidth(c.minWidth ?? 80)}`,
            }"
          >
            <el-skeleton-item />
          </span>
          <span
            v-if="$slots.actions"
            class="qw-table-skeleton__cell"
            :style="{ flex: `0 0 ${columnWidth(actionsWidth)}` }"
          >
            <el-skeleton-item />
          </span>
        </div>
      </template>
    </el-skeleton>
  </div>
  <el-table
    v-else
    v-bind="$attrs"
    v-loading="loading"
    :element-loading-text="t('crud.loading')"
    :data="data"
    :row-key="rowKey"
  >
    <el-table-column v-if="selection" type="selection" width="48" :selectable />
    <el-table-column
      v-for="c in visibleColumns"
      :key="c.prop"
      :prop="c.prop"
      :label="c.literal ? c.label : t(c.label)"
      :width="c.width"
      :min-width="c.minWidth"
      :sortable="c.sortable ? 'custom' : false"
      :align="c.align"
      :fixed="c.fixed"
      :show-overflow-tooltip="c.showOverflowTooltip"
    >
      <template v-if="$slots[`cell-${c.prop}`]" #default="{ row }">
        <slot :name="`cell-${c.prop}`" :row="row" />
      </template>
    </el-table-column>
    <el-table-column
      v-if="$slots.actions"
      :label="t('crud.action.operations')"
      :width="actionsWidth"
      fixed="right"
    >
      <template #default="{ row }"><slot name="actions" :row="row" /></template>
    </el-table-column>
    <template #empty>
      <slot name="empty">
        <EmptyState
          v-if="filtered"
          :title="t('common.empty.noMatch')"
          :description="t('common.empty.noMatchHint')"
        >
          <el-button @click="emit('resetFilters')">{{ t('crud.action.resetFilters') }}</el-button>
        </EmptyState>
        <EmptyState v-else />
      </slot>
    </template>
  </el-table>
</template>
