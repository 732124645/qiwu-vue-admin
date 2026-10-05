<template>
  <view class="qw-detail">
    <view class="qw-form">
      <text v-if="due" class="qw-password__due" role="alert">{{ t(due) }}</text>
      <text class="qw-form__hint">{{ t('mine.passwordHint') }}</text>
      <view v-for="f in FIELDS" :key="f.name" :class="`qw-field qw-password__${f.name}`">
        <text class="qw-field__label">{{ t(f.label) }}</text>
        <wd-input
          v-model="form[f.name]"
          :maxlength="128"
          show-password
          :error="!!errors[f.name]"
          @confirm="submit"
        />
        <text v-if="errors[f.name]" class="qw-field__error">{{ errors[f.name] }}</text>
      </view>
      <text v-if="error" class="qw-form__error" role="alert">{{ error }}</text>
      <wd-button
        custom-class="qw-btn qw-btn--primary qw-password__submit"
        type="primary"
        block
        :loading="loading"
        :disabled="loading"
        @click="submit"
      >
        {{ t('mine.password') }}
      </wd-button>
      <!-- until the change, the tab pages lead back here: signing out is the other way out -->
      <wd-button
        v-if="due"
        custom-class="qw-password__sign-out"
        type="danger"
        variant="text"
        block
        :loading="signingOut"
        :disabled="signingOut"
        @click="signOut"
      >
        {{ t('mine.signOut') }}
      </wd-button>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { DEFAULT_PASSWORD_POLICY, changePasswordBody, type ValidationIssue } from '@qiwu/shared'
import { fieldErrors, t } from '@/core/i18n'
import { ApiError, LOGIN_PAGE, api } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'

/**
 * Change my password (subpackage pages-sys, PUT /api/iam/profile/password, as the web's form): old,
 * new and confirm under the server's policy from /auth/me. The server keeps this session and ends the
 * others; a wrong old password is its 400 message here. A session with an initial or expired password is
 * sent here (the request layer, the auth store, the tab pages) and may only change it or sign out.
 */
type Name = 'oldPassword' | 'newPassword' | 'confirmPassword'
const FIELDS: { name: Name; label: string }[] = [
  { name: 'oldPassword', label: 'field.auth.oldPassword' },
  { name: 'newPassword', label: 'field.auth.newPassword' },
  { name: 'confirmPassword', label: 'mine.confirmPassword' },
]

const HOME_PAGE = '/pages/home/index'

const auth = useAuthStore()
const schema = computed(() => changePasswordBody(auth.me?.policy ?? DEFAULT_PASSWORD_POLICY))
const form = reactive<Record<Name, string>>({
  oldPassword: '',
  newPassword: '',
  confirmPassword: '',
})
const issues = ref<ValidationIssue[]>([])
const mismatch = ref(false)
const errors = computed<Partial<Record<Name, string>>>(() => ({
  ...(mismatch.value ? { confirmPassword: t('mine.mismatch') } : {}),
  ...fieldErrors(schema.value, issues.value),
}))
const loading = ref(false)
const error = ref('')
/** why the change cannot wait, if it cannot */
const due = computed(() =>
  !auth.passwordChangeDue
    ? ''
    : auth.me?.flags.passwordExpired
      ? 'mine.passwordExpired'
      : 'mine.passwordRequired',
)

onLoad(() => {
  uni.setNavigationBarTitle({ title: t('mine.password') })
  // the policy: a page opened straight from a link may come before the tab pages loaded /auth/me
  if (!auth.me) auth.fetchMe().catch(() => {})
})

async function submit() {
  if (loading.value) return
  const parsed = schema.value.safeParse(form)
  issues.value = parsed.error?.issues ?? []
  mismatch.value = form.confirmPassword !== form.newPassword
  if (!parsed.success || mismatch.value) return
  loading.value = true
  error.value = ''
  try {
    const { oldPassword, newPassword } = parsed.data
    await api.put('/iam/profile/password', { oldPassword, newPassword })
    // the server cleared this session's password flags: reload them before a tab page checks them (a failed
    // reload leaves `me` empty, and the tab pages load it again)
    auth.me = null
    await auth.fetchMe().catch(() => {})
    uni.showToast({ title: t('mine.passwordDone'), icon: 'none' })
    // alone in the stack (sent here, or opened from a link): on to the workbench
    if (getCurrentPages().length > 1) uni.navigateBack()
    else uni.reLaunch({ url: HOME_PAGE })
  } catch (e) {
    // a wrong or reused old password (400) belongs to the form; the request layer toasts the rest
    if (e instanceof ApiError && e.status === 400) error.value = e.message
  } finally {
    loading.value = false
  }
}

const signingOut = ref(false)
async function signOut() {
  signingOut.value = true
  // ends the server session and forgets the stored refresh token, whatever the server says
  await auth.logout()
  uni.reLaunch({ url: LOGIN_PAGE, complete: () => (signingOut.value = false) })
}
</script>

<style>
.qw-password__due {
  padding: 20rpx 24rpx;
  border-radius: var(--qw-radius);
  font-size: var(--qw-fs-body);
  line-height: 1.5;
  color: var(--qw-warning);
  background: var(--qw-warning-weak);
}
</style>
