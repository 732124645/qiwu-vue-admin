<template>
  <LoginShell v-model:tab="tab" :sub="t('login.subtitle')">
    <text class="qw-login__title qw-sr-only" role="heading">{{ t('login.title') }}</text>
    <view v-if="tab === 'password'" class="qw-login__form">
      <PasswordFields :form="form" :errors="errors" @confirm="submit" />
      <wd-checkbox v-model="remember" custom-class="qw-login__remember">
        {{ t('login.rememberUsername') }}
        <template #icon>
          <view :class="['qw-login__box', { 'is-on': remember }]">
            <QwIcon v-if="remember" name="check" size="26rpx" />
          </view>
        </template>
      </wd-checkbox>
      <text v-if="error" class="qw-login__error" role="alert">{{ error }}</text>
      <wd-button
        type="primary"
        block
        size="large"
        :custom-class="`qw-btn qw-btn--primary qw-login__submit${locale() === 'zh-CN' ? ' is-zh' : ''}`"
        :loading="loading"
        :disabled="loading"
        @click="submit"
      >
        {{ t('common.action.signIn') }}
      </wd-button>
    </view>
    <SmsForm v-else :ask="ask" @done="goHome" />
    <template #foot>
      <view class="qw-login__foot">
        <view
          class="qw-login__lang"
          role="button"
          aria-haspopup="menu"
          :aria-label="t('common.language.title')"
          @click="langOpen = true"
        >
          <QwIcon name="globe" size="30rpx" />
          <text>{{ t(LANGUAGE_KEY[locale()]) }}</text>
          <QwIcon class="qw-login__chev" name="chevron-down" size="22rpx" />
        </view>
        <view class="qw-login__links">
          <text class="qw-login__ver">{{ t('common.version') }} {{ version }}</text>
          <text class="qw-login__dot">·</text>
          <text class="qw-login__link" role="link" @click="openAbout">{{
            t('login.privacy')
          }}</text>
          <text class="qw-login__dot">·</text>
          <text class="qw-login__link" role="link" @click="openAbout">{{ t('login.terms') }}</text>
        </view>
      </view>
    </template>
  </LoginShell>
  <wd-action-sheet
    v-model="langOpen"
    :actions="languages"
    :cancel-text="t('common.action.cancel')"
    @select="pickLocale"
  />
  <QwCaptcha ref="captcha" />
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { Err, LOCALES, loginBody, type Locale, type ValidationIssue } from '@qiwu/shared'
import QwCaptcha from '@/core/components/QwCaptcha.vue'
import QwIcon from '@/core/components/QwIcon.vue'
import { withCaptcha, type AskCaptcha } from '@/core/captcha'
import { LANGUAGE_KEY, fieldErrors, locale, setLocale, t } from '@/core/i18n'
import { ApiError, errorText, hasSession } from '@/core/request'
import { takeWxLaunch, useAuthStore } from '@/core/stores/auth'
import LoginShell from './LoginShell.vue'
import PasswordFields from './PasswordFields.vue'
import SmsForm from './SmsForm.vue'

/**
 * The start page: password sign-in (captcha by `captcha.mode`, or when the server demands one after cross-IP
 * failures), SMS sign-in, remember username, language. A stored session goes straight to the app; in the
 * WeChat mini program, WeChat sign-in comes first, once per launch.
 */
/** the workbench tab */
const HOME_PAGE = '/pages/home/index'
/** where an unbound WeChat account links an account (mp-weixin) */
const WX_BIND_PAGE = '/pages-sys/wx-bind/index'
/** the footer's privacy and terms links */
const ABOUT_PAGE = '/pages-sys/about/index'
/** "Remember username": this device only; the password is never stored. */
const USERNAME_KEY = 'qw.login.username'

const auth = useAuthStore()
const captcha = ref<InstanceType<typeof QwCaptcha>>()
const ask: AskCaptcha = (scene) => captcha.value!.ask(scene)

const tab = ref<'password' | 'sms'>('password')
const langOpen = ref(false)
const languages = computed(() => LOCALES.map((value) => ({ name: t(LANGUAGE_KEY[value]), value })))

