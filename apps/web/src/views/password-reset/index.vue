<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormItemRule } from 'element-plus'
import { DEFAULT_PASSWORD_POLICY, smsResetPasswordBody, type PasswordPolicy } from '@qiwu/shared'
import { authExtraApi, publicPasswordPolicy } from '@/api/auth-extra'
import PasswordToggle from '@/core/components/PasswordToggle.vue'
import { useSmsCode } from '@/core/composables/use-sms-code'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'
import AuthPage from '@/core/layout/AuthPage.vue'
import { ApiError } from '@/core/request/http'

/**
 * Forgot password by SMS (see docs/design-notes.md#auth-sessions), a public page: mobile → code (through the `sms_send`
 * captcha) → new password. The server signs out every session of the account; then sign in again.
 */
defineOptions({ name: 'PasswordResetView' })
const i18n = useI18n()
const { t } = i18n
const router = useRouter()
const form = reactive({ mobile: '', code: '', newPassword: '', confirmPassword: '' })
const policy = ref<PasswordPolicy>(DEFAULT_PASSWORD_POLICY)
onMounted(async () => {
  policy.value = await publicPasswordPolicy()
})
const rules = computed<Record<string, FormItemRule[]>>(() => ({
  ...zodRules(smsResetPasswordBody(policy.value), i18n),
  confirmPassword: [
    {
      trigger: 'blur',
      validator: (_rule, value, callback) =>
        callback(
          value === form.newPassword ? undefined : new Error(t('common.passwordChange.mismatch')),
        ),
    },
  ],
}))
const formRef = ref<FormInstance>()
revalidateOnLocale(formRef)
const { cooldown, sending, send } = useSmsCode('reset_password')
const checkingMobile = ref(false)
const sent = ref(false)
const loading = ref(false)
const error = ref('')

async function sendCode() {
  if (checkingMobile.value || sending.value || cooldown.value) return
  checkingMobile.value = true
  try {
    if (!(await formRef.value?.validateField('mobile').catch(() => false))) return
    error.value = ''
    sent.value = (await send(form.mobile.trim())) || sent.value
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('common.error.network')
  } finally {
    checkingMobile.value = false
  }
}

async function submit() {
  if (loading.value) return
  loading.value = true
  try {
    if (!(await formRef.value?.validate().catch(() => false))) return
    error.value = ''
    await authExtraApi.resetBySms({
      mobile: form.mobile.trim(),
      code: form.code,
      newPassword: form.newPassword,
    })
    ElMessage.success(t('auth.reset.done'))
    await router.replace('/login')
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('common.error.network')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <AuthPage :title="t('auth.reset.title')" :subtitle="t('auth.reset.subtitle')">
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="top"
      size="large"
      hide-required-asterisk
      @submit.prevent="submit"
    >
      <el-form-item :label="t('auth.sms.mobile')" prop="mobile">
        <el-input v-model="form.mobile" name="mobile" autocomplete="tel" />
      </el-form-item>
      <el-form-item :label="t('auth.sms.code')" prop="code">
        <el-input
          v-model="form.code"
          name="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="6"
        >
          <template #append>
            <el-button
              native-type="button"
              :loading="checkingMobile || sending"
              :disabled="checkingMobile || sending || cooldown > 0"
              @click="sendCode"
            >
              {{ cooldown ? t('auth.sms.resendIn', { seconds: cooldown }) : t('auth.sms.getCode') }}
            </el-button>
          </template>
        </el-input>
      </el-form-item>
      <p v-if="sent" class="auth-form__note">{{ t('auth.sms.sentNote') }}</p>
      <el-form-item :label="t('common.passwordChange.newPassword')" prop="newPassword">
        <el-input
          v-model="form.newPassword"
          name="newPassword"
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
          name="confirmPassword"
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
        class="auth-form__error"
      />
      <el-button
        type="primary"
        native-type="submit"
        :loading="loading"
        :disabled="loading"
        class="auth-form__submit"
        >{{ t('auth.reset.submit') }}</el-button
      >
    </el-form>
    <p class="auth-form__link">
      <router-link to="/login">{{ t('auth.reset.signIn') }}</router-link>
    </p>
  </AuthPage>
</template>

<style scoped>
.auth-form__note {
  margin: -8px 0 12px;
  color: var(--qw-text-3);
  font-size: 13px;
}
.auth-form__error {
  margin-bottom: 16px;
}
.auth-form__submit {
  width: 100%;
}
.auth-form__link {
  margin-top: 16px;
  text-align: center;
}
.auth-form__link a {
  color: var(--qw-brand-text);
}
</style>
