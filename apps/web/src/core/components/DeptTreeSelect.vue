<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DeptTreeNode } from '@qiwu/shared'
import { deptApi } from '@/api/platform/iam/dept'
import { wfCenterApi } from '@/api/workflow/center'
import { tx } from '@/core/i18n'

/**
 * Department select (see docs/design-notes.md#layering) over GET /api/iam/depts/tree (the caller's data scope), or with `source:
 * 'wf'` (process forms) every enabled department (GET /api/wf/depts/options), loaded when it mounts:
 * any node can be picked, typing filters, `v-model` = the dept id and `null` once cleared (a nullable `dept_id`); with `multiple`
 * the ids, `[]` once cleared. Seeded names follow the language. `exclude` leaves out a dept and its whole
 * subtree (a dept's own parent picker). Other attributes (`disabled`, `id`, `placeholder`, …) go to the
 * el-tree-select.
 */
defineOptions({ name: 'DeptTreeSelect' })
const model = defineModel<number | number[] | null | undefined>()
const { exclude, source = 'iam' } = defineProps<{ exclude?: number; source?: 'iam' | 'wf' }>()
const { t } = useI18n()

const tree = shallowRef<DeptTreeNode[]>([])
const loading = ref(true)
const load = source === 'wf' ? wfCenterApi.deptOptions : deptApi.tree
load()
  .then((d) => (tree.value = d))
  .catch(() => undefined) // the request layer showed it; the select stays empty
  .finally(() => (loading.value = false))

interface Option {
  value: number
  label: string
  children: Option[]
}
const toOptions = (nodes: DeptTreeNode[]): Option[] =>
  nodes
    .filter((n) => n.id !== exclude)
    .map((n) => ({ value: n.id, label: tx(n.name), children: toOptions(n.children) }))
// tx() reads the locale: the labels change with it
const options = computed(() => toOptions(tree.value))
const clearToNull = () => null
</script>

<template>
  <el-tree-select
    v-model="model"
    :data="options"
    :loading
    check-strictly
    filterable
    clearable
    default-expand-all
    :render-after-expand="false"
    :value-on-clear="clearToNull"
    :placeholder="t('picker.dept.placeholder')"
  />
</template>
