<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ElMessage, type FormInstance, type FormItemRule } from 'element-plus'
import { changePasswordBody, DEFAULT_PASSWORD_POLICY, type ChangePasswordBody } from '@qiwu/shared'
import PasswordToggle from '@/core/components/PasswordToggle.vue'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'
import { api, ApiError } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'

/**
 * Change the own password (PUT /api/iam/profile/password): old, new and confirm under the server's
 * policy from /me. On success the server has cleared this session's flags and signed out the other
 * sessions; the form reloads /me, says so, clears itself and emits `done`. Used by the forced change page
 * (`large`: full-width submit, large inputs) and the personal center. The default slot goes under the button.
 */
defineOptions({ name: 'PasswordChangeForm' })
const { large = false } = defineProps<{ large?: boolean }>()
const emit = defineEmits<{ done: [] }>()
defineSlots<{ default?: () => unknown }>()
const i18n = useI18n()
const { t } = i18n
const auth = useAuthStore()
const router = useRouter()

const policy = auth.me?.policy ?? DEFAULT_PASSWORD_POLICY
const form = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' })
const rules: Record<string, FormItemRule[]> = {
  // the server's own schema and policy (from /me); whole-model, so "new ≠ old" shows on newPassword
  ...zodRules(changePasswordBody(policy), i18n, form),
  confirmPassword: [
    {
      trigger: 'blur',
      validator: (_rule, value, callback) =>
        callback(
          value === form.newPassword ? undefined : new Error(t('common.passwordChange.mismatch')),
        ),
    },
  ],
}
const formRef = ref<FormInstance>()
revalidateOnLocale(formRef)
const loading = ref(false)
const error = ref('')

async function submit() {
  if (loading.value || !(await formRef.value?.validate().catch(() => false))) return
  loading.value = true
  error.value = ''
  try {
    const body: ChangePasswordBody = {
      oldPassword: form.oldPassword,
      newPassword: form.newPassword,
    }
    await api.put('/iam/profile/password', body, { silent: true })
    await auth.fetchMe()
    ElMessage.success(t('common.passwordChange.done'))
    formRef.value?.resetFields()
    emit('done')
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      auth.clear()
      await router.replace('/login')
    } else error.value = e instanceof ApiError ? e.message : t('common.error.network')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-form
    ref="formRef"
    :model="form"
    :rules="rules"
    label-position="top"
    :size="large ? 'large' : undefined"
    hide-required-asterisk
    @submit.prevent="submit"
  >
    <el-form-item :label="t('common.passwordChange.oldPassword')" prop="oldPassword">
      <el-input
        v-model="form.oldPassword"
        type="password"
        autocomplete="current-password"
        show-password
      >
        <template #password-icon="{ visible }"><PasswordToggle :visible /></template>
      </el-input>
    </el-form-item>
    <el-form-item :label="t('common.passwordChange.newPassword')" prop="newPassword">
      <el-input
        v-model="form.newPassword"
        type="password"
        autocomplete="new-password"
        show-password
      >
        <template #password-icon="{ visible }"><PasswordToggle :visible /></template>
      </el-input>
    </el-form-item>
    <el-form-item :label="t('common.passwordChange.confirmPassword')" prop="confirmPassword">
      <el-input
        v-model="form.confirmPassword"
        type="password"
        autocomplete="new-password"
        show-password
      >
        <template #password-icon="{ visible }"><PasswordToggle :visible /></template>
      </el-input>
    </el-form-item>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      show-icon
      :closable="false"
      class="password-form__error"
    />
    <el-button
      type="primary"
      native-type="submit"
      :loading="loading"
      :class="{ 'password-form__block': large }"
    >
      {{ t('common.passwordChange.submit') }}
    </el-button>
    <slot />
  </el-form>
</template>

<style scoped>
.password-form__error {
  margin-bottom: 16px;
}
.password-form__block {
  width: 100%;
}
</style>
