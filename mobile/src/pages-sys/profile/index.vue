<template>
  <view class="qw-detail qw-stack">
    <template v-if="profile">
      <wd-cell-group custom-class="qw-group" border>
        <wd-cell
          custom-class="qw-profile__avatar"
          :title="t('mine.avatar')"
          is-link
          center
          @click="changeAvatar"
        >
          <wd-loading v-if="uploading" size="48rpx" />
          <wd-avatar v-else :src="avatar" :text="initial" size="88rpx" shape="round" />
        </wd-cell>
        <wd-cell :title="t('field.iam.user.username')" :value="profile.username" />
        <wd-cell
          :title="t('field.iam.user.mobile')"
          :value="profile.mobile || '—'"
          :label="t('mine.mobileHint')"
        />
        <wd-cell
          :title="t('field.iam.user.deptName')"
          :value="profile.deptName ? tx(profile.deptName) : '—'"
        />
        <wd-cell :title="t('field.iam.user.roleNames')" :value="names(profile.roleNames)" />
        <wd-cell :title="t('field.iam.user.positionNames')" :value="names(profile.positionNames)" />
      </wd-cell-group>
      <view class="qw-form">
        <view class="qw-field qw-profile__displayName">
          <text class="qw-field__label">{{ t('field.iam.user.displayName') }}</text>
          <wd-input v-model="form.displayName" :maxlength="64" :error="!!errors.displayName" />
          <text v-if="errors.displayName" class="qw-field__error">{{ errors.displayName }}</text>
        </view>
        <view class="qw-field qw-profile__email">
          <text class="qw-field__label">{{ t('field.iam.user.email') }}</text>
          <wd-input v-model="form.email" :maxlength="128" clearable :error="!!errors.email" />
          <text v-if="errors.email" class="qw-field__error">{{ errors.email }}</text>
        </view>
        <view class="qw-field qw-profile__gender">
          <text class="qw-field__label">{{ t('field.iam.user.gender') }}</text>
          <wd-radio-group v-model="form.gender" direction="horizontal">
            <wd-radio v-for="g in genders" :key="g.value" :value="g.value">{{ g.label }}</wd-radio>
          </wd-radio-group>
        </view>
        <wd-button
          custom-class="qw-btn qw-btn--primary qw-profile__save"
          type="primary"
          block
          :loading="saving"
          :disabled="saving"
          @click="save"
        >
          {{ t('mine.save') }}
        </wd-button>
      </view>
    </template>
    <QwEmpty v-else-if="error" :title="error" />
  </view>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import {
  USER_GENDERS,
  profileUpdate,
  type AvatarVo,
  type DictPayload,
  type ProfileVo,
  type UserGender,
  type ValidationIssue,
} from '@qiwu/shared'
import QwEmpty from '@/core/components/QwEmpty.vue'
import { fieldErrors, locale, t, tx } from '@/core/i18n'
import { ApiError, api, assetUrl, errorText, upload } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'

/**
 * My profile (subpackage pages-sys), as the web's personal center: display name, email and gender
 * editable (the shared `profileUpdate` rules), username / mobile / dept / roles / positions read-only (a new
 * mobile needs an SMS code: the desktop). The avatar: a picked image through the backend upload,
 * which crops it to 256×256. The "Me" tab follows name and avatar changes.
 */
const BASE = '/iam/profile'
const auth = useAuthStore()
const profile = ref<ProfileVo>()
const error = ref('')
const form = reactive({ displayName: '', email: '', gender: 'unknown' as UserGender })
const issues = ref<ValidationIssue[]>([])
const errors = computed(() => fieldErrors(profileUpdate, issues.value))
const saving = ref(false)
const uploading = ref(false)

const avatar = computed(() => (profile.value?.avatarUrl ? assetUrl(profile.value.avatarUrl) : ''))
const initial = computed(() => [...(profile.value?.displayName ?? '')][0]?.toUpperCase() ?? '')
const names = (list: string[]) => list.map(tx).join(' · ') || '—'

// the gender labels of the `iam.gender` dict (label_i18n[locale] → label), else the codes
const dict = ref<DictPayload>()
const genders = computed(() =>
  USER_GENDERS.map((value) => {
    const e = dict.value?.entries.find((x) => x.value === value)
    return { value, label: e ? e.labelI18n?.[locale()] || tx(e.label) : value }
  }),
)

function show(p: ProfileVo) {
  profile.value = p
  Object.assign(form, { displayName: p.displayName, email: p.email ?? '', gender: p.gender })
}

onLoad(async () => {
  uni.setNavigationBarTitle({ title: t('mine.profile') })
  api.get<DictPayload>('/settings/dicts/iam.gender/entries', undefined, { silent: true }).then(
    (d) => (dict.value = d),
    () => {},
  )
  try {
    show(await api.get<ProfileVo>(BASE))
  } catch (e) {
    error.value = errorText(e)
  }
})

async function save() {
  if (saving.value) return
  const parsed = profileUpdate.safeParse(form)
  issues.value = parsed.error?.issues ?? []
  if (!parsed.success) return
  const { displayName, email, gender } = parsed.data
  saving.value = true
  try {
    // only these fields: the mobile stays (sending it would ask for the password)
    const saved = await api.put<ProfileVo>(BASE, { displayName, email, gender })
    show(saved)
    if (auth.me) auth.me.user.displayName = saved.displayName
    uni.showToast({ title: t('mine.saved'), icon: 'none' })
  } catch (e) {
    // 409 / 429 are toasted by the request layer, a 400 belongs here
    if (e instanceof ApiError && e.status === 400) uni.showToast({ title: e.message, icon: 'none' })
  } finally {
    saving.value = false
  }
}

async function changeAvatar() {
  if (uploading.value || !profile.value) return
  let path: string | undefined
  try {
    const picked = await uni.chooseImage({ count: 1, sizeType: ['compressed'] })
    path = [picked.tempFilePaths].flat()[0]
  } catch {
    return // closed
  }
  if (!path) return
  uploading.value = true
  try {
    const { avatarUrl } = await upload<AvatarVo>(`${BASE}/avatar`, path)
    profile.value = { ...profile.value, avatarUrl }
    if (auth.me) auth.me.user.avatarUrl = avatarUrl
    uni.showToast({ title: t('mine.avatarDone'), icon: 'none' })
  } catch {
    // the request layer toasts every failure of an upload (413 over the size limit, 422 not an image, …)
  } finally {
    uploading.value = false
  }
}
</script>

<style>
/* the initial on the brand's weak ground (as the list avatars); the chevron level with it */
.qw-profile__avatar {
  --wot-avatar-bg: var(--qw-brand-weak);
  --wot-avatar-color: var(--qw-brand-text);
}

.qw-profile__avatar :deep(.wd-cell__body) {
  align-items: center;
}
</style>
