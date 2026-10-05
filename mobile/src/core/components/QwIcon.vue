<template>
  <view class="qw-icon" :style="style" aria-hidden="true" />
</template>

<script lang="ts">
/**
 * Our own line icons (visual-system §12.4: 24 grid, stroke 1.8, round): drawn as a CSS mask over
 * `currentColor`, so one shape serves every token colour and both themes (the mini program renders no inline
 * <svg>). The shapes are this project's own drawings (the design mockups' icon set).
 */
const ICONS = {
  send: "<path d='M20.5 3.5 10.6 13.4M20.5 3.5l-6.3 17-3.6-7.1-7.1-3.6Z'/>",
  calendar:
    "<rect x='4' y='5' width='16' height='15' rx='3'/><path d='M4 10h16M8.5 3v4M15.5 3v4M8.5 14h2M13.5 14h2'/>",
  megaphone:
    "<path d='M4 10v4a1 1 0 0 0 1 1h2l5 4V5L7 9H5a1 1 0 0 0-1 1ZM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11'/>",
  doc: "<rect x='4.5' y='3' width='15' height='18' rx='3.2'/><path d='M8.5 12.2l2.6 2.6 4.6-5.2'/>",
  message:
    "<path d='M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V17h-.5A2.5 2.5 0 0 1 4 14.5Z'/><path d='M8.5 9.5h7M8.5 12.5h4'/>",
  clock: "<circle cx='12' cy='12' r='8.5'/><path d='M12 7.5V12l3 2'/>",
  'chevron-right': "<path d='M9.5 6l6 6-6 6'/>",
  'chevron-left': "<path d='M15 5.5 8.5 12l6.5 6.5'/>",
  'chevron-down': "<path d='M7 10l5 5 5-5'/>",
  more: "<path d='M6 12h.01M12 12h.01M18 12h.01' stroke-width='3.2'/>",
  check: "<path d='M5 12.5l4.5 4.5L19 7.5'/>",
  checks: "<path d='M2.5 12.5 6.5 16.5 14 9M11.5 15.5l1 1L20 9'/>",
  close: "<path d='M6.5 6.5l11 11M17.5 6.5l-11 11'/>",
  undo: "<path d='M9.5 5.5 5 10l4.5 4.5M5.5 10H14a5 5 0 0 1 0 10h-2'/>",
  lock: "<rect x='5' y='10.5' width='14' height='10' rx='2.5'/><path d='M8 10.5V8a4 4 0 0 1 8 0v2.5M12 14.5v2'/>",
  globe:
    "<circle cx='12' cy='12' r='9'/><path d='M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3Z'/>",
  info: "<circle cx='12' cy='12' r='9'/><path d='M12 11v5.5M12 7.6v.2'/>",
  card: "<rect x='3.5' y='5' width='17' height='14' rx='3'/><circle cx='9' cy='10.8' r='2'/><path d='M6.2 15.6a3.2 3.2 0 0 1 5.6 0M14.5 10h3M14.5 13.5h3'/>",
  bell: "<path d='M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15ZM10 20.5a2 2 0 0 0 4 0'/>",
  briefcase:
    "<rect x='3.5' y='7' width='17' height='12.5' rx='2.5'/><path d='M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h17'/>",
  theme:
    "<circle cx='12' cy='12' r='8.5'/><path d='M12 3.5a8.5 8.5 0 0 1 0 17Z' fill='black' stroke='none'/>",
  user: "<circle cx='12' cy='8' r='4'/><path d='M4.5 20c1.4-3.4 4.2-5 7.5-5s6.1 1.6 7.5 5'/>",
  phone: "<rect x='6.5' y='2.5' width='11' height='19' rx='2.5'/><path d='M10.5 18h3'/>",
  shield: "<path d='M12 3l7 3v5.5c0 4.4-3 7.8-7 9.5-4-1.7-7-5.1-7-9.5V6z'/><path d='M9 12l2 2 4-4'/>",
  eye: "<path d='M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z'/><circle cx='12' cy='12' r='3'/>",
  'eye-off':
    "<path d='M3 12s3.3-6 9-6c2 0 3.7.7 5 1.7M21 12s-3.3 6-9 6c-2 0-3.7-.7-5-1.7'/><path d='M9.9 14.1a3 3 0 0 1 4.2-4.2M4 20 20 4'/>",
} as const

export type IconName = keyof typeof ICONS

/** The mask image of `name`. */
export const iconUrl = (name: IconName) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>${ICONS[name]}</svg>`,
  )}")`

export const ICON_NAMES = Object.keys(ICONS) as IconName[]
</script>

<script setup lang="ts">
import { computed, type PropType } from 'vue'

/** `<QwIcon name="send" />`: the colour is the text colour, the size a CSS length (default 40rpx). */
const props = defineProps({
  name: { type: String as PropType<IconName>, required: true },
  size: { type: String, default: '40rpx' },
})

const style = computed(() => {
  const url = iconUrl(props.name)
  return `width:${props.size};height:${props.size};-webkit-mask-image:${url};mask-image:${url}`
})
</script>

<style>
.qw-icon {
  flex: none;
  background-color: currentColor;
  -webkit-mask-position: center;
  mask-position: center;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: contain;
  mask-size: contain;
}
</style>
