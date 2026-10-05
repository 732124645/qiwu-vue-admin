<template>
  <view
    :class="['qw-login', { 'is-compact': isCompact, 'is-kb': kb > 0, 'is-fixed': compact }]"
    :style="`padding-bottom:${kb}px`"
  >
    <view class="qw-login__glow" />
    <view class="qw-login__sea" />
    <view class="qw-login__hero" :style="`padding-top:${top}`">
      <view
        v-if="back"
        class="qw-login__back"
        role="button"
        :aria-label="t('common.action.back')"
        :style="`top:${top}`"
        @click="goBack"
      >
        <QwIcon name="chevron-left" size="44rpx" />
      </view>
      <image
        class="qw-login__art"
        src="/static/art/wutong-night.svg"
        mode="aspectFit"
        aria-hidden="true"
        :style="`top:calc(${top} + 11rpx)`"
      />
      <view
        v-if="motto.length"
        class="qw-login__motto"
        aria-hidden="true"
        :style="`top:calc(${top} + 93rpx)`"
      >
        <view class="qw-login__motto-line" />
        <text v-for="(glyph, i) in motto" :key="i">{{ glyph }}</text>
      </view>
      <view class="qw-login__brand">
        <view class="qw-login__brand-row">
          <QwBrandMark :size="isCompact ? '67rpx' : '96rpx'" />
          <text :class="['qw-login__wordmark', { 'is-latin': locale() !== 'zh-CN' }]">
            {{ title || t('common.app.name') }}
          </text>
        </view>
        <text class="qw-login__slogan">{{ t('login.slogan') }}</text>
      </view>
    </view>
    <view class="qw-login__sheet">
      <view class="qw-login__tabs" role="tablist">
        <view
          v-for="item in TABS"
          :key="item.value"
          :class="['qw-login__tab', { 'is-active': tab === item.value }]"
          role="tab"
          :aria-selected="tab === item.value"
          @click="emit('update:tab', item.value)"
        >
          {{ t(item.label) }}
        </view>
      </view>
      <text v-if="sub && !kb" class="qw-login__sub">{{ sub }}</text>
      <view class="qw-login__forms">
        <slot />
      </view>
      <view v-if="!kb">
        <slot name="foot" />
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import QwBrandMark from '@/core/components/QwBrandMark.vue'
import QwIcon from '@/core/components/QwIcon.vue'
import { locale, t } from '@/core/i18n'
import { whiteStatusBar } from '@/core/theme'

/**
 * The sign-in screens' frame (visual-system §12; the V2 navy mockup): the navy sky with the night parasol
 * tree, the motto (zh only) and the brand over a bottom sheet with the title tabs (password / SMS), `sub`, the
 * forms (default slot) and the footer (`foot`). Compact (mark and name on one row, the tree shrunk to the top
 * right): while the keyboard is up (the sheet rides on it: inputs use adjust-position false), on windows under
 * 700 high, or always with `compact` (the WeChat bind page, whose `title` replaces the name). `back`: a back
 * button at the top left (custom navigation has no native one; the mini program's capsule is on the right).
 */
const props = defineProps<{
  tab: 'password' | 'sms'
  sub?: string
  title?: string
  compact?: boolean
  back?: boolean
}>()
const emit = defineEmits<{ 'update:tab': [tab: 'password' | 'sms'] }>()

const TABS = [
  { value: 'password', label: 'login.passwordTab' },
  { value: 'sms', label: 'login.smsTab' },
] as const

/** the motto: one glyph per row (no writing-mode); the English text is empty, so no motto */
const motto = computed(() => Array.from(t('login.motto')))

const platform = process.env.UNI_PLATFORM
/** under the status bar (custom navigation); H5 has none to measure: the safe area (as QwPageHeader) */
const top =
  platform === 'h5' ? 'env(safe-area-inset-top)' : `${uni.getWindowInfo().statusBarHeight ?? 0}px`

const goBack = () => uni.navigateBack()

// App: white status bar text on the navy, whatever the theme (core/theme.ts); a closure per instance (uni
// binds a hook function to the first page that registers it)
onShow(() => whiteStatusBar())

const kb = ref(0)
const short = ref(uni.getWindowInfo().windowHeight < 700)
const isCompact = computed(() => props.compact || short.value || kb.value > 0)

// #ifdef H5
// the visual viewport shrinks under the on-screen keyboard; a smaller change is browser chrome, not a keyboard
const view = window.visualViewport
const measure = () => {
  const gone = window.innerHeight - (view?.height ?? window.innerHeight)
  kb.value = gone > 120 ? Math.round(gone) : 0
  short.value = window.innerHeight < 700
}
;(view ?? window).addEventListener('resize', measure)
onUnmounted(() => (view ?? window).removeEventListener('resize', measure))
// #endif
// #ifndef H5
const onKeyboard = ({ height }: { height: number }) => (kb.value = height)
uni.onKeyboardHeightChange(onKeyboard)
onUnmounted(() => uni.offKeyboardHeightChange(onKeyboard))
// #endif
</script>

