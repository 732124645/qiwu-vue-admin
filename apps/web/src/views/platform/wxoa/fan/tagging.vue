<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormInstance } from 'element-plus'
import { WXOA_TAG_OPS, wxoaFanTaggingBody, type WxoaTagVo } from '@qiwu/shared'
import { wxoaFanApi } from '@/api/platform/wxoa/fan'
import { toastRest } from '@/core/composables/use-crud'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'

/**
 * Adds a tag to the chosen fans or takes it off them, `openDialog(WxoaFanTagging, { accountId, fanIds,
 * tags })`; `done` once WeChat took it.
 */
defineOptions({ name: 'WxoaFanTagging' })
const { accountId, fanIds, tags } = defineProps<{
  accountId: number
  fanIds: number[]
  tags: WxoaTagVo[]
}>()
const emit = defineEmits<{ done: [saved: true]; cancel: [] }>()
const i18n = useI18n()
const { t } = i18n

const model = reactive({
  accountId,
  fanIds,
  tagId: null as number | null,
  op: 'add' as (typeof WXOA_TAG_OPS)[number],
})
const formRef = ref<FormInstance>()
const rules = zodRules(wxoaFanTaggingBody, i18n, model)
revalidateOnLocale(formRef)

const submitting = ref(false)
async function submit() {
  if (submitting.value) return
  if (!(await formRef.value?.validate().catch(() => false))) return
  submitting.value = true
  try {
    await wxoaFanApi.tagging({ ...model, tagId: model.tagId! })
    emit('done', true)
  } catch (e) {
    toastRest(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-form ref="formRef" :model="model" :rules="rules" label-position="left">
    <el-form-item :label="t('field.wxoa.fan.fanIds')">
      {{ t('wxoa.fan.tagging.count', { count: fanIds.length }) }}
    </el-form-item>
    <el-form-item :label="t('field.wxoa.fan.tagId')" prop="tagId">
      <el-select v-model="model.tagId" filterable>
        <el-option v-for="tag in tags" :key="tag.id" :value="tag.tagId" :label="tag.name" />
      </el-select>
    </el-form-item>
    <el-form-item :label="t('field.wxoa.fan.op')" prop="op">
      <el-radio-group v-model="model.op">
        <el-radio v-for="op in WXOA_TAG_OPS" :key="op" :value="op">
          {{ t(`wxoa.fan.tagging.${op}`) }}
        </el-radio>
      </el-radio-group>
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" @click="submit">
      {{ t('crud.action.save') }}
    </el-button>
  </div>
</template>
