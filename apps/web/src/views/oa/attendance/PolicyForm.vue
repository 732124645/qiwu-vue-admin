<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { attendancePolicyCreate, attendancePolicyPerms } from '@qiwu/shared'
import { attendancePolicyApi } from '@/api/oa/attendance'
import { useCrudForm } from '@/core/composables/use-crud'
import { usePerm } from '@/core/permission'
import { useAuthStore } from '@/core/stores/auth'

defineOptions({ name: 'OaAttendancePolicyForm' })
const emit = defineEmits<{ done: [saved: { id: number }]; cancel: [] }>()
const { t } = useI18n()
const auth = useAuthStore()
const perm = usePerm()
const available = computed(
  () => !!auth.me && (auth.me.features === undefined || auth.me.features.includes('oa')),
)
const canRead = computed(() => available.value && perm.has(attendancePolicyPerms.view))
const canWrite = computed(() => canRead.value && perm.has(attendancePolicyPerms.modify))
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
// 单例规则用固定表单标识适配 CRUD kit；后端始终由 current 接口确定当前租户规则。
const { model, formRef, rules, loading, submitting, submit } = useCrudForm({
  api: {
    get: attendancePolicyApi.get,
    create: (body) => {
      assertWritable()
      return attendancePolicyApi.update(body)
    },
    update: (_id, body) => {
      assertWritable()
      return attendancePolicyApi.update(body)
    },
  },
  schema: attendancePolicyCreate,
  emptyModel: () => ({
    enabled: true,
    timezone: 'Asia/Shanghai',
    locationMode: 'none' as 'none' | 'site',
    retentionDays: 180,
  }),
  id: canRead.value ? 1 : undefined,
  emit,
})
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
    <el-form-item :label="t('field.oa.attendancePolicy.enabled')" prop="enabled"
      ><el-switch v-model="model.enabled" :aria-label="t('field.oa.attendancePolicy.enabled')"
    /></el-form-item>
    <el-form-item :label="t('field.oa.attendancePolicy.timezone')" prop="timezone"
      ><el-input
        v-model="model.timezone"
        :aria-label="t('field.oa.attendancePolicy.timezone')"
        maxlength="64"
        placeholder="Asia/Shanghai"
    /></el-form-item>
    <el-form-item :label="t('field.oa.attendancePolicy.locationMode')" prop="locationMode"
      ><el-select
        v-model="model.locationMode"
        :aria-label="t('field.oa.attendancePolicy.locationMode')"
        ><el-option value="none" :label="t('oa.attendance.location.none')" /><el-option
          value="site"
          :label="t('oa.attendance.location.site')" /></el-select
    ></el-form-item>
    <el-form-item :label="t('field.oa.attendancePolicy.retentionDays')" prop="retentionDays"
      ><el-input-number
        v-model="model.retentionDays"
        :aria-label="t('field.oa.attendancePolicy.retentionDays')"
        :min="30"
        :max="730"
        :precision="0"
    /></el-form-item>
    <el-text type="info">{{ t('oa.attendance.retentionHint') }}</el-text>
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
