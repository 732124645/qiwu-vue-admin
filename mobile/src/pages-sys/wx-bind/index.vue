<template>
  <LoginShell
    v-model:tab="tab"
    compact
    back
    :title="t('login.wxBind.title')"
    :sub="t('login.wxBind.hint')"
  >
    <view v-if="tab === 'password'" class="qw-bind__form">
      <PasswordFields :form="form" :errors="errors" @confirm="submit" />
      <text v-if="error" class="qw-form__error" role="alert">{{ error }}</text>
      <wd-button
        type="primary"
        block
        size="large"
        custom-class="qw-btn qw-btn--primary qw-login__submit"
        :loading="loading"
        :disabled="loading"
        @click="submit"
      >
        {{ t('login.wxBind.submit') }}
      </wd-button>
    </view>
    <SmsForm
      v-else
      :ask="ask"
      :sign-in="auth.wxBind"
      :action="t('login.wxBind.submit')"
      @done="goHome"
    />
  </LoginShell>
  <QwCaptcha ref="captcha" />
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { Err, loginBody, type ValidationIssue } from '@qiwu/shared'
import QwCaptcha from '@/core/components/QwCaptcha.vue'
import { withCaptcha, type AskCaptcha } from '@/core/captcha'
import { fieldErrors, t } from '@/core/i18n'
import { ApiError, errorText } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'
import LoginShell from '@/pages/login/LoginShell.vue'
import PasswordFields from '@/pages/login/PasswordFields.vue'
import SmsForm from '@/pages/login/SmsForm.vue'

/**
 * Link this WeChat account (mp-weixin; opened by the sign-in page when WeChat knows no account):
 * one sign-in with the account's password (captcha as the sign-in page) or an SMS code binds it and signs in.
 * Every try asks WeChat for a new bind ticket (the auth store): a failed try spent the last one.
 * The sign-in page's frame, compact, with this page's title and a back button (custom navigation).
 */
const HOME_PAGE = '/pages/home/index'

const auth = useAuthStore()
const captcha = ref<InstanceType<typeof QwCaptcha>>()
const ask: AskCaptcha = (scene) => captcha.value!.ask(scene)

const tab = ref<'password' | 'sms'>('password')
const form = reactive({ username: '', password: '' })
const issues = ref<ValidationIssue[]>([])
const errors = computed(() => fieldErrors(loginBody, issues.value))
const loading = ref(false)
const error = ref('')

const goHome = () => uni.reLaunch({ url: HOME_PAGE })
onLoad(() => uni.setNavigationBarTitle({ title: t('login.wxBind.title') }))

async function submit() {
  if (loading.value) return
  const parsed = loginBody.safeParse(form)
  issues.value = parsed.error?.issues ?? []
  if (!parsed.success) return
  loading.value = true
  error.value = ''
  try {
    const { username, password } = parsed.data
    const done = await withCaptcha(
      ask,
      'signin',
      async (captchaTicket) => {
        await auth.wxBind({ username, password, ...(captchaTicket ? { captchaTicket } : {}) })
        return true
      },
      (e) => e instanceof ApiError && e.code === Err.AUTH_CAPTCHA_REQUIRED.code,
    )
    if (done) goHome()
  } catch (e) {
    // the server's message is already translated (Accept-Language)
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
</script>

<style>
.qw-bind__form {
  display: flex;
  flex-direction: column;
  gap: 26rpx;
}

/* 52 high (the sign-in's large control) */
.qw-login__submit {
  --wot-button-height-large: 96rpx;
  height: 96rpx;
  margin-top: 8rpx;
}
</style>
