<template>
  <view :class="`qw-hdr qw-hdr--${variant}`" :style="`padding-top:${top}`">
    <view class="qw-hdr__glow" />
    <image
      class="qw-hdr__art"
      :src="variant === 'compact' ? '/static/art/wutong-night-nobird.svg' : '/static/art/wutong-night.svg'"
      mode="aspectFit"
      aria-hidden="true"
      :style="`top:calc(${top} - ${ART_LIFT[variant]}px)`"
    />
    <view class="qw-hdr__bar" :style="bar">
      <slot name="bar">
        <text v-if="title" class="qw-hdr__title" role="heading">{{ title }}</text>
      </slot>
    </view>
    <text v-if="sub" class="qw-hdr__sub">{{ sub }}</text>
    <slot />
  </view>
</template>

<script setup lang="ts">
/**
 * A tab page's header (visual-system §12.3): the navy sky with the brand glow and the night parasol tree,
 * under the status bar (the tab pages use custom navigation). The row under the status bar (`#bar`, else
 * `title`) lines up with the mini program's capsule button and leaves its width free; `sub` and the default
 * slot follow (slot texts: App.vue's `.qw-hdr__title` / `.qw-hdr__sub`, white on the navy). Leaves 24px at
 * the bottom for the page's `.qw-sheet` to cover.
 * Variants: `compact` (approvals, messages: branch only, smaller), `hero` (workbench: with the bird),
 * `profile` (me: the bird further right, room for the profile).
 */
defineOptions({ options: { virtualHost: true } })
withDefaults(
  defineProps<{ variant?: 'compact' | 'hero' | 'profile'; title?: string; sub?: string }>(),
  { variant: 'compact' },
)

/** how far the art starts above the bar (the mockups' offsets) */
const ART_LIFT = { compact: 20, hero: 24, profile: 10 }

const platform = process.env.UNI_PLATFORM
const statusBar = platform === 'h5' ? 0 : (uni.getWindowInfo().statusBarHeight ?? 0)
/** H5 has no status bar to measure: the safe area */
const top = platform === 'h5' ? 'env(safe-area-inset-top)' : `${statusBar}px`

/** the mini program's capsule: same row, same height, its width (and a gap) kept free */
let bar = ''
if (platform === 'mp-weixin') {
  const menu = uni.getMenuButtonBoundingClientRect()
  const height = (menu.top - statusBar) * 2 + menu.height
  bar = `height:${height}px;padding-right:${uni.getWindowInfo().windowWidth - menu.left + 8}px`
}
</script>

<style>
.qw-hdr {
  position: relative;
  overflow: hidden;
  padding-right: var(--qw-space-4);
  padding-bottom: calc(24px + var(--qw-space-4));
  padding-left: var(--qw-space-4);
  color: var(--qw-side-active-text);
  background: var(--qw-side-bg);
}

.qw-hdr--profile {
  padding-bottom: calc(24px + var(--qw-space-5));
}

/* §12.7: the one light of the header, only inside it */
.qw-hdr__glow {
  position: absolute;
  top: -280rpx;
  right: -205rpx;
  width: 709rpx;
  height: 709rpx;
  border-radius: 50%;
  background: radial-gradient(closest-side, var(--qw-brand), transparent);
  opacity: 0.5;
}

.qw-hdr__art {
  position: absolute;
  right: -11rpx;
  width: 422rpx;
  height: 382rpx;
}

.qw-hdr--compact .qw-hdr__art {
  right: -7rpx;
  width: 328rpx;
  height: 299rpx;
}

.qw-hdr--profile .qw-hdr__art {
  right: -82rpx;
}

.qw-hdr__bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 20rpx;
  box-sizing: border-box;
  height: 44px;
}

/* .qw-hdr__title / .qw-hdr__sub: App.vue (global: pages use them in the slots too) */
</style>
