<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormInstance } from 'element-plus'
import { smsLoginBody } from '@qiwu/shared'
import { useSmsCode } from '@/core/composables/use-sms-code'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'
import { ApiError } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'

/**
 * SMS sign-in (see docs/design-notes.md#auth-sessions), the content of the sign-in page's SMS tab: mobile, a code sent through
 * the `sms_send` captcha, keep signed in. Emits `done` once signed in; the page then redirects exactly
 * like after a password sign-in.
 */
defineOptions({ name: 'SmsLoginForm' })
const emit = defineEmits<{ done: [] }>()
const i18n = useI18n()
const { t } = i18n
const auth = useAuthStore()
const form = reactive({ mobile: '', code: '', keepSignedIn: false })
const rules = zodRules(smsLoginBody, i18n)
const formRef = ref<FormInstance>()
revalidateOnLocale(formRef)
const { cooldown, sending, send } = useSmsCode('signin')
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
    await auth.smsLogin({
      mobile: form.mobile.trim(),
      code: form.code,
      keepSignedIn: form.keepSignedIn,
    })
    emit('done')
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('common.error.network')
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
    <p v-if="sent" class="sms-login__note">{{ t('auth.sms.sentNote') }}</p>
    <el-checkbox v-model="form.keepSignedIn">{{ t('common.login.keepSignedIn') }}</el-checkbox>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      show-icon
      :closable="false"
      class="sms-login__error"
    />
    <el-button
      type="primary"
      native-type="submit"
      :loading="loading"
      :disabled="loading"
      class="sms-login__submit"
    >
      {{ t('common.action.signIn') }}
    </el-button>
  </el-form>
</template>

<style scoped>
.sms-login__note {
  margin: -8px 0 12px;
  color: var(--qw-text-3);
  font-size: 13px;
}
.sms-login__error {
  margin-bottom: 16px;
}
.sms-login__submit {
  width: 100%;
}
</style>
