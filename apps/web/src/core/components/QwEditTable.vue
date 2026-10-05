<script setup lang="ts" generic="T extends object">
import { useI18n } from 'vue-i18n'
import { Icon } from '@/core/icons'

/**
 * An editable sub table (the `master_sub` form, docs/codegen-golden.md "Master-sub"): one row
 * per item of `v-model` (the form model's array, edited in place), each cell the page's
 * `#cell-<prop>="{ row, index }"` editor (an el-form-item with its own `prop` path and rules, so the
 * surrounding form validates every cell on save), a delete button per row and an add button below that
 * appends `create()`. `label` (an i18n key) titles the section, which spans the whole dialog form;
 * `required` columns get the asterisk in their header.
 */
defineOptions({ name: 'QwEditTable' })
const rows = defineModel<T[]>({ required: true })
const { label, columns, create } = defineProps<{
  label: string
  columns: {
    prop: string
    /** i18n key */
    label: string
    width?: number
    minWidth?: number
    align?: 'left' | 'right'
    required?: boolean
  }[]
  /** a new row: the add form's empty values */
  create: () => T
}>()
defineSlots<{ [slot: `cell-${string}`]: (scope: { row: T; index: number }) => unknown }>()
const { t } = useI18n()
</script>

<template>
  <section class="qw-edit-table">
    <div class="qw-edit-table__head">
      <span>{{ t(label) }}</span>
      <span class="qw-edit-table__count">{{ rows.length }}</span>
    </div>
    <el-table :data="rows" class="qw-edit-table__table">
      <el-table-column type="index" label="#" width="56" />
      <el-table-column
        v-for="c in columns"
        :key="c.prop"
        :width="c.width"
        :min-width="c.minWidth"
        :align="c.align"
      >
        <template #header>
          <span v-if="c.required" class="qw-edit-table__required" aria-hidden="true">*</span>
          {{ t(c.label) }}
        </template>
        <!-- el-table-column also renders its slot once with $index -1 (to look for nested columns):
             a form item made there would join the form and fail its check unseen -->
        <template #default="{ row, $index }">
          <slot v-if="$index >= 0" :name="`cell-${c.prop}`" :row="row" :index="$index" />
        </template>
      </el-table-column>
      <el-table-column :label="t('crud.action.operations')" width="80" fixed="right">
        <template #default="{ $index }">
          <el-button link type="danger" @click="rows.splice($index, 1)">
            {{ t('crud.action.delete') }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <span class="qw-edit-table__empty">{{ t('crud.editTable.empty') }}</span>
      </template>
    </el-table>
    <el-button class="qw-edit-table__add" @click="rows.push(create())">
      <el-icon class="el-icon--left"><Icon icon="lucide:plus" /></el-icon>
      {{ t('crud.action.addRow') }}
    </el-button>
  </section>
</template>

<style scoped>
/* in a dialog form's label grid (styles/element.css) the section takes the whole width */
.qw-edit-table {
  grid-column: 1 / -1;
  margin-bottom: 18px;
}
.qw-edit-table__head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-bottom: 8px;
  font-weight: 600;
  color: var(--qw-text);
}
.qw-edit-table__count {
  font-size: 12px;
  font-weight: 400;
  color: var(--qw-text-3);
}
.qw-edit-table__required {
  margin-right: 4px;
  color: var(--qw-danger);
}
.qw-edit-table__empty {
  color: var(--qw-text-3);
}
.qw-edit-table__add {
  width: 100%;
  margin-top: 8px;
  border-style: dashed;
}
</style>
