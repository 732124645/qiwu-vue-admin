<template>
  <view class="qw-dict-select">
    <wd-cell
      :title="label"
      :value="text"
      :placeholder="placeholder || t('picker.select')"
      :required="required"
      is-link
      @click="visible = true"
    />
    <wd-select-picker
      v-model="value"
      v-model:visible="visible"
      :columns="options"
      :type="multiple ? 'checkbox' : 'radio'"
      :show-confirm="multiple"
      :title="label || t('picker.select')"
      root-portal
    />
  </view>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import type { DictPayload } from '@qiwu/shared'
import { t } from '@/core/i18n'
import { choiceText, dictChoices, loadDict } from '@/core/pickers'

/**
 * A dict's entries to pick from (the web's DictSelect): a cell with the label that opens wd-select-picker.
 * `v-model` = the entry's string code (`null` when none), with `multiple` the codes; single: a tap picks.
 * Labels in the current language (`labelI18n` → seeded key → code).
 * `<QwDictSelect v-model="form.leaveKind" code="biz.leave_kind" :label="t('field.biz.leave.leaveKind')" />`
 */
defineOptions({ options: { virtualHost: true } })
const model = defineModel<string | string[] | null>()
const props = withDefaults(
  defineProps<{
    code: string
    multiple?: boolean
    label?: string
    placeholder?: string
    required?: boolean
  }>(),
  { multiple: false, label: '', placeholder: '', required: false },
)

const dict = shallowRef<DictPayload>()
loadDict(props.code).then(
  (d) => (dict.value = d),
  () => {}, // shown by the request layer
)
const options = computed(() => dictChoices(dict.value))
const visible = ref(false)
const text = computed(() => choiceText(options.value, model.value))
// wd-select-picker wants '' / [] for none
const value = computed({
  get: () => model.value ?? (props.multiple ? [] : ''),
  set: (v: string | string[]) => (model.value = v === '' ? null : v),
})
</script>
