<template>
  <view class="qw-dept-picker">
    <wd-cell
      :title="label"
      :value="text"
      :placeholder="placeholder || t('picker.dept.placeholder')"
      :required="required"
      is-link
      @click="visible = true"
    />
    <wd-cascader
      v-model:visible="visible"
      :model-value="model ?? ''"
      :options="options"
      :title="label || t('picker.dept.title')"
      check-strictly
      root-portal
      @confirm="pick"
    />
  </view>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import type { DeptTreeNode } from '@qiwu/shared'
import { t, tx } from '@/core/i18n'
import { deptChoices, deptPath, loadDepts } from '@/core/pickers'

/**
 * Pick a dept (the web's DeptTreeSelect): a cell with the dept's name that opens wd-cascader over the
 * depts of `source` (`iam`: GET /api/iam/depts/tree, the caller's data scope; `wf`: every one, a process
 * form's), any level pickable (tap a dept to open its children, the confirm button takes the one tapped last;
 * tap it again to unpick: confirming nothing clears to `null`). `v-model` = the dept id.
 */
defineOptions({ options: { virtualHost: true } })
const model = defineModel<number | null>()
const props = withDefaults(
  defineProps<{ source?: 'iam' | 'wf'; label?: string; placeholder?: string; required?: boolean }>(),
  { source: 'iam', label: '', placeholder: '', required: false },
)

const tree = shallowRef<DeptTreeNode[]>([])
loadDepts(props.source).then(
  (d) => (tree.value = d),
  () => {}, // shown by the request layer; the picker stays empty
)
// tx() reads the locale: the names follow a switch
const options = computed(() => deptChoices(tree.value))
const visible = ref(false)
// a dept outside the caller's tree (another scope set it) shows its id, as on the web
const text = computed(() => {
  const id = model.value
  if (id == null) return ''
  const d = deptPath(tree.value, id).pop()
  return d ? tx(d.name) : String(id)
})

const pick = ({ value }: { value: number | '' }) => (model.value = value === '' ? null : value)
</script>
