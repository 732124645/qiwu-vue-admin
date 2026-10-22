<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { attendancePolicyPerms, type AttendancePolicyVo } from '@qiwu/shared'
import { attendancePolicyApi } from '@/api/oa/attendance'
import { ApiError } from '@/core/request/http'
import { toastRest } from '@/core/composables/use-crud'
import { openDialog } from '@/core/dialog'
import { usePerm } from '@/core/permission'
import { useAuthStore } from '@/core/stores/auth'
import PolicyForm from './PolicyForm.vue'

defineOptions({ name: 'OaAttendancePolicy' })
const { t } = useI18n()
const auth = useAuthStore()
const perm = usePerm()
const available = computed(
  () => !!auth.me && (auth.me.features === undefined || auth.me.features.includes('oa')),
)
const canRead = computed(() => available.value && perm.has(attendancePolicyPerms.view))
const canEdit = computed(() => canRead.value && perm.has(attendancePolicyPerms.modify))
const policy = shallowRef<AttendancePolicyVo | null>(null)
const loading = ref(false)
const opening = ref(false)
const error = ref('')
let sequence = 0
async function load() {
  const mine = ++sequence
  policy.value = null
  error.value = ''
  if (!canRead.value) {
    loading.value = false
    return
  }
  loading.value = true
  try {
    const row = await attendancePolicyApi.get()
    if (mine === sequence) policy.value = row
  } catch (e) {
    if (mine === sequence) {
      error.value = e instanceof ApiError ? e.message : t('oa.attendance.loadFailed')
      toastRest(e)
    }
  } finally {
    if (mine === sequence) loading.value = false
  }
}
async function edit() {
  if (!canEdit.value || opening.value || loading.value) return
  opening.value = true
  try {
    if (await openDialog(PolicyForm, {}, { title: () => t('oa.attendance.editPolicy') }))
      await load()
  } finally {
    opening.value = false
  }
}
watch(
  () => auth.me,
  () => void load(),
  { immediate: true, deep: true },
)
onBeforeUnmount(() => {
  sequence++
})
</script>

<template>
  <div class="qw-page">
    <el-alert
      v-if="!canRead"
      :title="t(available ? 'oa.attendance.notAllowed' : 'oa.attendance.unavailable')"
      type="warning"
      :closable="false"
    />
    <el-card v-else v-loading="loading">
      <template #header
        ><div class="policy-heading">
          <span>{{ t('oa.attendance.policy') }}</span>
          <div>
            <el-button :disabled="loading || opening" @click="load">{{
              t('crud.action.refresh')
            }}</el-button
            ><el-button
              v-if="canEdit"
              type="primary"
              :disabled="loading || opening || !policy"
              @click="edit"
              >{{ t('crud.action.edit') }}</el-button
            >
          </div>
        </div></template
      >
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-descriptions v-else-if="policy" :column="1" border>
        <el-descriptions-item :label="t('field.oa.attendancePolicy.enabled')">{{
          t(policy.enabled ? 'oa.attendance.enabled' : 'oa.attendance.disabled')
        }}</el-descriptions-item>
        <el-descriptions-item :label="t('field.oa.attendancePolicy.timezone')">{{
          policy.timezone
        }}</el-descriptions-item>
        <el-descriptions-item :label="t('field.oa.attendancePolicy.locationMode')">{{
          t(`oa.attendance.location.${policy.locationMode}`)
        }}</el-descriptions-item>
        <el-descriptions-item :label="t('field.oa.attendancePolicy.retentionDays')">{{
          policy.retentionDays
        }}</el-descriptions-item>
      </el-descriptions>
      <p class="attendance-hint">{{ t('oa.attendance.retentionHint') }}</p>
    </el-card>
  </div>
</template>
<style scoped>
.policy-heading {
  display: flex;
  gap: 12px;
  justify-content: space-between;
  align-items: center;
}
.attendance-hint {
  color: var(--qw-text-3);
}
</style>
