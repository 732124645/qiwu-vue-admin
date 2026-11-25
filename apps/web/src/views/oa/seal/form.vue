<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { sealCreate, type SealCreate, type SealVo } from '@qiwu/shared'
import { sealApi } from '@/api/oa/seal'
import DictSelect from '@/core/components/DictSelect.vue'
import { useCrudForm } from '@/core/composables/use-crud'
import OaInitiatorPicks from '../components/OaInitiatorPicks.vue'
import OaAttachments from '../components/OaAttachments.vue'

defineOptions({ name: 'OaSealForm' })
const { id } = defineProps<{ id?: number }>()
const emit = defineEmits<{ done: [value: { id: number }]; cancel: [] }>()
const { t } = useI18n()
const picks = ref<InstanceType<typeof OaInitiatorPicks>>()
const startReady = ref(false)
const attachmentBusy = ref(false)
const {
  model,
  formRef,
  rules,
  loading,
  submitting,
  submit: save,
} = useCrudForm<SealVo, SealCreate>({
  api: sealApi,
  schema: sealCreate,
  id,
  emit,
  emptyModel: () => ({
    sealKind: '',
    documentName: '',
    purpose: '',
    copies: 1,
    expectedDate: '',
    attachmentIds: [],
    initiatorPicks: {},
  }),
})
/** 选人和业务表单必须同时有效，避免缺人时发起半张申请。 */
async function submit() {
  if (attachmentBusy.value || submitting.value) return
  if (!id && !picks.value?.validate()) return
  await save()
}
defineExpose({ model })
</script>
<template>
  <el-form ref="formRef" v-loading="loading" :model="model" :rules="rules" label-position="left">
    <el-form-item :label="t('field.oa.seal.sealKind')" prop="sealKind"
      ><DictSelect v-model="model.sealKind" code="oa.seal_kind"
    /></el-form-item>
    <el-form-item :label="t('field.oa.seal.documentName')" prop="documentName"
      ><el-input v-model="model.documentName" maxlength="200"
    /></el-form-item>
    <el-form-item :label="t('field.oa.seal.purpose')" prop="purpose"
      ><el-input v-model="model.purpose" type="textarea" :rows="3" maxlength="500"
    /></el-form-item>
    <el-form-item :label="t('field.oa.seal.copies')" prop="copies"
      ><el-input-number v-model="model.copies" :min="1" :max="9999" :precision="0"
    /></el-form-item>
    <el-form-item :label="t('field.oa.seal.expectedDate')" prop="expectedDate"
      ><el-date-picker v-model="model.expectedDate" type="date" value-format="YYYY-MM-DD"
    /></el-form-item>
    <el-form-item :label="t('field.oa.seal.attachmentIds')" prop="attachmentIds">
      <OaAttachments
        v-model="model.attachmentIds"
        :disabled="submitting"
        @busy="attachmentBusy = $event"
      />
    </el-form-item>
    <OaInitiatorPicks
      v-if="!id"
      ref="picks"
      v-model="model.initiatorPicks"
      model-key="oa-seal"
      @ready="startReady = $event"
    />
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button
    ><el-button
      type="primary"
      :loading="submitting"
      :disabled="submitting || loading || attachmentBusy || (!id && !startReady)"
      @click="submit"
      >{{ t(id ? 'crud.action.save' : 'oa.create') }}</el-button
    >
  </div>
</template>
