import { format } from 'echarts/core'
import type { MonitorRedisVo } from '@qiwu/shared'
import type { QwChartOption } from '@/core/components/QwChart.vue'
import { i18n } from '@/core/i18n'
import { bytes, count, percent } from '../format'

// The Redis page's chart options (colors come from QwChart's token theme).

type Info = MonitorRedisVo['info']
const t = (key: string, params: Record<string, unknown> = {}) => i18n.global.t(key, params)
/** a numeric INFO field; 0 when absent */
export const infoNum = (info: Info, section: keyof Info, field: string) =>
  Number(info[section]?.[field]) || 0

/** A ring gauge (no pointer or ticks) showing `value` of `max` with `detail` in the middle. */
function ring(value: number, max: number, detail: string, name: string): QwChartOption {
  return {
    series: [
      {
        type: 'gauge',
        min: 0,
        max,
        radius: '90%',
        progress: { show: true, width: 12, roundCap: true },
        axisLine: { roundCap: true, lineStyle: { width: 12 } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        anchor: { show: false },
        title: { offsetCenter: [0, '32%'], fontSize: 12 },
        detail: {
          offsetCenter: [0, '-6%'],
          fontSize: 20,
          fontWeight: 600,
          formatter: () => detail,
        },
        data: [{ value, name }],
      },
    ],
  }
}

/** Memory in use of `maxmemory`, or of the host's memory when Redis has no limit. */
export function memoryChart(info: Info): QwChartOption {
  const used = infoNum(info, 'memory', 'used_memory')
  const max =
    infoNum(info, 'memory', 'maxmemory') ||
    infoNum(info, 'memory', 'total_system_memory') ||
    Math.max(used, infoNum(info, 'memory', 'used_memory_peak'), 1)
  const pct = percent((used / max) * 100)
  return ring(
    pct,
    100,
    bytes(used),
    t('monitor.redis.ofMax', { percent: `${pct}%`, max: bytes(max) }),
  )
}

/** The next power of ten above `n` (at least 10): the ops gauge's scale. */
export const scaleOf = (n: number) => 10 ** Math.max(1, Math.ceil(Math.log10(n + 1)))

/** Commands per second right now, on a power-of-ten scale. */
export function opsChart(info: Info): QwChartOption {
  const ops = infoNum(info, 'stats', 'instantaneous_ops_per_sec')
  return ring(ops, scaleOf(ops), count(ops), t('monitor.redis.opsUnit'))
}

/** The 10 most called commands, most called on top. */
export function commandChart(stats: MonitorRedisVo['commandStats']): QwChartOption {
  const top = [...stats]
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10)
    .reverse()
  return {
    grid: { left: 8, right: 24, top: 8, bottom: 8 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params) => {
        const p = ([params].flat()[0] ?? {}) as { dataIndex?: number }
        const s = top[p.dataIndex ?? -1]
        // the tooltip is HTML
        return s
          ? t('monitor.redis.commandTip', {
              command: format.encodeHTML(s.command),
              calls: count(s.calls),
              usec: s.usecPerCall.toFixed(2),
            })
          : ''
      },
    },
    xAxis: { type: 'value', minInterval: 1 },
    yAxis: { type: 'category', data: top.map((s) => s.command) },
    series: [
      {
        type: 'bar',
        name: t('field.monitor.redis.calls'),
        data: top.map((s) => s.calls),
        barMaxWidth: 14,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
      },
    ],
  }
}
