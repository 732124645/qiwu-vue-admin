<script setup lang="ts">
// Password change outside the layout: forced while /me flags mustChangePassword/passwordExpired
// (the router guard allows only this page and sign-out), voluntary from the user menu otherwise.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { DEFAULT_PASSWORD_POLICY } from '@qiwu/shared'
import PasswordChangeForm from '@/core/components/PasswordChangeForm.vue'
import AuthPage from '@/core/layout/AuthPage.vue'
import { safeRedirect } from '@/core/router'
import { useAuthStore } from '@/core/stores/auth'

defineOptions({ name: 'PasswordChangeView' })

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const forced = computed(() => auth.mustChangePassword)
const policy = auth.me?.policy ?? DEFAULT_PASSWORD_POLICY

const back = () => router.replace(safeRedirect(route.query.redirect))

async function signOut() {
  await auth.logout()
  await router.replace('/login')
}
</script>

<template>
  <AuthPage
    :title="t('common.passwordChange.title')"
    :subtitle="
      t(
        policy.charClasses ? 'common.passwordChange.policy' : 'common.passwordChange.policyLength',
        { minLength: policy.minLength, charClasses: policy.charClasses },
      )
    "
  >
    <el-alert
      v-if="forced"
      :title="
        t(
          auth.flags?.passwordExpired
            ? 'common.passwordChange.expired'
            : 'common.passwordChange.required',
        )
      "
      type="warning"
      show-icon
      :closable="false"
      class="password-change__notice"
    />
    <PasswordChangeForm large @done="back">
      <div class="password-change__footer">
        <el-button v-if="forced" link type="primary" @click="signOut">
          {{ t('common.action.signOut') }}
        </el-button>
        <el-button v-else link type="primary" @click="back">
          {{ t('common.action.cancel') }}
        </el-button>
      </div>
    </PasswordChangeForm>
  </AuthPage>
</template>

<style scoped>
.password-change__notice {
  margin-bottom: 20px;
}
.password-change__footer {
  display: flex;
  justify-content: center;
  margin-top: 12px;
}
</style>