const pickLocale = ({ item }: { item: { value: Locale } }) => setLocale(item.value)
/** manifest.json's versionName */
const version = uni.getAppBaseInfo().appVersion ?? ''
/** privacy and terms: the About page until they have pages of their own */
const openAbout = () => uni.navigateTo({ url: ABOUT_PAGE })

const saved: unknown = uni.getStorageSync(USERNAME_KEY)
const remember = ref(typeof saved === 'string' && saved !== '')
const form = reactive({ username: remember.value ? (saved as string) : '', password: '' })
const issues = ref<ValidationIssue[]>([])
const errors = computed(() => fieldErrors(loginBody, issues.value))
const loading = ref(false)
const error = ref('')

const goHome = () => uni.reLaunch({ url: HOME_PAGE })
onLoad(() => {
  if (hasSession()) return goHome()
  // #ifdef MP-WEIXIN
  if (takeWxLaunch()) wxSignIn()
  // #endif
})

// #ifdef MP-WEIXIN
/** A bound WeChat account goes straight in, an unbound one to the bind page; off (404) or failing → this page. */
async function wxSignIn() {
  try {
    if ((await auth.wxLogin()) === null) goHome()
    else uni.navigateTo({ url: WX_BIND_PAGE })
  } catch {
    // WeChat sign-in switched off, WeChat or the network failing: the forms here still work
  }
}
// #endif

async function submit() {
  if (loading.value) return
  const parsed = loginBody.safeParse(form)
  issues.value = parsed.error?.issues ?? []
  if (!parsed.success) return
  loading.value = true
  error.value = ''
  try {
    const done = await withCaptcha(
      ask,
      'signin',
      async (captchaTicket) => {
        await auth.login({ ...parsed.data, ...(captchaTicket ? { captchaTicket } : {}) })
        return true
      },
      (e) => e instanceof ApiError && e.code === Err.AUTH_CAPTCHA_REQUIRED.code,
    )
    if (!done) return
    if (remember.value) uni.setStorageSync(USERNAME_KEY, parsed.data.username)
    else uni.removeStorageSync(USERNAME_KEY)
    goHome()
  } catch (e) {
    // the server's message is already translated (Accept-Language)
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
</script>

<style>
.qw-login__form {
  display: flex;
  flex-direction: column;
  gap: 26rpx;
}

/* the whole row is the 44 high target */
.qw-login__remember {
  --wot-checkbox-label-font-size: var(--qw-fs-body);
  --wot-checkbox-label-color: var(--qw-text-2);
  --wot-checkbox-label-margin: 19rpx;
  align-self: flex-start;
  min-height: max(82rpx, 44px);
  margin: -11rpx 0;
}

/* 52 high (the sign-in's large control); the Chinese "sign in" is spaced */
.qw-login__submit {
  --wot-button-height-large: 96rpx;
  height: 96rpx;
  margin-top: 8rpx;
}

.qw-login__submit.is-zh {
  letter-spacing: 0.3em;
  text-indent: 0.3em;
}

.qw-login__box {
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 37rpx;
  height: 37rpx;
  border: 1.5px solid var(--qw-text-3);
  border-radius: var(--qw-radius-sm);
  color: var(--qw-on-brand);
  background: var(--qw-surface);
}

.qw-login__box.is-on {
  border-color: var(--qw-brand);
  background: var(--qw-brand);
}

.qw-login__error {
  font-size: var(--qw-fs-caption);
  color: var(--qw-danger);
}

.qw-login__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: max(82rpx, 44px);
  margin-top: 26rpx;
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-3);
}

.qw-login__lang {
  display: flex;
  align-items: center;
  gap: 9rpx;
  height: max(82rpx, 44px);
  padding-right: 15rpx;
  color: var(--qw-text-2);
}

.qw-login__chev {
  opacity: 0.8;
}

.qw-login__links {
  display: flex;
  align-items: center;
  white-space: nowrap;
}

.qw-login__ver {
  padding: 0 8rpx;
  font-variant-numeric: tabular-nums;
}

.qw-login__dot {
  opacity: 0.6;
}

.qw-login__link {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: max(82rpx, 44px);
  height: max(82rpx, 44px);
  padding: 0 8rpx;
  color: var(--qw-brand-text);
}

.qw-login__link:last-child {
  justify-content: flex-end;
  padding-right: 0;
}
</style>
