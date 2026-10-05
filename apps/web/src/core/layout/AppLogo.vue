<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import BrandMark from './BrandMark.vue'

/** Mark + app name linking home, on the side bar / top bar; `collapsed` keeps only the mark. */
const { collapsed = false } = defineProps<{ collapsed?: boolean }>()
const { t } = useI18n()
const appTitle = import.meta.env.VITE_APP_TITLE
</script>

<template>
  <router-link
    to="/"
    class="app-logo"
    :class="{ 'app-logo--collapsed': collapsed }"
    :aria-label="appTitle || t('common.app.title')"
  >
    <BrandMark />
    <span v-show="!collapsed" class="app-logo__text">
      <template v-if="appTitle">{{ appTitle }}</template>
      <template v-else>
        {{ t('common.app.name') }}<span class="app-logo__suffix">{{ t('common.app.suffix') }}</span>
      </template>
    </span>
  </router-link>
</template>

<style scoped>
.app-logo {
  display: flex;
  flex: none;
  gap: 10px;
  align-items: center;
  height: 56px;
  padding: 0 18px;
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  color: var(--qw-side-logo-text);
  letter-spacing: 0.01em;
  white-space: nowrap;
  text-decoration: none;
}
/* the zh wordmark (six CJK glyphs, suffix included) needs a touch more air than the Latin tracking */
.app-logo:lang(zh) {
  letter-spacing: 0.04em;
}
.app-logo--collapsed {
  justify-content: center;
  padding: 0;
}
.app-logo:focus-visible {
  outline-offset: -2px;
}
.app-logo__text {
  overflow: hidden;
  text-overflow: ellipsis;
}
.app-logo__suffix {
  font-weight: 400;
  opacity: 0.6;
}
</style>
