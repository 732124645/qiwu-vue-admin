<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormItemRule } from 'element-plus'
import { DEFAULT_PASSWORD_POLICY, signupBody, type PasswordPolicy } from '@qiwu/shared'
import { authExtraApi, publicPasswordPolicy, signupEnabled } from '@/api/auth-extra'
import PasswordToggle from '@/core/components/PasswordToggle.vue'
import { withCaptcha } from '@/core/captcha'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'
import AuthPage from '@/core/layout/AuthPage.vue'
import { ApiError } from '@/core/request/http'

/**
 * Sign-up (see docs/design-notes.md#auth-sessions), a public page behind the `auth.signup.enabled` switch (closed → no form).
 * Loads the public password policy before showing the form; the `signup` captcha ticket goes
 * along; success → sign in.
 */
defineOptions({ name: 'RegisterView' })
const i18n = useI18n()
const { t } = i18n
const router = useRouter()
const enabled = ref<boolean | null>(null)
const policy = ref<PasswordPolicy>(DEFAULT_PASSWORD_POLICY)
onMounted(async () => {
  if (await signupEnabled()) {
    policy.value = await publicPasswordPolicy()
    enabled.value = true
  } else enabled.value = false
})
const form = reactive({ username: '', displayName: '', password: '', confirmPassword: '' })
const rules = computed<Record<string, FormItemRule[]>>(() => {
  const signupRules = zodRules(signupBody(policy.value), i18n)
  return {
    ...signupRules,
    displayName: [
      {
        ...signupRules.displayName![0]!,
        validator: (rule, value, callback, source, options) =>
          value === ''
            ? callback()
            : signupRules.displayName![0]!.validator!(rule, value, callback, source, options),
      },
    ],
    confirmPassword: [
      {
        trigger: 'blur',
        validator: (_rule, value, callback) =>
          callback(
            value === form.password ? undefined : new Error(t('common.passwordChange.mismatch')),
          ),
      },
    ],
  }
})
const formRef = ref<FormInstance>()
revalidateOnLocale(formRef)
const loading = ref(false)
const error = ref('')

async function submit() {
  if (loading.value) return
  loading.value = true
  try {
    if (!(await formRef.value?.validate().catch(() => false))) return
    error.value = ''
    const done = await withCaptcha('signup', (ticket) =>
      authExtraApi
        .signup({
          username: form.username.trim(),
          password: form.password,
          ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
          ...(ticket ? { captchaTicket: ticket } : {}),
        })
        .then(() => true),
    )
    if (done) {
      ElMessage.success(t('auth.signup.done'))
      await router.replace('/login')
    }
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('common.error.network')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <AuthPage :title="t('auth.signup.title')" :subtitle="t('auth.signup.subtitle')">
    <p v-if="enabled === null" role="status">{{ t('auth.signup.loading') }}</p>
    <p v-else-if="!enabled" role="status">{{ t('auth.signup.closed') }}</p>
    <el-form
      v-else
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="top"
      size="large"
      hide-required-asterisk
      @submit.prevent="submit"
    >
      <el-form-item :label="t('common.login.username')" prop="username">
        <el-input v-model="form.username" name="username" autocomplete="username" />
      </el-form-item>
      <el-form-item :label="t('auth.signup.displayName')" prop="displayName">
        <el-input v-model="form.displayName" name="displayName" autocomplete="nickname" />
      </el-form-item>
      <el-form-item :label="t('common.login.password')" prop="password">
        <el-input
          v-model="form.password"
          name="password"
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
        >{{ t('auth.signup.submit') }}</el-button
      >
    </el-form>
    <p class="auth-form__link">
      <router-link to="/login">{{ t('auth.signup.signIn') }}</router-link>
    </p>
  </AuthPage>
</template>

<style scoped>
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
