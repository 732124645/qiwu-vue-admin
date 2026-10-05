<template>
  <view class="qw-mark" :style="`width:${size};height:${size}`" aria-hidden="true">
    <image class="qw-mark__glyph" src="/static/brand/mark-white.svg" mode="aspectFit" />
  </view>
</template>

<script setup lang="ts">
/**
 * The brand mark (visual-system §10, §12.3; the web's BrandMark): the white Nested Tile on the brand gradient,
 * corners 30%, a faint inner ring and the brand glow. Decorative: the name next to it is the text.
 */
defineOptions({ options: { virtualHost: true } })
withDefaults(defineProps<{ size?: string }>(), { size: '96rpx' })
</script>

<style>
.qw-mark {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 30%;
  background: linear-gradient(135deg, var(--qw-brand), var(--qw-brand-2));
  box-shadow: var(--qw-shadow-brand);
}

/* the inner ring: on-brand at 14% (opacity, not a mixed colour: §12.2) */
.qw-mark::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  border: 1px solid var(--qw-on-brand);
  border-radius: inherit;
  opacity: 0.14;
}

.qw-mark__glyph {
  width: 100%;
  height: 100%;
}
</style>
