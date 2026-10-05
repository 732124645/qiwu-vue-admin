<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, type FormInstance, type FormItemRule } from 'element-plus'
import { DEFAULT_PASSWORD_POLICY, userResetPasswordBody } from '@qiwu/shared'
import { userApi } from '@/api/platform/iam/user'
import PasswordToggle from '@/core/components/PasswordToggle.vue'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'
import { useAuthStore } from '@/core/stores/auth'

/**
 * Reset a user's password, a dialog content component opened from the list's row menu: the server's
 * schema under the /me password policy, typed twice. The user's sessions end and the new password must be
 * changed at the next sign-in. Resolves `true` once reset.
 */
defineOptions({ name: 'IamUserResetPassword' })
const { id } = defineProps<{ id: number }>()
const emit = defineEmits<{ done: [reset: true]; cancel: [] }>()
const i18n = useI18n()
const { t } = i18n

const model = reactive({ password: '', confirmPassword: '' })
const policy = useAuthStore().me?.policy ?? DEFAULT_PASSWORD_POLICY
const rules: Record<string, FormItemRule[]> = {
  ...zodRules(userResetPasswordBody(policy), i18n, model),
  confirmPassword: [
    {
      trigger: 'blur',
      validator: (_rule, value, callback) =>
        callback(
          value === model.password ? undefined : new Error(t('common.passwordChange.mismatch')),
        ),
    },
  ],
}
const formRef = ref<FormInstance>()
revalidateOnLocale(formRef)
const submitting = ref(false)

async function submit() {
  if (submitting.value || !(await formRef.value?.validate().catch(() => false))) return
  submitting.value = true
  try {
    await userApi.resetPassword(id, { password: model.password })
    ElMessage.success(t('iam.user.resetPassword.done'))
    emit('done', true)
  } catch {
    // the request layer toasted 403/404/422/429; the dialog stays for another try
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-alert
    :title="t('iam.user.resetPassword.hint')"
    type="warning"
    show-icon
    :closable="false"
    class="reset-password__hint"
  />
  <el-form
    ref="formRef"
    :model="model"
    :rules="rules"
    label-position="left"
    hide-required-asterisk
    @submit.prevent="submit"
  >
    <el-form-item :label="t('common.passwordChange.newPassword')" prop="password">
      <el-input v-model="model.password" type="password" autocomplete="new-password" show-password>
        <template #password-icon="{ visible }"><PasswordToggle :visible /></template>
      </el-input>
    </el-form-item>
    <el-form-item :label="t('common.passwordChange.confirmPassword')" prop="confirmPassword">
      <el-input
        v-model="model.confirmPassword"
        type="password"
        autocomplete="new-password"
        show-password
      >
        <template #password-icon="{ visible }"><PasswordToggle :visible /></template>
      </el-input>
    </el-form-item>
  </el-form>
  <div class="qw-dialog-footer">
    <el-button @click="emit('cancel')">{{ t('common.action.cancel') }}</el-button>
    <el-button type="primary" :loading="submitting" @click="submit">
      {{ t('menu.action.resetPassword') }}
    </el-button>
  </div>
</template>

<style scoped>
.reset-password__hint {
  margin-bottom: 20px;
}
</style>
