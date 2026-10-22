<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { tripCreate, type TripCreate, type TripVo } from '@qiwu/shared'
import { tripApi } from '@/api/oa/trip'
import { useCrudForm } from '@/core/composables/use-crud'
import OaInitiatorPicks from '../components/OaInitiatorPicks.vue'
import OaAttachments from '../components/OaAttachments.vue'

defineOptions({ name: 'OaTripForm' })
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
} = useCrudForm<TripVo, TripCreate>({
  api: tripApi,
  schema: tripCreate,
  id,
  emit,
  emptyModel: () => ({
    destination: '',
    startAt: null,
    endAt: null,
    reason: '',
    estimatedAmount: null,
    attachmentIds: [],
    initiatorPicks: {},
  }),
})
/** 先确认当前流程要求的选人，再由统一表单校验并提交业务内容。 */
async function submit() {
  if (attachmentBusy.value || submitting.value) return
  if (!id && !picks.value?.validate()) return
  await save()
}
defineExpose({ model })
</script>
<template>
  <el-form ref="formRef" v-loading="loading" :model="model" :rules="rules" label-position="left">
    <el-form-item :label="t('field.oa.trip.destination')" prop="destination"
      ><el-input v-model="model.destination" maxlength="200"
    /></el-form-item>
    <el-form-item
      v-for="field in ['startAt', 'endAt'] as const"
      :key="field"
      :label="t(`field.oa.trip.${field}`)"
      :prop="field"
      ><el-date-picker
        v-model="model[field]"
        type="datetime"
        value-format="YYYY-MM-DD[T]HH:mm:ss.SSSZ"
    /></el-form-item>
    <el-form-item :label="t('field.oa.trip.estimatedAmount')" prop="estimatedAmount"
      ><el-input
        v-model="model.estimatedAmount"
        inputmode="decimal"
        @input="model.estimatedAmount = $event === '' ? null : $event"
        clearable
        @clear="model.estimatedAmount = null"
    /></el-form-item>
    <el-form-item :label="t('field.oa.trip.reason')" prop="reason"
      ><el-input v-model="model.reason" type="textarea" :rows="3" maxlength="500"
    /></el-form-item>
    <el-form-item :label="t('field.oa.trip.attachmentIds')" prop="attachmentIds">
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
      model-key="oa-trip"
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
