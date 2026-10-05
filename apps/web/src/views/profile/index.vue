<script setup lang="ts">
import { computed, reactive, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, type FormInstance } from 'element-plus'
import {
  profileUpdate,
  WX_MP_ENABLED_PARAM,
  type AvatarVo,
  type Locale,
  type ProfileVo,
} from '@qiwu/shared'
import { profileApi } from '@/api/platform/iam/profile'
import { publicParamApi } from '@/api/platform/settings/public-param'
import AvatarCropper from '@/core/components/AvatarCropper.vue'
import PasswordChangeForm from '@/core/components/PasswordChangeForm.vue'
import { useDict } from '@/core/composables/use-dict'
import { useSmsCode } from '@/core/composables/use-sms-code'
import { openDialog } from '@/core/dialog'
import { revalidateOnLocale, zodRules } from '@/core/form/zod-rules'
import { tx } from '@/core/i18n'
import { Icon } from '@/core/icons'
import { ApiError } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { useLocaleStore } from '@/core/stores/locale'
import SocialBindings from './SocialBindings.vue'

/**
 * Personal center (static `/profile`, any signed-in user; see docs/design-notes.md#layering): own profile (display name, contacts,
 * gender), read-only dept / roles / positions, avatar (crop → POST /avatar), password change
 * and the language (saved to the account too, PUT /locale), and the WeChat binding while WeChat sign-in is on
 * or one is left. The header follows name and avatar changes.
 */
defineOptions({ name: 'ProfileView' })
const i18n = useI18n()
const { t } = i18n
const auth = useAuthStore()
const locale = useLocaleStore()
const { options: genders } = useDict('iam.gender')

const profile = shallowRef<ProfileVo>()
const loading = ref(true)
const tab = ref('info')
const model = reactive({
  displayName: '',
  mobile: '' as string | null,
  email: '' as string | null,
  gender: 'unknown' as ProfileVo['gender'],
  currentPassword: '',
  mobileCode: '',
})
const rules = zodRules(profileUpdate.omit({ mobileCode: true }), i18n, model)
const credentialRules = zodRules(profileUpdate.required({ currentPassword: true }), i18n, model)
const formRef = ref<FormInstance>()
revalidateOnLocale(formRef)
const saving = ref(false)
const changingMobile = computed(() => (model.mobile?.trim() || null) !== profile.value?.mobile)
const { cooldown, sending, send } = useSmsCode(profileApi.mobileCode)
const checkingMobile = ref(false)
const codeError = ref('')

async function sendCode() {
  if (checkingMobile.value || sending.value || cooldown.value) return
  checkingMobile.value = true
  try {
    if (!(await formRef.value?.validateField('mobile').catch(() => false))) return
    codeError.value = ''
    await send(model.mobile!.trim())
  } catch (e) {
    codeError.value = e instanceof ApiError ? e.message : t('common.error.network')
  } finally {
    checkingMobile.value = false
  }
}

function show(p: ProfileVo) {
  profile.value = p
  Object.assign(model, {
    displayName: p.displayName,
    mobile: p.mobile,
    email: p.email,
    gender: p.gender,
  })
}
/** the linked-accounts tab while WeChat sign-in is on, or while a binding is left to see and remove */
const socialsTab = ref(false)
void (async () => {
  const on = await publicParamApi.get(WX_MP_ENABLED_PARAM).then(
    (p) => p.value === 'true',
    () => false,
  )
  socialsTab.value =
    on ||
    (await profileApi.socials().then(
      (list) => list.length > 0,
      () => false,
    )) // the request layer showed it
})()
profileApi
  .get()
  .then(show, () => undefined) // the request layer showed it
  .finally(() => (loading.value = false))

