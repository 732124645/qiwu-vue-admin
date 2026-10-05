<script setup lang="ts">
import { useI18n } from 'vue-i18n'

/**
 * Nothing to show (§5): a line drawing, a title (default "no data"), an optional description and an
 * optional action in the default slot. Used for empty tables, searches without results and no access.
 */
defineOptions({ name: 'EmptyState' })
const { title, description } = defineProps<{ title?: string; description?: string }>()
const { t } = useI18n()
</script>

<template>
  <div class="empty-state">
    <!-- original artwork: an open tray with two sheets lifted out -->
    <svg class="empty-state__art" viewBox="0 0 120 96" aria-hidden="true">
      <ellipse class="empty-state__shade" cx="60" cy="86" rx="38" ry="4" />
      <path class="empty-state__rim" d="M22 58l8-12h60l8 12" />
      <rect
        class="empty-state__paper"
        x="46"
        y="12"
        width="40"
        height="50"
        rx="5"
        transform="rotate(9 66 37)"
      />
      <rect class="empty-state__paper" x="36" y="18" width="40" height="50" rx="5" />
      <path class="empty-state__lines" d="M44 31h22M44 39h24M44 47h14" />
      <path
        class="empty-state__tray"
        d="M22 58h20l4 7h28l4-7h20v17a6 6 0 0 1-6 6H28a6 6 0 0 1-6-6z"
      />
      <path class="empty-state__spark" d="M97 14v8M93 18h8" />
      <circle class="empty-state__dot" cx="22" cy="30" r="2.5" />
      <circle class="empty-state__dot" cx="104" cy="38" r="1.5" />
    </svg>
    <p class="empty-state__title">{{ title ?? t('common.empty.title') }}</p>
    <p v-if="description" class="empty-state__desc">{{ description }}</p>
    <div v-if="$slots.default" class="empty-state__action"><slot /></div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 32px 16px;
  text-align: center;
}
.empty-state__art {
  width: 120px;
  height: 96px;
  margin-bottom: 12px;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.6;
}
.empty-state__shade {
  fill: var(--qw-border);
  opacity: 0.7;
}
.empty-state__paper {
  fill: var(--qw-surface);
  stroke: var(--qw-text-3);
}
.empty-state__lines {
  stroke: var(--qw-border);
  stroke-width: 2.4;
}
.empty-state__tray {
  fill: var(--qw-surface-2);
  stroke: var(--qw-text-3);
}
.empty-state__rim {
  stroke: var(--qw-text-3);
}
.empty-state__spark {
  stroke: var(--qw-brand);
}
.empty-state__dot {
  fill: var(--qw-brand-weak);
  stroke: var(--qw-brand);
  stroke-width: 1.2;
}
.empty-state__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 22px;
  color: var(--qw-text);
}
.empty-state__desc {
  max-width: 36ch;
  text-wrap: balance;
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--qw-text-3);
}
.empty-state__action {
  margin-top: 16px;
}
</style>
