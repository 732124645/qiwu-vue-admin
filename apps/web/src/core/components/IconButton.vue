<script setup lang="ts">
import { Icon } from '@/core/icons'

/**
 * Icon-only ghost button with its accessible name (§9: pass an i18n `label`); also works as the trigger of
 * an el-dropdown / el-popover. Other attributes (aria-pressed, …) fall through to the <button>.
 */
defineOptions({ name: 'IconButton' })
const { icon, label } = defineProps<{ icon: string; label: string }>()
</script>

<template>
  <button type="button" class="icon-button" :aria-label="label" :title="label">
    <Icon :icon class="icon-button__icon" />
  </button>
</template>

<style scoped>
.icon-button {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  color: var(--qw-text-2);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--qw-radius-sm);
  transition:
    color 0.15s,
    background-color 0.15s;
}
/* pressed (a toggle that is on) looks like hover: the accent stays for actions */
.icon-button:hover,
.icon-button[aria-expanded='true'],
.icon-button[aria-pressed='true'] {
  color: var(--qw-text);
  background: var(--qw-surface-2);
}
.icon-button__icon {
  width: 18px;
  height: 18px;
}
</style>
