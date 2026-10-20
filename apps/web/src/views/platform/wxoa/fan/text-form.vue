<script setup lang="ts">
import { reactive, ref, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormInstance } from 'element-plus'
import { fieldDomainOf, type ObjectSchema } from '@qiwu/shared'
import { toastRest } from '@/core/composables/use-crud'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'

/**
 * One text in a dialog (a fan's remark, a tag's name): `openDialog(WxoaTextForm, { schema, prop, value,
 * maxlength, save })`. Checked by the shared `schema` (its field `prop` labels the input), then
 * `save({ [prop]: text })`; `done` once saved, the caller says so.
 */
defineOptions({ name: 'WxoaTextForm' })
const {
  schema,
  prop,
  value = '',
  maxlength,
  save,
} = defineProps<{
  schema: ObjectSchema
  prop: string
  value?: string | null
  maxlength: number
  save: (body: Record<string, string>) => Promise<unknown>
}>()
const emit = defineEmits<{ done: [saved: true]; cancel: [] }>()
const i18n = useI18n()
const { t } = i18n

const model = reactive<Record<string, string>>({ [prop]: value ?? '' })
const formRef = ref<FormInstance>()
// a schema passed in a reactive props object arrives proxied; zod reads its own frozen internals
const rules = zodRules(toRaw(schema), i18n, model)
revalidateOnLocale(formRef)
const label = `field.${fieldDomainOf(toRaw(schema))}.${prop}`

const submitting = ref(false)
async function submit() {
  if (submitting.value) return
  if (!(await formRef.value?.validate().catch(() => false))) return
  submitting.value = true
  try {
    await save({ ...model })
    emit('done', true)
  } catch (e) {
    toastRest(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-form ref="formRef" :model="model" :rules="rules" @submit.prevent="submit">
    <el-form-item :label="t(label)" :prop="prop">
      <el-input v-model="model[prop]" :maxlength="maxlength" show-word-limit />
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" @click="submit">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>
