<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useLocalStorage } from '@vueuse/core'
import type { FormInstance } from 'element-plus'
import { Err, loginBody } from '@qiwu/shared'
import { signupEnabled } from '@/api/auth-extra'
import { withCaptcha } from '@/core/captcha'
import PasswordToggle from '@/core/components/PasswordToggle.vue'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'
import { Icon } from '@/core/icons'
import AuthPage from '@/core/layout/AuthPage.vue'
import { ApiError } from '@/core/request/http'
import { safeRedirect } from '@/core/router'
import { useAuthStore } from '@/core/stores/auth'
import SmsLoginForm from './SmsLoginForm.vue'

defineOptions({ name: 'LoginView' })

const i18n = useI18n()
const { t } = i18n
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

/** "Remember username": this browser only; the password is never stored. */
const savedUsername = useLocalStorage<string | null>('qw.login.username', null)
const remember = ref(!!savedUsername.value)
const form = reactive({ username: savedUsername.value ?? '', password: '', keepSignedIn: false })
const rules = zodRules(loginBody, i18n)
const formRef = ref<FormInstance>()
revalidateOnLocale(formRef)
const loading = ref(false)
const error = ref('')
const tab = ref('password')
const canSignup = ref(false)
onMounted(async () => {
  canSignup.value = await signupEnabled()
})

const goHome = () => router.replace(safeRedirect(route.query.redirect))

async function submit() {
  if (loading.value) return
  if (!(await formRef.value?.validate().catch(() => false))) return
  loading.value = true
  error.value = ''
  try {
    const done = await withCaptcha(
      'signin',
      async (captchaTicket) => {
        await auth.login({ ...form, ...(captchaTicket ? { captchaTicket } : {}) })
        return true
      },
      (e) => e instanceof ApiError && e.code === Err.AUTH_CAPTCHA_REQUIRED.code,
    )
    if (!done) return
    savedUsername.value = remember.value ? form.username.trim() : null
    // the router guard loads /me and sends a must-change-password user to /password-change
    await goHome()
  } catch (e) {
    // the server's message is already translated (Accept-Language)
    error.value = e instanceof ApiError ? e.message : t('common.error.network')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <AuthPage :title="t('common.login.title')" :subtitle="t('common.login.subtitle')">
    <el-tabs v-model="tab" class="login__tabs">
      <el-tab-pane name="password" :label="t('auth.entry.passwordTab')">
        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          label-position="top"
          size="large"
          hide-required-asterisk
          @submit.prevent="submit"
        >
          <el-form-item :label="t('common.login.username')" prop="username">
            <el-input v-model="form.username" name="username" autocomplete="username">
              <template #prefix><Icon icon="lucide:user-round" /></template>
            </el-input>
          </el-form-item>
          <el-form-item :label="t('common.login.password')" prop="password">
            <el-input
              v-model="form.password"
              name="password"
              type="password"
              autocomplete="current-password"
              show-password
            >
              <template #prefix><Icon icon="lucide:lock-keyhole" /></template>
              <template #password-icon="{ visible }"><PasswordToggle :visible /></template>
            </el-input>
          </el-form-item>
          <div class="login__options">
            <el-checkbox v-model="remember" size="default">{{
              t('common.login.rememberUsername')
            }}</el-checkbox>
            <el-checkbox v-model="form.keepSignedIn" size="default">{{
              t('common.login.keepSignedIn')
            }}</el-checkbox>
            <router-link to="/password-reset" class="login__forgot">{{
              t('auth.entry.forgotPassword')
            }}</router-link>
          </div>
          <el-alert
            v-if="error"
            :title="error"
            type="error"
            show-icon
            :closable="false"
            class="login__error"
          />
          <el-button
            type="primary"
            native-type="submit"
            :loading="loading"
            :disabled="loading"
            class="login__submit"
          >
            {{ t('common.action.signIn') }}
          </el-button>
        </el-form>
      </el-tab-pane>
      <el-tab-pane name="sms" :label="t('auth.entry.smsTab')" lazy>
        <SmsLoginForm @done="goHome" />
      </el-tab-pane>
    </el-tabs>
    <router-link v-if="canSignup" to="/register" class="login__signup">{{
      t('auth.entry.createAccount')
    }}</router-link>
  </AuthPage>
</template>

<style scoped>
.login__options {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
  margin: -4px 0 16px;
}
/* the options row keeps its right end for the forgot-password link */
.login__forgot,
.login__signup {
  color: var(--qw-brand-text);
  font-size: 14px;
  text-decoration: none;
}
.login__forgot:hover,
.login__signup:hover {
  text-decoration: underline;
}
.login__forgot {
  margin-left: auto;
  align-self: center;
}
.login__signup {
  display: block;
  margin-top: 16px;
  text-align: center;
}
.login__options .el-checkbox {
  margin-right: 0;
}
.login__error {
  margin-bottom: 16px;
}
.login__submit {
  width: 100%;
}
</style>
