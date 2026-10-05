<script setup lang="ts" generic="N extends { id: number; children: N[] }">
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * The parent field of a tree form (`tree` template, docs/codegen-golden.md "Tree page"; see docs/design-notes.md#codegen): the
 * nodes `load` returns once mounted (the page's enabled rows as a forest), minus `exclude` and its whole
 * subtree (a row never goes below itself); typing filters. `v-model` = the parent id with 0 = top level,
 * shown as the empty select (placeholder `crud.tree.topLevel`); clearing it picks the top level again.
 */
defineOptions({ name: 'TreeParentSelect' })
const model = defineModel<number | undefined>({ required: true })
const { load, label, exclude, disabled } = defineProps<{
  load: () => Promise<N[]>
  /** a node's text */
  label: (node: N) => string
  /** a row being edited: left out with its subtree */
  exclude?: number
  /** nodes shown but not pickable (a parent that cannot hold the row) */
  disabled?: (node: N) => boolean
}>()
const { t } = useI18n()

const nodes = shallowRef<N[]>([])
const loading = ref(true)
load()
  .then((d) => (nodes.value = d))
  .catch(() => undefined) // the request layer showed it; the select stays empty
  .finally(() => (loading.value = false))

interface Option {
  value: number
  label: string
  disabled: boolean
  children: Option[]
}
const toOptions = (list: N[]): Option[] =>
  list
    .filter((n) => n.id !== exclude)
    .map((n) => ({
      value: n.id,
      label: label(n),
      disabled: disabled?.(n) ?? false,
      children: toOptions(n.children),
    }))
// label() may read the locale (seeded names): the options follow it
const options = computed(() => toOptions(nodes.value))
const value = computed({
  get: () => model.value || null,
  // a cleared select (null, undefined or an empty value) is the top level
  set: (v: number | null | undefined) => (model.value = v || 0),
})
</script>

<template>
  <el-tree-select
    v-model="value"
    :data="options"
    :loading
    check-strictly
    filterable
    clearable
    default-expand-all
    :render-after-expand="false"
    :placeholder="t('crud.tree.topLevel')"
  />
</template>
