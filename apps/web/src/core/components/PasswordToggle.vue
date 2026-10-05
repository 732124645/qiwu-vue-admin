<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Icon } from '@/core/icons'

/**
 * el-input's show-password eye is a bare clickable icon (no name, not focusable). Rendered in its
 * `#password-icon` slot this is a named toggle button; the click still reaches el-input's own handler:
 * `<template #password-icon="{ visible }"><PasswordToggle :visible /></template>`.
 */
const { visible } = defineProps<{ visible: boolean }>()
const { t } = useI18n()
</script>

<template>
  <button
    type="button"
    class="password-toggle"
    :aria-label="t('common.form.showPassword')"
    :aria-pressed="visible"
  >
    <Icon :icon="visible ? 'lucide:eye' : 'lucide:eye-off'" />
  </button>
</template>

<style scoped>
.password-toggle {
  display: inline-flex;
  padding: 0;
  font-size: inherit;
  color: inherit;
  cursor: pointer;
  background: none;
  border: 0;
}
.password-toggle:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
}
</style>
