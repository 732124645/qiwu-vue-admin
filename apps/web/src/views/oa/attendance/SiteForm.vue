<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { attendanceSiteCreate, attendanceSitePerms } from '@qiwu/shared'
import { attendanceSiteApi } from '@/api/oa/attendance'
import { useCrudForm } from '@/core/composables/use-crud'
import { usePerm } from '@/core/permission'
import { useAuthStore } from '@/core/stores/auth'

defineOptions({ name: 'OaAttendanceSiteForm' })
const { id, readonly = false } = defineProps<{ id?: number; readonly?: boolean }>()
const emit = defineEmits<{ done: [saved: { id: number }]; cancel: [] }>()
const { t } = useI18n()
const auth = useAuthStore()
const perm = usePerm()
const available = computed(
  () => !!auth.me && (auth.me.features === undefined || auth.me.features.includes('oa')),
)
const canRead = computed(
  () =>
    available.value &&
    (id == null ? perm.has(attendanceSitePerms.create) : perm.has(attendanceSitePerms.view)),
)
const canWrite = computed(
  () =>
    canRead.value &&
    !readonly &&
    perm.has(id == null ? attendanceSitePerms.create : attendanceSitePerms.modify),
)
let formEpoch = 0
let saveEpoch = -1
let closed = false
/** 旧表单不可跨账号、权限变化或关闭继续写入，即使异步校验之后新身份仍有相同权限。 */
function invalidate() {
  closed = true
  formEpoch++
}
function cancel() {
  invalidate()
  emit('cancel')
}
function assertWritable() {
  if (closed || saveEpoch !== formEpoch || !canWrite.value)
    throw new Error(t('oa.attendance.notAllowed'))
}
onBeforeUnmount(invalidate)
const { model, formRef, rules, loading, submitting, submit } = useCrudForm({
  api: {
    get: attendanceSiteApi.get,
    create: (body) => {
      assertWritable()
      return attendanceSiteApi.create(body)
    },
    update: (rowId, body) => {
      assertWritable()
      return attendanceSiteApi.update(rowId, body)
    },
  },
  schema: attendanceSiteCreate,
  emptyModel: () => ({
    name: '',
    latitude: '',
    longitude: '',
    radiusM: 100,
    maxAccuracyM: 50,
    enabled: true,
  }),
  id: canRead.value ? id : undefined,
  emit,
})
// 权限或账号切换后关闭旧表单，迟到的 GET 结果不能作为新身份的可写内容。
watch(() => auth.me, cancel, { deep: true, flush: 'sync' })
const validating = ref(false)
const saving = computed(() => validating.value || submitting.value)
/** 校验开始即占用提交按钮，两个同帧点击不能在异步校验结束后各发一次写请求。 */
async function save() {
  if (closed || !canWrite.value || loading.value || saving.value) return
  saveEpoch = formEpoch
  validating.value = true
  try {
    await submit()
  } finally {
    validating.value = false
  }
}
</script>

<template>
  <el-alert
    v-if="!canRead"
    :title="t('oa.attendance.notAllowed')"
    type="warning"
    :closable="false"
  />
  <el-form
    v-else
    ref="formRef"
    v-loading="loading"
    :model="model"
    :rules="rules"
    :disabled="loading || saving || !canWrite"
    label-position="top"
  >
    <el-form-item :label="t('field.oa.attendanceSite.name')" prop="name"
      ><el-input
        v-model="model.name"
        :aria-label="t('field.oa.attendanceSite.name')"
        maxlength="100"
    /></el-form-item>
    <el-form-item :label="t('field.oa.attendanceSite.latitude')" prop="latitude"
      ><el-input
        v-model="model.latitude"
        :aria-label="t('field.oa.attendanceSite.latitude')"
        maxlength="16"
    /></el-form-item>
    <el-form-item :label="t('field.oa.attendanceSite.longitude')" prop="longitude"
      ><el-input
        v-model="model.longitude"
        :aria-label="t('field.oa.attendanceSite.longitude')"
        maxlength="16"
    /></el-form-item>
    <el-form-item :label="t('field.oa.attendanceSite.radiusM')" prop="radiusM"
      ><el-input-number
        v-model="model.radiusM"
        :aria-label="t('field.oa.attendanceSite.radiusM')"
        :min="50"
        :max="10000"
        :precision="0"
    /></el-form-item>
    <el-form-item :label="t('field.oa.attendanceSite.maxAccuracyM')" prop="maxAccuracyM"
      ><el-input-number
        v-model="model.maxAccuracyM"
        :aria-label="t('field.oa.attendanceSite.maxAccuracyM')"
        :min="5"
        :max="1000"
        :precision="0"
    /></el-form-item>
    <el-form-item :label="t('field.oa.attendanceSite.enabled')" prop="enabled"
      ><el-switch v-model="model.enabled" :aria-label="t('field.oa.attendanceSite.enabled')"
    /></el-form-item>
    <el-text type="info">{{ t('oa.attendance.coordinateHint') }}</el-text>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button :disabled="loading || saving" @click="cancel">{{
      t('common.action.cancel')
    }}</el-button
    ><el-button
      v-if="canWrite"
      type="primary"
      :loading="saving"
      :disabled="loading || saving"
      @click="save"
      >{{ t('crud.action.save') }}</el-button
    >
  </div>
</template>
