<script setup lang="ts">
import { computed, reactive, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { AgentUsageQuery, AgentUsageRowVo } from '@qiwu/shared'
import { agentUsageApi } from '@/api/platform/agent-admin'
import QwChart, { type QwChartOption } from '@/core/components/QwChart.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { openDialog } from '@/core/dialog'
import UsageEntries from './UsageEntries.vue'
import { toastRest } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { useDateRangeShortcuts } from '@/core/date-shortcuts'
import { Icon } from '@/core/icons'

/**
 * 智能体用量按积分汇总，供应商原始 Token 分项和未计价状态单独保留；历史快照不随当前费率重算。
 */
defineOptions({ name: 'AgentUsage' })
const { t } = useI18n()
const shortcuts = useDateRangeShortcuts()
const GROUPS = ['day', 'user', 'model'] as const
const query = reactive<{ range: [string, string]; groupBy: AgentUsageQuery['groupBy'] }>({
  range: [dayjs().subtract(6, 'day').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD')],
  groupBy: 'day',
})
const rows = shallowRef<AgentUsageRowVo[]>([])
const loading = ref(false)
const COUNTS = [
  'calls',
  'unpricedCalls',
  'unreportedCalls',
  'legacyCalls',
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const
const columns: QwColumn[] = [
  { prop: 'label', label: 'agent.admin.usage.key', minWidth: 180, showOverflowTooltip: true },
  { prop: 'credits', label: 'agent.admin.usage.credits', width: 160, align: 'right' },
  ...COUNTS.map((prop) => ({
    prop,
    label: `agent.admin.usage.${prop}`,
    width: 160,
    align: 'right' as const,
    hidden: ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'].includes(
      prop,
    ),
  })),
]
const fmt = (n: number | null) => (n == null ? t('agent.admin.usage.unknown') : n.toLocaleString())

/** 汇总固定精度积分，展示与记账一样不经浮点数相加。 */
function totalCredits() {
  const total = rows.value.reduce((sum, row) => {
    const [whole, fraction = ''] = row.credits.split('.')
    return sum + BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  }, 0n)
  const fraction = (total % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `${total / 1_000_000n}${fraction ? `.${fraction}` : ''}`
}
/** 按当前条件载入；失败由请求层提示。 */
async function search() {
  const [from, to] = query.range ?? []
  if (!from || !to) return
  loading.value = true
  try {
    rows.value = await agentUsageApi.list({ from, to, groupBy: query.groupBy })
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = false
  }
}
void search()

/** 任一分组未知时保留未知，不把部分统计伪装成完整总数。 */
function summary({ columns: visible }: { columns: { property: string }[] }) {
  return visible.map(({ property }, index) => {
    if (!index) return t('agent.admin.usage.total')
    if (property === 'credits') return totalCredits()
    if (!COUNTS.includes(property as (typeof COUNTS)[number])) return ''
    const values = rows.value.map((row) => row[property as (typeof COUNTS)[number]])
    return values.some((value) => value == null)
      ? t('agent.admin.usage.unknown')
      : fmt(values.reduce<number>((sum, value) => sum + value!, 0))
  })
}
const option = computed<QwChartOption>(() => ({
  grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  xAxis: { type: 'category', data: rows.value.map((row) => row.label) },
  yAxis: { type: 'value' },
  series: [
    {
      type: 'bar',
      name: t('agent.admin.usage.credits'),
      data: rows.value.map((row) => Number(row.credits)),
      barMaxWidth: 24,
    },
  ],
}))
/** 当前日期范围内的原始明细与当次费率，无历史重算。 */
const openEntries = () =>
  openDialog(
    UsageEntries,
    { from: query.range[0], to: query.range[1] },
    { title: () => t('agent.admin.usage.entries'), width: 1100, top: '4vh' },
  )
</script>

<template>
  <div class="qw-page">
    <el-card class="qw-search-panel">
      <el-form :model="query" inline @submit.prevent="search">
        <el-form-item :label="t('agent.admin.usage.range')" class="qw-search-wide">
          <el-date-picker
            v-model="query.range"
            type="daterange"
            :shortcuts="shortcuts"
            value-format="YYYY-MM-DD"
            :clearable="false"
          />
        </el-form-item>
        <el-form-item :label="t('agent.admin.usage.groupBy')">
          <el-radio-group v-model="query.groupBy" class="usage__group" @change="search">
            <el-radio-button v-for="g in GROUPS" :key="g" :value="g">
              {{ t(`agent.admin.usage.by.${g}`) }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item class="qw-search-actions">
          <el-button type="primary" plain native-type="submit" :loading="loading">
            <el-icon class="el-icon--left"><Icon icon="lucide:search" /></el-icon>
            {{ t('crud.action.search') }}
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card class="qw-table-panel">
      <QwChart
        v-if="rows.length"
        :option="option"
        :title="t('agent.admin.usage.chart')"
        class="usage__chart"
      />
      <p class="usage__hint">{{ t('agent.admin.usage.hint') }}</p>
      <TableToolbar table-id="agent.usage" :columns="columns" :searchable="false" @refresh="search">
        <el-button @click="openEntries">{{ t('agent.admin.usage.entries') }}</el-button>
      </TableToolbar>
      <QwTable
        table-id="agent.usage"
        :columns="columns"
        :data="rows"
        :loading="loading"
        row-key="key"
        show-summary
        :summary-method="summary"
      >
        <template #cell-credits="{ row }">{{ row.credits }}</template>
        <template v-for="name in COUNTS" :key="name" #[`cell-${name}`]="{ row }">{{
          fmt(row[name])
        }}</template>
      </QwTable>
    </el-card>
  </div>
</template>

<style scoped>
.usage__chart {
  height: 260px;
  margin-bottom: 16px;
}
.usage__hint {
  color: var(--qw-text-3);
  font-size: 12px;
}
</style>
