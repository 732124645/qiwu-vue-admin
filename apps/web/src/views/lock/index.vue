<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { FormInstance } from 'element-plus'
import { verifyPasswordBody } from '@qiwu/shared'
import PasswordToggle from '@/core/components/PasswordToggle.vue'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'
import { Icon } from '@/core/icons'
import AuthPage from '@/core/layout/AuthPage.vue'
import { api, ApiError } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { useTagsStore } from '@/core/stores/tags'

defineOptions({ name: 'LockView' })

const i18n = useI18n()
const { t } = i18n
const router = useRouter()
const auth = useAuthStore()
const tags = useTagsStore()

const form = reactive({ password: '' })
const rules = zodRules(verifyPasswordBody, i18n)
const formRef = ref<FormInstance>()
revalidateOnLocale(formRef)
const loading = ref(false)
const error = ref('')

async function unlock() {
  if (!(await formRef.value?.validate().catch(() => false))) return
  loading.value = true
  error.value = ''
  try {
    await api.post('/auth/verify-password', form, { silent: true })
    await router.replace(auth.unlock())
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      // too many wrong passwords ended the session (see docs/design-notes.md#auth-sessions): sign in again, then back where it locked
      const back = auth.unlock()
      auth.clear()
      await router.replace({ path: '/login', query: { redirect: back } })
    } else error.value = e instanceof ApiError ? e.message : t('common.error.network')
  } finally {
    loading.value = false
  }
}

async function signOut() {
  await auth.logout()
  tags.reset()
  await router.replace('/login')
}
</script>

<template>
  <AuthPage
    :title="t('layout.lock.title')"
    :subtitle="t('layout.lock.hint', { name: auth.me?.user.displayName ?? '' })"
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="top"
      size="large"
      hide-required-asterisk
      @submit.prevent="unlock"
    >
      <!-- lets password managers match the account -->
      <input
        hidden
        name="username"
        autocomplete="username"
        :value="auth.me?.user.username"
        readonly
      />
      <el-form-item :label="t('common.login.password')" prop="password">
        <el-input
          v-model="form.password"
          name="password"
          type="password"
          autocomplete="current-password"
          show-password
          autofocus
        >
          <template #prefix><Icon icon="lucide:key-round" /></template>
          <template #password-icon="{ visible }"><PasswordToggle :visible /></template>
        </el-input>
      </el-form-item>
      <el-alert
        v-if="error"
        :title="error"
        type="error"
        show-icon
        :closable="false"
        class="lock__error"
      />
      <el-button type="primary" native-type="submit" :loading class="lock__submit">
        {{ t('layout.lock.unlock') }}
      </el-button>
      <div class="lock__other">
        <el-button link type="primary" @click="signOut">
          {{ t('common.action.signOut') }}
        </el-button>
      </div>
    </el-form>
  </AuthPage>
</template>

<style scoped>
.lock__error {
  margin-bottom: 16px;
}
.lock__submit {
  width: 100%;
}
.lock__other {
  margin-top: 12px;
  text-align: center;
}
</style>
