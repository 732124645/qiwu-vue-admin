<template>
  <view class="qw-mine">
    <QwPageHeader variant="profile">
      <view class="qw-mine__card" role="link" @click="open('profile')">
        <view class="qw-mine__avatar">
          <image v-if="avatar" class="qw-mine__photo" :src="avatar" mode="aspectFill" />
          <text v-else aria-hidden="true">{{ initial }}</text>
        </view>
        <view class="qw-mine__who">
          <text class="qw-mine__name" role="heading">{{ me?.user.displayName }}</text>
          <text class="qw-mine__username">{{ me?.user.username }}</text>
          <view v-if="chips.length" class="qw-mine__chips">
            <text v-for="chip in chips" :key="chip" class="qw-mine__chip">{{ chip }}</text>
          </view>
        </view>
      </view>
    </QwPageHeader>
    <view class="qw-sheet qw-stack qw-mine__sheet">
      <view v-for="(group, i) in menus" :key="i" class="qw-group">
        <view
          v-for="item in group"
          :key="item.name"
          :class="`qw-menu__item qw-mine__${item.name}`"
          role="link"
          @click="item.go"
        >
          <view :class="`qw-tile qw-tile--${item.tone} qw-menu__tile`">
            <QwIcon :name="item.icon" size="34rpx" />
          </view>
          <text class="qw-menu__label">{{ t(`mine.${item.name}`) }}</text>
          <text v-if="item.value" class="qw-menu__value">{{ item.value }}</text>
          <QwIcon class="qw-menu__chev" name="chevron-right" size="34rpx" />
        </view>
      </view>
      <view
        :class="`qw-card qw-mine__sign-out${signingOut ? ' is-disabled' : ''}`"
        role="button"
        :aria-disabled="signingOut"
        @click="signOut"
      >
        <wd-loading v-if="signingOut" size="32rpx" />
        <text>{{ t('mine.signOut') }}</text>
      </view>
      <view class="qw-mine__foot">
        <QwBrandMark size="30rpx" />
        <text>{{ `${t('common.app.name')} · ${t('common.version')} ${version}` }}</text>
      </view>
    </view>
    <wd-action-sheet
      v-model="langOpen"
      :actions="languages"
      :cancel-text="t('common.action.cancel')"
      @select="pickLocale"
    />
    <!-- #ifndef MP-WEIXIN -->
    <wd-action-sheet
      v-model="appearanceOpen"
      :title="t('mine.appearance')"
      :actions="appearances"
      :cancel-text="t('common.action.cancel')"
      @select="pickAppearance"
    />
    <!-- #endif -->
    <QwTabBar current="mine" />
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { LOCALES, type Locale } from '@qiwu/shared'
import QwBrandMark from '@/core/components/QwBrandMark.vue'
import QwIcon, { type IconName } from '@/core/components/QwIcon.vue'
import QwPageHeader from '@/core/components/QwPageHeader.vue'
import QwTabBar from '@/core/components/QwTabBar.vue'
import { LANGUAGE_KEY, locale, setLocale, t, tx } from '@/core/i18n'
import { LOGIN_PAGE, api, assetUrl } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'
import {
  THEME_PREFS,
  canChooseTheme,
  refreshSystemTheme,
  setThemePref,
  systemIsDark,
  themePref,
  type ThemePref,
} from '@/core/theme'
import { loadSubscribeIds, requestSubscribe } from '@/core/wx-subscribe'

/**
 * "Me" tab: who I am under the navy header (avatar, names, dept and roles from /auth/me),
 * then my profile and avatar, the password change and about (subpackage pages-sys), the language
 * (this device and the account's, as on the web), the appearance (not on the mini program), and sign-out.
 * New to-do WeChat alerts on the mini program, while the server offers subscribe templates.
 * Sign-in-only APIs over the caller's own row (see docs/design-notes.md#layering).
 */
const auth = useAuthStore()
const me = computed(() => auth.me)
const avatar = computed(() => (me.value?.user.avatarUrl ? assetUrl(me.value.user.avatarUrl) : ''))
const initial = computed(() => [...(me.value?.user.displayName ?? '')][0]?.toUpperCase() ?? '')
/** dept and roles, one chip each: seeded names are i18n keys */
const chips = computed(() =>
  [me.value?.user.deptName, ...(me.value?.user.roleNames ?? [])]
    .filter((name): name is string => !!name)
    .map(tx),
)
/** manifest.json's versionName */
const version = uni.getAppBaseInfo().appVersion ?? ''

const open = (page: 'profile' | 'password' | 'about') =>
  uni.navigateTo({ url: `/pages-sys/${page}/index` })

const langOpen = ref(false)
const languages = computed(() => LOCALES.map((value) => ({ name: t(LANGUAGE_KEY[value]), value })))
// account saves run one after another: quick switches never let an earlier PUT land last
let saving: Promise<unknown> = Promise.resolve()

/** Switches now; the account's language (server messages, notifications) follows, silently. */
function pickLocale({ item }: { item: { value: Locale } }) {
  setLocale(item.value)
  uni.setNavigationBarTitle({ title: t('common.tab.mine') })
  const body = { locale: item.value }
  saving = saving
    .then(() => api.put('/iam/profile/locale', body, { silent: true }))
    .catch(() => undefined)
}

