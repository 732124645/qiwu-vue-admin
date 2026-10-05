<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { CronElementPlus } from '@vue-js-cron/element-plus'
import '@vue-js-cron/element-plus/dist/element-plus.css'
import { CRON_NEXT_COUNT } from '@qiwu/shared'
import { describeCron, useNextFireTimes } from '@/core/composables/use-cron'

/**
 * Cron field: `v-model` = a cron of 6 fields, seconds first. The @vue-js-cron picker builds
 * the usual schedules from the fields below (numbers and `* , - /` only, which the server's cron takes;
 * checked in cron-editor.spec); the text box takes any other the server accepts. Below them: the cron in
 * words (cronstrue, current locale) and the next fire times the server computes for it. A blank field
 * starts at every day at midnight, so the picker never shows a schedule the model does not hold.
 * The picker renders Element Plus by tag name: main.ts registers the five components it uses.
 */
defineOptions({ name: 'CronEditor' })
const { disabled = false } = defineProps<{ disabled?: boolean }>()
const model = defineModel<string>({ default: '' })
const { t, locale } = useI18n()

const DEFAULT_CRON = '0 0 0 * * *'

// The picker's crontab fields plus seconds, spelled out: its `format` option object would do the same
// but fails the component's own `format: String` prop check (a dev warning on every render).
type Label = (n: number) => string
const items = (from: number, to: number, text: Label = String, alt = text) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i).map((value) => ({
    value,
    text: text(value),
    alt: alt(value),
  }))
const pad = (n: number) => String(n).padStart(2, '0')
const fields = computed(() => {
  const month = (style: 'long' | 'short') => (m: number) =>
    new Date(2021, m - 1, 1).toLocaleDateString(locale.value, { month: style })
  // 2021-01-03 was a Sunday: weekday 0
  const weekday = (style: 'long' | 'short') => (d: number) =>
    new Date(2021, 0, 3 + d).toLocaleDateString(locale.value, { weekday: style })
  return [
    { id: 'second', items: items(0, 59, pad) },
    { id: 'minute', items: items(0, 59, pad) },
    { id: 'hour', items: items(0, 23, pad) },
    { id: 'day', items: items(1, 31) },
    { id: 'month', items: items(1, 12, month('long'), month('short')) },
    { id: 'dayOfWeek', items: items(0, 6, weekday('long'), weekday('short')) },
  ]
})
const TIME = ['hour', 'minute', 'second']
const PERIODS = [
  { id: 'q-second', value: [] },
  { id: 'q-minute', value: ['second'] },
  { id: 'q-hour', value: ['minute', 'second'] },
  { id: 'day', value: TIME },
  { id: 'week', value: ['dayOfWeek', ...TIME] },
  { id: 'month', value: ['day', 'dayOfWeek', ...TIME] },
  { id: 'year', value: ['month', 'day', 'dayOfWeek', ...TIME] },
]
if (!model.value.trim() && !disabled) model.value = DEFAULT_CRON

const description = computed(() => describeCron(model.value))
const { times, error, loading } = useNextFireTimes(model)
</script>

<template>
  <div class="cron-editor">
    <!-- keyed by the locale: the picker reads its language once -->
    <CronElementPlus
      :key="locale"
      class="cron-editor__picker"
      :model-value="model || DEFAULT_CRON"
      :fields
      :periods="PERIODS"
      :locale
      :disabled
      :button-props="{ size: 'small' }"
      @update:model-value="model = $event"
    />
    <el-input
      v-model="model"
      class="cron-editor__text"
      :disabled
      :placeholder="DEFAULT_CRON"
      :aria-label="t('cron.expression')"
    />
    <p class="cron-editor__desc">{{ description || t('cron.fields') }}</p>
    <div class="cron-editor__next" aria-live="polite">
      <span class="cron-editor__label">{{ t('cron.next', { count: CRON_NEXT_COUNT }) }}</span>
      <span v-if="error" class="cron-editor__error">{{ error }}</span>
      <ol v-else v-loading="loading" class="cron-editor__times">
        <li v-for="time in times" :key="time">{{ dayjs(time).format('YYYY-MM-DD HH:mm:ss') }}</li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.cron-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  line-height: 24px;
}
.cron-editor__picker {
  color: var(--qw-text-2);
}
.cron-editor__text :deep(input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.cron-editor__desc,
.cron-editor__label {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
.cron-editor__desc {
  color: var(--qw-text-2);
}
.cron-editor__next {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cron-editor__error {
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-danger);
}
.cron-editor__times {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  min-height: 18px;
  margin: 0;
  padding: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-2);
  font-variant-numeric: tabular-nums;
  list-style: none;
}
</style>