async function save() {
  if (saving.value || !(await formRef.value?.validate().catch(() => false))) return
  saving.value = true
  try {
    const saved = await profileApi.update({
      displayName: model.displayName,
      mobile: model.mobile,
      email: model.email,
      gender: model.gender,
      ...(changingMobile.value
        ? {
            currentPassword: model.currentPassword,
            ...(model.mobileCode ? { mobileCode: model.mobileCode } : {}),
          }
        : {}),
    })
    show(saved)
    model.currentPassword = ''
    model.mobileCode = ''
    if (auth.me) auth.me.user.displayName = saved.displayName
    ElMessage.success(t('profile.saved'))
  } catch (e) {
    // 409 (a contact another user has) and 429 are toasted by the request layer, a 400 here
    if (e instanceof ApiError && e.status === 400) ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function changeAvatar() {
  const saved = await openDialog<AvatarVo>(
    AvatarCropper,
    { upload: (file: File) => profileApi.avatar(file) },
    { title: () => t('upload.avatar.title'), width: '600px' },
  )
  if (!saved || !profile.value) return
  profile.value = { ...profile.value, avatarUrl: saved.avatarUrl }
  if (auth.me) auth.me.user.avatarUrl = saved.avatarUrl
  ElMessage.success(t('profile.avatarDone'))
}

const LANGUAGE: Record<Locale, string> = {
  'zh-CN': 'common.language.zhCN',
  'en-US': 'common.language.enUS',
}
const language = computed({
  get: () => locale.locale,
  set: (l: Locale) => locale.set(l),
})
const initial = computed(() => [...(profile.value?.displayName ?? '')][0]?.toUpperCase() ?? '')
</script>

<template>
  <div class="qw-page">
    <div v-loading="loading" class="profile">
      <el-card class="profile__card">
        <template v-if="profile">
          <div class="profile__who">
            <span class="profile__avatar">
              <img v-if="profile.avatarUrl" :src="profile.avatarUrl" :alt="profile.displayName" />
              <template v-else>{{ initial }}</template>
            </span>
            <el-button @click="changeAvatar">
              <el-icon class="el-icon--left"><Icon icon="lucide:camera" /></el-icon>
              {{ t('profile.changeAvatar') }}
            </el-button>
            <div class="profile__name">{{ profile.displayName }}</div>
            <div class="profile__username">{{ profile.username }}</div>
          </div>
          <dl class="profile__facts">
            <dt>{{ t('field.iam.user.deptName') }}</dt>
            <dd>{{ profile.deptName ? tx(profile.deptName) : '—' }}</dd>
            <dt>{{ t('field.iam.user.roleNames') }}</dt>
            <dd>
              <el-tag v-for="n in profile.roleNames" :key="n" disable-transitions>{{
                tx(n)
              }}</el-tag>
              <template v-if="!profile.roleNames.length">—</template>
            </dd>
            <dt>{{ t('field.iam.user.positionNames') }}</dt>
            <dd>
              <el-tag v-for="n in profile.positionNames" :key="n" type="info" disable-transitions>
                {{ tx(n) }}
              </el-tag>
              <template v-if="!profile.positionNames.length">—</template>
            </dd>
          </dl>
        </template>
      </el-card>

      <el-card class="profile__main">
        <el-tabs v-model="tab">
          <el-tab-pane :label="t('profile.tabs.info')" name="info">
            <el-form
              ref="formRef"
              :model="model"
              :rules="rules"
              label-position="top"
              class="profile__form"
              @submit.prevent="save"
            >
              <el-form-item :label="t('field.iam.user.username')">
                <el-input :model-value="profile?.username" disabled />
              </el-form-item>
              <el-form-item :label="t('field.iam.user.displayName')" prop="displayName">
                <el-input v-model="model.displayName" maxlength="64" />
              </el-form-item>
              <el-form-item :label="t('field.iam.user.mobile')" prop="mobile">
                <el-input v-model="model.mobile" maxlength="32" />
              </el-form-item>
              <template v-if="changingMobile">
                <el-alert
                  :title="
                    t(model.mobile?.trim() ? 'profile.mobileHint' : 'profile.mobileRemoveHint')
                  "
                  type="info"
                  :closable="false"
                  class="profile__hint"
                />
                <el-form-item
                  :label="t('field.iam.user.currentPassword')"
                  prop="currentPassword"
                  :rules="credentialRules.currentPassword"
                >
                  <el-input
                    v-model="model.currentPassword"
                    name="currentPassword"
                    type="password"
                    show-password
                    autocomplete="current-password"
                  />
                </el-form-item>
                <el-form-item
                  v-if="model.mobile?.trim()"
                  :label="t('field.iam.user.mobileCode')"
                  prop="mobileCode"
                >
                  <el-input
                    v-model="model.mobileCode"
                    name="mobileCode"
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
                        {{
                          cooldown
                            ? t('auth.sms.resendIn', { seconds: cooldown })
                            : t('auth.sms.getCode')
                        }}
                      </el-button>
                    </template>
                  </el-input>
                  <div v-if="codeError" class="profile__note">{{ codeError }}</div>
                </el-form-item>
              </template>
              <el-form-item :label="t('field.iam.user.email')" prop="email">
                <el-input v-model="model.email" maxlength="128" />
              </el-form-item>
              <el-form-item :label="t('field.iam.user.gender')" prop="gender">
                <el-radio-group v-model="model.gender">
                  <el-radio v-for="g in genders" :key="g.value" :value="g.value">
                    {{ g.label }}
                  </el-radio>
                </el-radio-group>
              </el-form-item>
              <el-button type="primary" native-type="submit" :loading="saving" :disabled="!profile">
                {{ t('crud.action.save') }}
              </el-button>
            </el-form>
          </el-tab-pane>

          <el-tab-pane :label="t('profile.tabs.password')" name="password">
            <div class="profile__form">
              <el-alert
                :title="t('profile.passwordHint')"
                type="info"
                show-icon
                :closable="false"
                class="profile__hint"
              />
              <PasswordChangeForm />
            </div>
          </el-tab-pane>

          <el-tab-pane v-if="socialsTab" :label="t('profile.tabs.socials')" name="socials" lazy>
            <SocialBindings />
          </el-tab-pane>

          <el-tab-pane :label="t('profile.tabs.prefs')" name="prefs">
            <el-form label-position="top" class="profile__form">
              <el-form-item :label="t('profile.language')">
                <el-radio-group v-model="language">
                  <el-radio v-for="l in locale.locales" :key="l" :value="l" :lang="l">
                    {{ t(LANGUAGE[l]) }}
                  </el-radio>
                </el-radio-group>
                <div class="profile__note">{{ t('profile.languageHint') }}</div>
              </el-form-item>
            </el-form>
          </el-tab-pane>
        </el-tabs>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.profile {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.profile__who {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  padding: 12px 0 20px;
  border-bottom: 1px solid var(--qw-border);
}
.profile__avatar {
  display: grid;
  place-items: center;
  width: 96px;
  height: 96px;
  overflow: hidden;
  font-size: 36px;
  font-weight: 650;
  color: var(--qw-brand-text);
  background: var(--qw-brand-weak);
  border-radius: 50%;
}
.profile__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.profile__name {
  margin-top: 4px;
  font-size: 18px;
  font-weight: 650;
  line-height: 24px;
  color: var(--qw-text);
}
.profile__username {
  margin-top: -8px;
  font-size: 13px;
  color: var(--qw-text-3);
}
.profile__facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 12px 16px;
  margin: 20px 0 4px;
  font-size: 13px;
}
.profile__facts dt {
  color: var(--qw-text-3);
  white-space: nowrap;
}
.profile__facts dd {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  color: var(--qw-text);
}
.profile__main :deep(.el-card__body) {
  padding: 8px 24px 24px;
}
.profile__form {
  max-width: 440px;
  padding-top: 8px;
}
.profile__hint {
  margin-bottom: 20px;
}
.profile__note {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
</style>
