<script setup lang="ts">
/** Original Nested Tile artwork: an open frame and module on a theme-colored tile. */
const { size = 28 } = defineProps<{ size?: number }>()
</script>

<template>
  <span class="brand-mark" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <template v-if="size <= 20">
        <path d="M10 6H9A3 3 0 0 0 6 9V15A3 3 0 0 0 9 18H15A3 3 0 0 0 18 15V14" stroke-width="3" />
        <rect x="13.5" y="4.5" width="6" height="6" rx="1.5" fill="currentColor" stroke="none" />
      </template>
      <template v-else>
        <path
          d="M10.25 6.25 H9.25 A3 3 0 0 0 6.25 9.25 V14.75 A3 3 0 0 0 9.25 17.75 H14.75 A3 3 0 0 0 17.75 14.75 V13.75"
          stroke-width="2.5"
        />
        <rect x="13.5" y="5" width="5.5" height="5.5" rx="1.5" fill="currentColor" stroke="none" />
      </template>
    </svg>
  </span>
</template>

<style scoped>
.brand-mark {
  display: inline-grid;
  flex: none;
  place-items: center;
  color: var(--qw-on-brand);
  background: var(--qw-brand);
  /* toward a lighter, cyan-leaning tone of whatever the theme color is */
  background: linear-gradient(
    135deg,
    var(--qw-brand),
    oklch(from var(--qw-brand) calc(l + 0.16) c calc(h - 28))
  );
  border-radius: 30%;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--qw-on-brand) 14%, transparent);
}
.brand-mark svg {
  width: 100%;
  height: 100%;
}
</style>
