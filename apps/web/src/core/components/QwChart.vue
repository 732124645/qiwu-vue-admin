<script lang="ts">
import type { ComposeOption } from 'echarts/core'
import type { BarSeriesOption, GaugeSeriesOption } from 'echarts/charts'
import type {
  AriaComponentOption,
  GridComponentOption,
  TitleComponentOption,
  TooltipComponentOption,
} from 'echarts/components'

/** What QwChart draws: the series and components it registers (add both here for a new chart kind). */
export type QwChartOption = ComposeOption<
  | BarSeriesOption
  | GaugeSeriesOption
  | AriaComponentOption
  | GridComponentOption
  | TitleComponentOption
  | TooltipComponentOption
>
</script>

<script setup lang="ts">
import { computed, nextTick, shallowRef, watch } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { BarChart, GaugeChart } from 'echarts/charts'
import { AriaComponent, GridComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { chartLocale } from '@/core/i18n'
import { useAppStore } from '@/core/stores/app'

// ECharts on demand: only what the app's charts use; SVG keeps text crisp and in the DOM
use([
  SVGRenderer,
  BarChart,
  GaugeChart,
  AriaComponent,
  GridComponent,
  TitleComponent,
  TooltipComponent,
])

/**
 * An ECharts chart (vue-echarts) in the design's colors: palette and text from the `--qw-*` tokens, read
 * again when dark mode or the theme color changes; ECharts' own texts in the page's language
 * (`chartLocale`: a language switch rebuilds the chart). `title` names the chart for screen readers (the
 * generated aria description, §9); the card shows its own heading. Size it with a class on the element.
 */
defineOptions({ name: 'QwChart' })
const { option, title } = defineProps<{ option: QwChartOption; title: string }>()

function tokenTheme() {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(`--qw-${name}`).trim()
  const line = { lineStyle: { color: v('border') } }
  const axis = {
    axisLine: line,
    axisTick: line,
    splitLine: line,
    axisLabel: { color: v('text-3') },
  }
  return {
    color: [v('brand'), v('success'), v('warning'), v('danger'), v('neutral')],
    backgroundColor: 'transparent',
    textStyle: { color: v('text-2'), fontFamily: v('font') },
    categoryAxis: axis,
    valueAxis: axis,
    tooltip: {
      backgroundColor: v('surface'),
      borderColor: v('border'),
      textStyle: { color: v('text') },
    },
    gauge: {
      axisLine: { lineStyle: { color: [[1, v('surface-2')]] } },
      splitLine: { lineStyle: { color: v('text-3') } },
      axisTick: { lineStyle: { color: v('border') } },
      axisLabel: { color: v('text-3') },
      detail: { color: v('text') },
      title: { color: v('text-2') },
    },
  }
}
const app = useAppStore()
const theme = shallowRef(tokenTheme())
// after the flush that switched `html.dark` / the brand tokens
watch(
  () => [app.dark, app.settings.primary],
  () => nextTick(() => (theme.value = tokenTheme())),
)
const merged = computed(() => ({
  ...option,
  title: { text: title, show: false },
  aria: { enabled: true },
}))
</script>

<template>
  <VChart
    :key="chartLocale"
    :option="merged"
    :theme
    :init-options="{ locale: chartLocale, renderer: 'svg' }"
    autoresize
  />
</template>