<style>
/* 402pt = 750rpx: the mockup's points x 1.866 */
.qw-login {
  position: relative;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100vh;
  overflow: hidden;
  background: var(--qw-side-bg);
  transition: padding 250ms var(--qw-ease-enter);
}

/* the sky: one brand glow top right, a deeper sea toward the sheet (opacity, not mixed colours) */
.qw-login__glow,
.qw-login__sea {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  opacity: 0.5;
  pointer-events: none;
}

.qw-login__glow {
  background: radial-gradient(120% 70% at 85% 0%, var(--qw-brand), transparent 70%);
}

.qw-login__sea {
  background: linear-gradient(180deg, transparent 30%, var(--qw-brand) 120%);
}

.qw-login__hero {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  justify-content: flex-end;
  min-height: 0;
  padding: 0 52rpx 56rpx;
}

/* 44 square (at least 44px: §12.2), white on navy, above the tree */
.qw-login__back {
  position: absolute;
  left: 12rpx;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: max(82rpx, 44px);
  height: max(82rpx, 44px);
  color: var(--qw-side-active-text);
}

/* the tab headers' night tree, larger; shrinks toward its top right corner */
.qw-login__art {
  position: absolute;
  right: -15rpx;
  width: 541rpx;
  height: 491rpx;
  transform-origin: 100% 0;
  transition: transform 250ms var(--qw-ease-enter);
  pointer-events: none;
}

.qw-login__motto {
  position: absolute;
  left: 56rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 11rpx;
  font-size: 26rpx;
  line-height: 32rpx;
  color: var(--qw-side-text);
  transition: opacity 200ms;
}

.qw-login__motto-line {
  width: 1px;
  height: 41rpx;
  margin-bottom: 11rpx;
  background: currentColor;
  opacity: 0.5;
}

.qw-login__brand {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 19rpx;
}

.qw-login__brand-row {
  display: flex;
  align-items: center;
  gap: 26rpx;
}

.qw-login__wordmark {
  font-size: 71rpx;
  font-weight: 650;
  line-height: 82rpx;
  letter-spacing: 0.08em;
  color: var(--qw-side-active-text);
}

.qw-login__wordmark.is-latin {
  letter-spacing: 0.01em;
}

.qw-login__slogan {
  font-size: var(--qw-fs-body);
  line-height: 41rpx;
  color: var(--qw-side-text);
}

/* compact: keyboard up, a short window, or the bind page */
.is-compact .qw-login__hero {
  justify-content: center;
  padding-bottom: 11rpx;
}

.is-compact .qw-login__art {
  transform: scale(0.46);
}

.is-compact .qw-login__motto {
  opacity: 0;
}

.is-compact .qw-login__brand-row {
  gap: 19rpx;
}

.is-compact .qw-login__wordmark {
  font-size: var(--qw-fs-title-lg);
  line-height: 60rpx;
}

.is-compact .qw-login__slogan {
  display: none;
}

/* the bind page: a header as high as the shrunk tree, the sheet takes the rest */
.is-fixed .qw-login__hero {
  flex: none;
  box-sizing: content-box;
  height: 258rpx;
}

.is-fixed .qw-login__sheet {
  flex: 1;
}

.qw-login__sheet {
  position: relative;
  flex: none;
  padding: 48rpx 44rpx 16rpx;
  padding-bottom: max(16rpx, env(safe-area-inset-bottom));
  border-radius: var(--qw-radius-xl) var(--qw-radius-xl) 0 0;
  color: var(--qw-text);
  background: var(--qw-surface);
  box-shadow: var(--qw-shadow-up);
}

.is-kb .qw-login__sheet {
  padding-bottom: 30rpx;
}

.qw-login__tabs {
  display: flex;
  align-items: flex-end;
  gap: 48rpx;
  height: max(82rpx, 44px);
}

.qw-login__tab {
  position: relative;
  display: flex;
  align-items: flex-end;
  box-sizing: border-box;
  height: max(82rpx, 44px);
  padding-bottom: 15rpx;
  font-size: var(--qw-fs-body-lg);
  font-weight: 500;
  line-height: 45rpx;
  color: var(--qw-text-2);
  transition:
    font-size 150ms,
    color 150ms;
}

.qw-login__tab.is-active {
  padding-bottom: 11rpx;
  font-size: var(--qw-fs-title-lg);
  font-weight: 650;
  line-height: 56rpx;
  color: var(--qw-text);
}

.qw-login__tab.is-active::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  width: 38rpx;
  height: 8rpx;
  border-radius: 4rpx;
  background: var(--qw-brand);
}

.qw-login__sub {
  display: block;
  margin-top: 19rpx;
  font-size: var(--qw-fs-body);
  line-height: 41rpx;
  color: var(--qw-text-3);
}

/* both tabs' forms keep the password form's height: switching does not move the sky */
.qw-login__forms {
  min-height: 437rpx;
  margin-top: 37rpx;
}

@media (prefers-reduced-motion: reduce) {
  .qw-login,
  .qw-login__art,
  .qw-login__motto,
  .qw-login__tab {
    transition: none;
  }
}
</style>
