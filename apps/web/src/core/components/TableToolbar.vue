<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AllowDropType, CheckedInfo, NodeDropType, TreeNodeData } from 'element-plus'
import IconButton from './IconButton.vue'
import { useTablePrefs, type QwColumn } from '@/core/composables/use-table-prefs'

/**
 * Above a CRUD table: action buttons in the default slot; on the right, show/hide the search form
 * (`v-model:search`), refresh (`@refresh`) and, with the `QwTable`'s `columns`, the column settings of
 * `tableId`: drag to reorder, tick to show, reset to the code's columns; stored per user.
 * `:searchable="false"`: a list without a search form has no search toggle.
 */
const {
  tableId,
  columns = [],
  searchable = true,
} = defineProps<{ tableId: string; columns?: QwColumn[]; searchable?: boolean }>()
const search = defineModel<boolean>('search', { default: true })
const emit = defineEmits<{ refresh: [] }>()
const { t } = useI18n()

const prefs = columns.length ? useTablePrefs(tableId, () => columns) : null
const labels = computed(
  () => new Map(columns.map((c) => [c.prop, c.literal ? c.label : t(c.label)])),
)
const tree = computed(
  () =>
    prefs?.settings.value.map((s) => ({ prop: s.prop, label: labels.value.get(s.prop) ?? '' })) ??
    [],
)
const checked = computed(
  () => prefs?.settings.value.flatMap((s) => (s.visible ? [s.prop] : [])) ?? [],
)
// reorder only: a column never goes inside another
const allowDrop = (_from: unknown, _to: unknown, type: AllowDropType) => type !== 'inner'

function onCheck(_data: unknown, { checkedKeys }: CheckedInfo) {
  prefs?.save(
    prefs.settings.value.map((s) => ({ prop: s.prop, visible: checkedKeys.includes(s.prop) })),
  )
}

type Dropped = { data: TreeNodeData }
function onDrop(from: Dropped, to: Dropped, type: Exclude<NodeDropType, 'none'>) {
  if (!prefs) return
  const all = prefs.settings.value
  const moved = all.find((s) => s.prop === from.data.prop)
  if (!moved) return
  const rest = all.filter((s) => s !== moved)
  const at = rest.findIndex((s) => s.prop === to.data.prop) + (type === 'after' ? 1 : 0)
  rest.splice(at, 0, moved)
  prefs.save(rest)
}
</script>

<template>
  <div class="table-toolbar">
    <div class="table-toolbar__actions"><slot /></div>
    <div class="table-toolbar__tools">
      <IconButton
        v-if="searchable"
        icon="lucide:search"
        :label="t('crud.action.toggleSearch')"
        :aria-pressed="search"
        @click="search = !search"
      />
      <IconButton
        icon="lucide:refresh-cw"
        :label="t('crud.action.refresh')"
        @click="emit('refresh')"
      />
      <el-popover v-if="prefs" trigger="click" placement="bottom-end" :width="240">
        <template #reference>
          <IconButton icon="lucide:columns-3-cog" :label="t('crud.action.columns')" />
        </template>
        <div class="table-toolbar__columns-head">
          <span>{{ t('crud.action.columns') }}</span>
          <el-button link type="primary" @click="prefs.reset()">
            {{ t('crud.action.resetColumns') }}
          </el-button>
        </div>
        <el-tree
          :data="tree"
          node-key="prop"
          draggable
          show-checkbox
          :allow-drop="allowDrop"
          :default-checked-keys="checked"
          :aria-label="t('crud.action.columns')"
          @check="onCheck"
          @node-drop="onDrop"
        />
      </el-popover>
    </div>
  </div>
</template>

<style scoped>
/* the top row of a table card: actions left, tools right (§5) */
.table-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
}
.table-toolbar__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.table-toolbar__tools {
  display: flex;
  gap: 2px;
  margin-left: auto;
}
.table-toolbar__columns-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  margin-bottom: 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--qw-text);
  border-bottom: 1px solid var(--qw-border);
}
</style>
