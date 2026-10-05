<script setup lang="ts">
import type { I18nText } from '@qiwu/shared'
import { localized } from '@/core/i18n'

/**
 * The frame of an iframe menu page (`link_type=iframe`; see docs/design-notes.md#layering): AppLayout renders one per shown or
 * kept-alive page, with the page's URL and name as props.
 */
defineOptions({ name: 'IframeView' })
const { src, title, titleI18n } = defineProps<{
  src: string
  /** the menu name: i18n key or plain text */
  title: string
  titleI18n?: I18nText | null
}>()
</script>

<template>
  <iframe :src :title="localized(titleI18n, title)" class="iframe-view" />
</template>

<style scoped>
.iframe-view {
  width: 100%;
  height: 100%;
  min-height: 480px;
  border: 0;
}
</style>
