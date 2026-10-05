<template>
  <view class="qw-rows">
    <view v-for="(row, i) in rows" :key="i" class="qw-rows__row">
      <view class="qw-rows__head">
        <text class="qw-rows__no">{{ t('approval.dynamic.detail.row', { n: i + 1 }) }}</text>
        <text v-if="!disabled" class="qw-rows__remove" role="button" @click="remove(i)">
          {{ t('approval.dynamic.detail.remove') }}
        </text>
      </view>
      <view v-for="(c, j) in columns" :key="c.prop" :class="`qw-rows__cell qw-rows__cell--${c.prop}`">
        <text class="qw-rows__label">{{ labels[j] }}</text>
        <text v-if="disabled" class="qw-rows__value">{{ row[c.prop] ?? '' }}</text>
        <wd-input
          v-else
          :model-value="row[c.prop] ?? ''"
          :type="c.sum ? 'digit' : 'text'"
          :maxlength="DETAIL_TEXT_MAX"
          @update:model-value="set(i, c.prop, $event)"
        />
      </view>
    </view>
    <view v-if="sums.length" class="qw-rows__total">
      <text>{{ t('approval.dynamic.detail.total') }}</text>
      <text v-for="s in sums" :key="s.sum" class="qw-rows__sum">{{ s.text }}</text>
    </view>
    <wd-button
      v-if="!disabled && rows.length < DETAIL_ROWS_MAX"
      custom-class="qw-rows__add"
      size="small"
      variant="plain"
      icon="add"
      @click="add"
    >
      {{ t('approval.dynamic.detail.add') }}
    </wd-button>
  </view>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  DETAIL_ROWS_MAX,
  DETAIL_TEXT_MAX,
  detailRows,
  detailTotals,
  type DetailColumn,
} from '@qiwu/shared'
import { t } from '@/core/i18n'

/**
 * `qw-detail-table` (the web's QwDetailTable) on the phone: a card per row, a text or (a `sum`
 * column) number input per column, remove / add a row, the totals below. `v-model` = the rows as JSON text
 * (null: none), a number cell as a number; the cells are kept here as typed (a new empty row, "12." while
 * typing), the server keeps what `detailRows` reads and recomputes the totals. `labels`: the column titles.
 */
defineOptions({ options: { virtualHost: true } })
const model = defineModel<string | null>()
const props = withDefaults(
  defineProps<{ columns: DetailColumn[]; labels: string[]; disabled?: boolean }>(),
  { disabled: false },
)

type Row = Record<string, string>
const rows = ref<Row[]>([])
/** the cells as the value holds them: a sum column's number (blank or not one: left out) */
const cells = () =>
  rows.value.map((row) =>
    Object.fromEntries(
      props.columns.flatMap(({ prop, sum }): [string, string | number][] => {
        const v = row[prop]?.trim() ?? ''
        if (!sum) return v ? [[prop, row[prop]!]] : []
        return v && Number.isFinite(Number(v)) ? [[prop, Number(v)]] : []
      }),
    ),
  )
let sent: string | null | undefined
watch(
  model,
  (v) => {
    if (v !== sent)
      rows.value = detailRows(v, props.columns).map((r) =>
        Object.fromEntries(Object.entries(r).map(([k, x]) => [k, String(x)])),
      )
  },
  { immediate: true },
)
function send() {
  sent = rows.value.length ? JSON.stringify(cells()) : null
  model.value = sent
}
function set(i: number, prop: string, v: string) {
  rows.value[i]![prop] = v
  send()
}
function remove(i: number) {
  rows.value.splice(i, 1)
  send()
}
function add() {
  rows.value.push({})
  send()
}

const sums = computed(() => {
  const totals = detailTotals(detailRows(cells(), props.columns), props.columns)
  return props.columns.flatMap((c, j) =>
    c.sum ? [{ sum: c.sum, text: `${props.labels[j] ?? c.prop} ${totals[c.sum]}` }] : [],
  )
})
</script>

<style scoped>
.qw-rows {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.qw-rows__row {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
  padding: 20rpx 24rpx;
  border-radius: var(--qw-radius);
  background: var(--qw-surface-2);
}

.qw-rows__head,
.qw-rows__total {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--qw-space-2);
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-3);
}

.qw-rows__remove {
  color: var(--qw-danger);
}

.qw-rows__label {
  font-size: var(--qw-fs-caption);
  color: var(--qw-text-2);
}

.qw-rows__value,
.qw-rows__sum {
  font-size: var(--qw-fs-body);
  color: var(--qw-text);
  font-variant-numeric: tabular-nums;
  word-break: break-word;
}

.qw-rows__total {
  font-size: var(--qw-fs-body);
  font-weight: 600;
  color: var(--qw-text);
}

:deep(.qw-rows__add) {
  align-self: flex-start;
}
</style>
