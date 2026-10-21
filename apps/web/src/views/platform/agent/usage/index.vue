<script setup lang="ts">
import { computed, reactive, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { AgentUsageQuery, AgentUsageRowVo } from '@qiwu/shared'
import { agentUsageApi } from '@/api/platform/agent-admin'
import QwChart, { type QwChartOption } from '@/core/components/QwChart.vue'
import QwTable from '@/core/components/QwTable.vue'
import TableToolbar from '@/core/components/TableToolbar.vue'
import { toastRest } from '@/core/composables/use-crud'
import type { QwColumn } from '@/core/composables/use-table-prefs'
import { useDateRangeShortcuts } from '@/core/date-shortcuts'
import { Icon } from '@/core/icons'

/**
 * 智能体用量：选日期范围与分组（按日、用户或模型），表格列出调用次数与输入 / 输出 token，
 * 末行合计；上方柱状图按分组堆叠输入与输出 token。
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
const columns: QwColumn[] = [
  { prop: 'label', label: 'agent.admin.usage.key', minWidth: 180, showOverflowTooltip: true },
  { prop: 'calls', label: 'agent.admin.usage.calls', width: 120, align: 'right' },
  { prop: 'promptTokens', label: 'agent.admin.usage.promptTokens', width: 160, align: 'right' },
  {
    prop: 'completionTokens',
    label: 'agent.admin.usage.completionTokens',
    width: 160,
    align: 'right',
  },
  { prop: 'total', label: 'agent.admin.usage.totalTokens', width: 160, align: 'right' },
]
const NUM = ['calls', 'promptTokens', 'completionTokens'] as const
const fmt = (n: number) => n.toLocaleString()

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

/** 合计行：首列“合计”，数字列求和，末列为输入与输出之和。 */
function summary() {
  const sum = Object.fromEntries(
    NUM.map((k) => [k, rows.value.reduce((s, r) => s + r[k], 0)]),
  ) as Record<(typeof NUM)[number], number>
  return [
    t('agent.admin.usage.total'),
    fmt(sum.calls),
    fmt(sum.promptTokens),
    fmt(sum.completionTokens),
    fmt(sum.promptTokens + sum.completionTokens),
  ]
}

const option = computed<QwChartOption>(() => ({
  grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  legend: { top: 0 },
  xAxis: { type: 'category', data: rows.value.map((r) => r.label) },
  yAxis: { type: 'value', minInterval: 1 },
  series: (['promptTokens', 'completionTokens'] as const).map((k) => ({
    type: 'bar' as const,
    stack: 'tokens',
    name: t(`agent.admin.usage.${k}`),
    data: rows.value.map((r) => r[k]),
    barMaxWidth: 24,
  })),
}))
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
      <TableToolbar
        table-id="agent.usage"
        :columns="columns"
        :searchable="false"
        @refresh="search"
      />
      <QwTable
        table-id="agent.usage"
        :columns="columns"
        :data="rows"
        :loading="loading"
        row-key="key"
        show-summary
        :summary-method="summary"
      >
        <template #cell-calls="{ row }">{{ fmt(row.calls) }}</template>
        <template #cell-promptTokens="{ row }">{{ fmt(row.promptTokens) }}</template>
        <template #cell-completionTokens="{ row }">{{ fmt(row.completionTokens) }}</template>
        <template #cell-total="{ row }">{{
          fmt(row.promptTokens + row.completionTokens)
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
</style>
