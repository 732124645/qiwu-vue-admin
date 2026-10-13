<template>
  <view
    :class="['qw-mark', { 'is-logo': logo }]"
    :style="`width:${size};height:${size}`"
    aria-hidden="true"
  >
    <image class="qw-mark__glyph" :src="logo || '/static/brand/mark-white.svg'" mode="aspectFit" />
  </view>
</template>

<script setup lang="ts">
/**
 * The brand mark (visual-system §10, §12.3; the web's BrandMark): the white Nested Tile on the brand gradient,
 * corners 30%, a faint inner ring and the brand glow. Decorative: the name next to it is the text. `logo`: a
 * tenant's logo instead, on the surface colour (readable on the navy as on the sheet).
 */
defineOptions({ options: { virtualHost: true } })
withDefaults(defineProps<{ size?: string; logo?: string }>(), { size: '96rpx', logo: '' })
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

.qw-mark.is-logo {
  overflow: hidden;
  background: var(--qw-surface);
  box-shadow: var(--qw-shadow-1);
}

.qw-mark.is-logo::after {
  border-color: var(--qw-border);
  opacity: 1;
}

.qw-mark.is-logo .qw-mark__glyph {
  width: 80%;
  height: 80%;
}
</style>
