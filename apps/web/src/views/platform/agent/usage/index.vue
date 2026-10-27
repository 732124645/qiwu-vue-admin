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
import {
  chartPoints,
  formatCredits,
  integrityNotes,
  sumCredits,
  sumTokens,
  topRow,
} from './usage-summary'

/**
 * 智能体用量：顶部几项关键数字、按日 / 用户 / 模型的积分图表与汇总表；未设价格、未返回用量和早期记录
 * 只在“数据完整性”里用通俗的话说明。积分是历史快照，不随当前费率重算；未知的 token 不当作 0。
 */
defineOptions({ name: 'AgentUsage' })
const { t } = useI18n()
const shortcuts = useDateRangeShortcuts()
const GROUPS = ['day', 'user', 'model'] as const
const query = reactive<{ range: [string, string]; groupBy: AgentUsageQuery['groupBy'] }>({
  range: [dayjs().subtract(6, 'day').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD')],
  groupBy: 'day',
})
/** 已载入的数据连同它的查询条件：顶部数字和图表跟着数据走，不跟着还没提交的筛选条件走 */
const loaded = shallowRef<{
  rows: AgentUsageRowVo[]
  groupBy: AgentUsageQuery['groupBy']
  range: [string, string]
}>({ rows: [], groupBy: 'day', range: query.range })
const rows = computed(() => loaded.value.rows)
const loading = ref(false)
const COUNTS = [
  'calls',
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'unpricedCalls',
  'unreportedCalls',
  'legacyCalls',
] as const
/** 默认只显示分组、调用次数、积分与输入 / 输出 token，其余列可在列设置里打开 */
const SHOWN = new Set(['calls', 'promptTokens', 'completionTokens'])
const columns: QwColumn[] = [
  { prop: 'label', label: 'agent.admin.usage.key', minWidth: 180, showOverflowTooltip: true },
  { prop: 'calls', label: 'agent.admin.usage.calls', width: 140, align: 'right' },
  { prop: 'credits', label: 'agent.admin.usage.credits', width: 160, align: 'right' },
  ...COUNTS.filter((prop) => prop !== 'calls').map((prop) => ({
    prop,
    label: `agent.admin.usage.${prop}`,
    width: 160,
    align: 'right' as const,
    hidden: !SHOWN.has(prop),
  })),
]
const fmt = (n: number | null) => (n == null ? t('agent.admin.usage.unknown') : n.toLocaleString())

/** 按当前条件载入；失败由请求层提示。 */
async function search() {
  const [from, to] = query.range ?? []
  if (!from || !to) return
  const groupBy = query.groupBy
  loading.value = true
  try {
    const result = await agentUsageApi.list({ from, to, groupBy })
    loaded.value = { rows: result, groupBy, range: [from, to] }
  } catch (e) {
    toastRest(e)
  } finally {
    loading.value = false
  }
}
void search()

const totalCredits = computed(() => sumCredits(rows.value))
/** 顶部数字：调用次数、积分、输入 / 输出 token、用量最多的一组。 */
const kpis = computed(() => {
  const prompt = sumTokens(rows.value, 'promptTokens')
  const completion = sumTokens(rows.value, 'completionTokens')
  const top = topRow(rows.value)
  return [
    {
      key: 'calls',
      value: rows.value.reduce((sum, row) => sum + row.calls, 0).toLocaleString(),
    },
    { key: 'credits', value: formatCredits(totalCredits.value), title: totalCredits.value },
    {
      key: 'tokens',
      value:
        prompt.known || completion.known
          ? `${prompt.total.toLocaleString()} / ${completion.total.toLocaleString()}`
          : t('agent.admin.usage.unknown'),
      note: prompt.partial || completion.partial ? t('agent.admin.usage.partial') : undefined,
    },
    {
      key: `top.${loaded.value.groupBy}`,
      value: top?.label ?? '-',
      note: top ? t('agent.admin.usage.topCredits', { n: formatCredits(top.credits) }) : undefined,
    },
  ]
})
const notes = computed(() => integrityNotes(rows.value))

/** 任一分组未知时保留未知，不把部分统计伪装成完整总数。 */
function summary({ columns: visible }: { columns: { property: string }[] }) {
  return visible.map(({ property }, index) => {
    if (!index) return t('agent.admin.usage.total')
    if (property === 'credits') return formatCredits(totalCredits.value)
    if (!COUNTS.includes(property as (typeof COUNTS)[number])) return ''
    const values = rows.value.map((row) => row[property as (typeof COUNTS)[number]])
    return values.some((value) => value == null)
      ? t('agent.admin.usage.unknown')
      : fmt(values.reduce<number>((sum, value) => sum + value!, 0))
  })
}
/** 积分柱状图：纵轴标明单位，柱子限宽；按日时补齐范围内每一天，数据少时也不会一根柱子撑满。 */
const option = computed<QwChartOption>(() => {
  const points = chartPoints(rows.value, loaded.value.groupBy, loaded.value.range)
  return {
    grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (v) => formatCredits(Number(v).toFixed(6)),
    },
    xAxis: {
      type: 'category',
      data: points.map((p) => p.label),
      axisLabel: { hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      name: t('agent.admin.usage.creditUnit'),
      minInterval: 0.01,
      axisLabel: { formatter: (v: number) => formatCredits(v.toFixed(6)) },
    },
    series: [
      {
        type: 'bar',
        name: t('agent.admin.usage.credits'),
        data: points.map((p) => p.credits),
        barMaxWidth: 32,
      },
    ],
  }
})
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

    <ul class="usage__kpis">
      <li v-for="k in kpis" :key="k.key" class="usage__kpi" :data-kpi="k.key">
        <span class="usage__kpi-label">{{ t(`agent.admin.usage.kpi.${k.key}`) }}</span>
        <strong class="usage__kpi-value" :title="k.title ?? k.value">{{ k.value }}</strong>
        <span v-if="k.note" class="usage__kpi-note">{{ k.note }}</span>
      </li>
    </ul>

    <el-alert
      v-if="notes.length"
      class="usage__integrity"
      type="info"
      :title="t('agent.admin.usage.integrity.title')"
      :closable="false"
      show-icon
    >
      <ul>
        <li v-for="n in notes" :key="n.kind" :data-integrity="n.kind">
          {{ t(`agent.admin.usage.integrity.${n.kind}`, { n: n.count.toLocaleString() }) }}
        </li>
      </ul>
    </el-alert>

    <el-card class="usage__chart-card">
      <template #header>{{ t(`agent.admin.usage.chartBy.${loaded.groupBy}`) }}</template>
      <QwChart
        v-if="rows.length"
        :option="option"
        :title="t(`agent.admin.usage.chartBy.${loaded.groupBy}`)"
        class="usage__chart"
      />
      <el-empty
        v-else-if="!loading"
        class="usage__empty"
        :image-size="80"
        :description="t('agent.admin.usage.empty')"
      />
    </el-card>

    <el-card class="qw-table-panel">
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
        <template #cell-credits="{ row }"
          ><span :title="row.credits">{{ formatCredits(row.credits) }}</span></template
        >
        <template v-for="name in COUNTS" :key="name" #[`cell-${name}`]="{ row }">{{
          fmt(row[name])
        }}</template>
      </QwTable>
      <p class="usage__hint">{{ t('agent.admin.usage.hint') }}</p>
    </el-card>
  </div>
</template>

<style scoped>
.usage__kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  padding: 0;
  margin: 0 0 16px;
  list-style: none;
}
.usage__kpi {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 16px 20px;
  background: var(--qw-surface);
  border: 1px solid var(--qw-border);
  border-radius: var(--qw-radius);
}
.usage__kpi-label,
.usage__kpi-note {
  font-size: 13px;
  color: var(--qw-text-2);
}
.usage__kpi-note {
  font-size: 12px;
  color: var(--qw-text-3);
}
.usage__kpi-value {
  overflow: hidden;
  font-size: 24px;
  font-weight: 600;
  line-height: 32px;
  color: var(--qw-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage__integrity {
  margin-bottom: 16px;
}
.usage__integrity ul {
  padding-left: 18px;
  margin: 4px 0 0;
}
.usage__chart-card {
  margin-bottom: 16px;
}
.usage__chart,
.usage__empty {
  height: 260px;
}
.usage__empty {
  padding: 0;
}
.usage__hint {
  margin: 12px 0 0;
  color: var(--qw-text-3);
  font-size: 12px;
}
</style>