// Appearance (App and H5 only): system / light / dark, the current one in the brand colour
const APPEARANCE_KEY: Record<ThemePref, string> = {
  system: 'mine.appearanceSystem',
  light: 'mine.appearanceLight',
  dark: 'mine.appearanceDark',
}
const appearanceOpen = ref(false)
const appearances = computed(() =>
  THEME_PREFS.map((value) => ({
    name: t(APPEARANCE_KEY[value]),
    value,
    description:
      value === 'system'
        ? t('mine.appearanceNow', {
            theme: t(APPEARANCE_KEY[systemIsDark.value ? 'dark' : 'light']),
          })
        : undefined,
    color: value === themePref.value ? 'var(--qw-brand-text)' : undefined,
  })),
)
const pickAppearance = ({ item }: { item: { value: ThemePref } }) => setThemePref(item.value)

/** the two menu groups: me, then this device (label `mine.<name>`) */
interface MenuItem {
  name: string
  icon: IconName
  tone: 'brand' | 'success' | 'warning' | 'neutral'
  value?: string
  go: () => void
}
/** WeChat subscribe template ids (mini program, bound, server switch on); a tap asks WeChat right away */
const remindIds = ref<string[]>([])
const menus = computed<MenuItem[][]>(() => [
  [
    { name: 'profile', icon: 'card', tone: 'brand', go: () => open('profile') },
    { name: 'password', icon: 'lock', tone: 'warning', go: () => open('password') },
    ...(remindIds.value.length
      ? [
          {
            name: 'wxRemind',
            icon: 'bell',
            tone: 'brand',
            go: () => requestSubscribe(remindIds.value),
          } as const,
        ]
      : []),
  ],
  [
    {
      name: 'language',
      icon: 'globe',
      tone: 'success',
      value: t(LANGUAGE_KEY[locale()]),
      go: () => (langOpen.value = true),
    },
    ...(canChooseTheme
      ? [
          {
            name: 'appearance',
            icon: 'theme',
            tone: 'brand',
            value: t(APPEARANCE_KEY[themePref.value]),
            go: () => {
              refreshSystemTheme()
              appearanceOpen.value = true
            },
          } as const,
        ]
      : []),
    { name: 'about', icon: 'info', tone: 'neutral', value: version, go: () => open('about') },
  ],
])

const signingOut = ref(false)
function signOut() {
  if (signingOut.value) return
  uni.showModal({
    title: t('mine.signOut'),
    content: t('mine.signOutConfirm'),
    confirmText: t('mine.signOut'),
    cancelText: t('common.action.cancel'),
    success: async ({ confirm }) => {
      if (!confirm) return
      signingOut.value = true
      // ends the server session and forgets the stored refresh token, whatever the server says
      await auth.logout()
      uni.reLaunch({ url: LOGIN_PAGE, complete: () => (signingOut.value = false) })
    },
  })
}

// the user of this session (a rejected session goes to sign-in: the request layer)
onShow(() => {
  if (!auth.me) auth.fetchMe().catch(() => {})
  void loadSubscribeIds().then((ids) => (remindIds.value = ids))
})
</script>

<style>
.qw-mine__sheet {
  padding-bottom: var(--qw-space-4);
}

/* the header's profile: avatar 64 on the brand gradient with a faint ring, names, dept and role chips */
.qw-mine__card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 26rpx;
  margin-top: 18rpx;
}

.qw-mine__avatar {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 120rpx;
  height: 120rpx;
  border-radius: 50%;
  font-size: 48rpx;
  font-weight: 600;
  color: var(--qw-on-brand);
  background: linear-gradient(135deg, var(--qw-brand), var(--qw-brand-2));
}

/* the ring: on-brand at 16% (opacity, not a mixed colour: §12.2) */
.qw-mine__avatar::after {
  content: '';
  position: absolute;
  top: -6rpx;
  right: -6rpx;
  bottom: -6rpx;
  left: -6rpx;
  border: 6rpx solid var(--qw-on-brand);
  border-radius: 50%;
  opacity: 0.16;
}

.qw-mine__photo {
  width: 100%;
  height: 100%;
  border-radius: 50%;
}

.qw-mine__who {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.qw-mine__name {
  overflow: hidden;
  font-size: var(--qw-fs-title-lg);
  font-weight: 650;
  color: var(--qw-side-active-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qw-mine__username {
  margin-top: 4rpx;
  font-size: var(--qw-fs-body);
  color: var(--qw-side-text);
}

.qw-mine__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
  margin-top: 16rpx;
}

.qw-mine__chip {
  height: 44rpx;
  padding: 0 18rpx;
  border-radius: 999px;
  font-size: var(--qw-fs-micro);
  line-height: 44rpx;
  color: var(--qw-side-text);
  background: var(--qw-side-hover);
}

/* a menu row: 56 high, a 32 icon tile, the label, an optional value, the chevron; lines from the label */
.qw-menu__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 22rpx;
  height: 104rpx;
  padding: 0 22rpx 0 30rpx;
  font-size: var(--qw-fs-body-lg);
  color: var(--qw-text);
}

.qw-menu__item + .qw-menu__item::before {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  left: 112rpx;
  height: 1px;
  background: var(--qw-border);
}

.qw-menu__tile {
  width: 60rpx;
  height: 60rpx;
  border-radius: var(--qw-radius);
}

.qw-menu__label {
  flex: 1;
  min-width: 0;
}

.qw-menu__value {
  font-size: var(--qw-fs-body);
  color: var(--qw-text-3);
  font-variant-numeric: tabular-nums;
}

.qw-menu__chev {
  color: var(--qw-text-3);
}

/* sign-out: a card of its own, the danger colour, centred */
.qw-mine__sign-out {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12rpx;
  height: 97rpx;
  font-size: var(--qw-fs-body-lg);
  font-weight: 500;
  color: var(--qw-danger);
}

.qw-mine__sign-out.is-disabled {
  opacity: 0.6;
  pointer-events: none;
}

.qw-mine__foot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12rpx;
  margin-top: 10rpx;
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-3);
}
</style>
