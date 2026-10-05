<template>
  <view class="qw-sms">
    <view :class="['qw-field qw-sms__mobile', { 'is-focus': focus === 'mobile' }]">
      <wd-input
        v-model="form.mobile"
        type="tel"
        :placeholder="t('field.auth.mobile')"
        :maxlength="32"
        clearable
        clear-trigger="focus"
        :adjust-position="false"
        :error="!!errors.mobile"
        @focus="focus = 'mobile'"
        @blur="focus = ''"
      >
        <template #prefix>
          <QwIcon class="qw-login__icon" name="phone" size="37rpx" />
        </template>
      </wd-input>
      <text v-if="errors.mobile" class="qw-field__error">{{ errors.mobile }}</text>
    </view>
    <view :class="['qw-field qw-sms__code', { 'is-focus': focus === 'code' }]">
      <wd-input
        v-model="form.code"
        type="number"
        :placeholder="t('field.auth.code')"
        :maxlength="6"
        :adjust-position="false"
        :error="!!errors.code"
        @focus="focus = 'code'"
        @blur="focus = ''"
        @confirm="submit"
      >
        <template #prefix>
          <QwIcon class="qw-login__icon" name="shield" size="37rpx" />
        </template>
        <template #suffix>
          <view
            :class="['qw-sms__send', { 'is-disabled': sending || cooldown > 0 }]"
            role="button"
            :aria-disabled="sending || cooldown > 0"
            @click.stop="sendCode"
          >
            {{ cooldown ? t('login.resendIn', { seconds: cooldown }) : t('login.getCode') }}
          </view>
        </template>
      </wd-input>
      <text v-if="errors.code" class="qw-field__error">{{ errors.code }}</text>
    </view>
    <view v-if="sent" class="qw-sms__note">
      <QwIcon class="qw-sms__note-icon" name="info" size="30rpx" />
      <text>{{ t('login.sentNote') }}</text>
    </view>
    <text v-if="error" class="qw-sms__error" role="alert">{{ error }}</text>
    <wd-button
      type="primary"
      block
      size="large"
      :custom-class="`qw-btn qw-btn--primary qw-login__submit${!action && locale() === 'zh-CN' ? ' is-zh' : ''}`"
      :loading="loading"
      :disabled="loading"
      @click="submit"
    >
      {{ action ?? t('common.action.signIn') }}
    </wd-button>
  </view>
</template>

<script setup lang="ts">
import { computed, onUnmounted, reactive, ref } from 'vue'
import { smsLoginBody, type SmsCodeBody, type SmsCodeVo, type ValidationIssue } from '@qiwu/shared'
import QwIcon from '@/core/components/QwIcon.vue'
import { withCaptcha, type AskCaptcha } from '@/core/captcha'
import { fieldErrors, locale, t } from '@/core/i18n'
import { api, errorText } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'

/**
 * SMS sign-in (see docs/design-notes.md#auth-sessions), the sign-in page's second tab: a code sent through the `sms_send` captcha, then a
 * countdown from the server's `cooldownSec`. The answer is the same whether the number has an account or not,
 * and so is what the form shows. Emits `done` once signed in. `signIn`/`action`: another use of the proven
 * code and its button text (the WeChat bind page: bind, then sign in).
 */
const props = defineProps<{
  ask: AskCaptcha
  signIn?: (body: { mobile: string; code: string }) => Promise<void>
  action?: string
}>()
const emit = defineEmits<{ done: [] }>()
const auth = useAuthStore()

const form = reactive({ mobile: '', code: '' })
const focus = ref('')
const issues = ref<ValidationIssue[]>([])
const errors = computed(() => fieldErrors(smsLoginBody, issues.value))
const cooldown = ref(0)
const sending = ref(false)
const sent = ref(false)
const loading = ref(false)
const error = ref('')
let timer: ReturnType<typeof setInterval> | undefined
onUnmounted(() => clearInterval(timer))

async function sendCode() {
  if (sending.value || cooldown.value) return
  const parsed = smsLoginBody.safeParse(form)
  issues.value = parsed.error?.issues.filter((i) => i.path[0] === 'mobile') ?? []
  if (issues.value.length) return
  const mobile = form.mobile.trim()
  sending.value = true
  error.value = ''
  try {
    const answer = await withCaptcha(props.ask, 'sms_send', (captchaTicket) =>
      api.post<SmsCodeVo>(
        '/auth/sms/code',
        {
          mobile,
          scene: 'signin',
          ...(captchaTicket ? { captchaTicket } : {}),
        } satisfies SmsCodeBody,
        { silent: true },
      ),
    )
    if (!answer) return
    sent.value = true
    cooldown.value = answer.cooldownSec
    clearInterval(timer)
    timer = setInterval(() => {
      if (--cooldown.value <= 0) clearInterval(timer)
    }, 1000)
  } catch (e) {
    error.value = errorText(e)
  } finally {
    sending.value = false
  }
}

async function submit() {
  if (loading.value) return
  const parsed = smsLoginBody.safeParse(form)
  issues.value = parsed.error?.issues ?? []
  if (!parsed.success) return
  loading.value = true
  error.value = ''
  try {
    await (props.signIn ?? auth.smsLogin)({ mobile: parsed.data.mobile, code: parsed.data.code })
    emit('done')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
</script>

<style>
.qw-sms {
  display: flex;
  flex-direction: column;
  gap: 26rpx;
}

/* get code: a text button at the code field's end, after a hairline */
.qw-sms .qw-field .wd-input {
  padding: 0 28rpx;
}

.qw-sms .qw-sms__code .wd-input {
  padding-right: 0;
}

.qw-sms__send {
  position: relative;
  display: flex;
  align-items: center;
  height: max(82rpx, 44px);
  padding: 0 22rpx 0 26rpx;
  font-size: var(--qw-fs-body);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--qw-brand-text);
}

.qw-sms__send::before {
  content: '';
  position: absolute;
  top: 24rpx;
  bottom: 24rpx;
  left: 0;
  width: 1px;
  background: var(--qw-border);
}

.qw-sms__send.is-disabled {
  font-weight: 500;
  color: var(--qw-text-3);
}

.qw-sms__note {
  display: flex;
  gap: 15rpx;
  margin: -4rpx 0;
  font-size: var(--qw-fs-caption);
  line-height: 37rpx;
  color: var(--qw-text-3);
}

.qw-sms__note-icon {
  margin-top: 4rpx;
}

.qw-sms__error {
  font-size: var(--qw-fs-caption);
  color: var(--qw-danger);
}

.qw-login__icon {
  margin-right: 4rpx;
  color: var(--qw-text-3);
  transition: color 150ms;
}

.qw-field.is-focus .qw-login__icon {
  color: var(--qw-brand-text);
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
</style>
