<script setup lang="ts">
import { RouterView } from 'vue-router'
import DialogHost from '@/core/dialog/DialogHost.vue'
import { elementLocale } from '@/core/i18n'
import { useAppStore } from '@/core/stores/app'

// applies the saved theme color, dark and grey mode from the first render
const app = useAppStore()
</script>

<template>
  <el-config-provider :locale="elementLocale" :size="app.settings.size">
    <RouterView />
    <!-- openDialog() dialogs, inside the providers so they share the app's config -->
    <DialogHost />
  </el-config-provider>
</template>

<style>
body {
  margin: 0;
  font-family: var(--qw-font);
  color: var(--qw-text);
  background: var(--qw-canvas);
  -webkit-font-smoothing: antialiased;
}
/* §9: a visible 2px focus ring on anything interactive (Element Plus parts in styles/element.css) */
:focus-visible {
  outline: 2px solid var(--qw-brand-text);
  outline-offset: 2px;
}
/* a page: its content blocks 16px apart (§4) */
.qw-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.qw-page-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
}
.qw-page-bar__context {
  margin-right: auto;
}
/* §8: no movement for people who asked for less of it; state changes stay instant */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
  }
}
/* grey mode; a filter on the root element keeps fixed-position popups in place */
html.qw-grey {
  filter: grayscale(1);
}
</style>
