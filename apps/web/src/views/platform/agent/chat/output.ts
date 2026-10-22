import type { AgentChartSpec, AgentSource } from '@qiwu/shared'
import type { QwChartOption } from '@/core/components/QwChart.vue'

/** 一个数据点 → 数值：数字照用，数字样的文字转换，其余（含 null）为空。 */
const num = (v: number | string | null | undefined): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const n = typeof v === 'string' && v.trim() ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}

/**
 * 声明式图表 → ECharts 配置（颜色来自 QwChart 的令牌主题）：只读取类别与数值，不执行任何代码、不拼 HTML；
 * 提示框用 richText 模式画在图里，模型给的名字从不作为 HTML 插入页面。表格类不走这里（页面直接渲染表格）。
 */
export function chartOption(spec: AgentChartSpec): QwChartOption {
  const tooltip = { renderMode: 'richText' as const }
  const legend = { show: spec.series.length > 1, bottom: 0, type: 'scroll' as const }
  if (spec.kind === 'pie')
    return {
      tooltip: { ...tooltip, trigger: 'item' },
      legend: { ...legend, show: true },
      series: [
        {
          type: 'pie',
          name: spec.series[0]?.name,
          radius: ['35%', '65%'],
          data: spec.categories.map((name, k) => ({
            name,
            value: num(spec.series[0]?.data[k]) ?? 0,
          })),
        },
      ],
    }
  return {
    tooltip: { ...tooltip, trigger: 'axis' },
    legend,
    grid: {
      left: 8,
      right: 16,
      top: 24,
      bottom: spec.series.length > 1 ? 32 : 8,
      containLabel: true,
    },
    xAxis: { type: 'category', data: spec.categories },
    yAxis: { type: 'value', name: spec.unit },
    series: spec.series.map((s) =>
      spec.kind === 'line'
        ? { type: 'line' as const, name: s.name, data: s.data.map(num) }
        : { type: 'bar' as const, name: s.name, data: s.data.map(num) },
    ),
  }
}

/** 报告 → Markdown 文件内容：标题、正文与编号来源（未核实的只写标题）。 */
export function reportMarkdown(r: { title: string; text: string; citations: AgentSource[] }) {
  const sources = r.citations.map(
    (c, k) => `${k + 1}. ${c.url ? `[${c.title || c.url}](${c.url})` : c.title}`,
  )
  return `# ${r.title}\n\n${r.text.trim()}\n${sources.length ? `\n---\n\n${sources.join('\n')}\n` : ''}`
}

/** 下载用的文件名：去掉文件系统不允许的字符，空的用 `fallback`。 */
export const fileName = (title: string, fallback: string) =>
  title
    .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
    .trim()
    .slice(0, 80) || fallback
