<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { WxoaQrcodeStatsVo } from '@qiwu/shared'
import { wxoaQrcodeApi } from '@/api/platform/wxoa/qrcode'
import QwChart, { type QwChartOption } from '@/core/components/QwChart.vue'
import { toastRest } from '@/core/composables/use-crud'

/**
 * Scans and subscribes through QR code `id` per day over the last 7, 30 or 90 days (the server counts
 * the days in the user's time zone), as bars, `openDialog(WxoaQrcodeStats, { id, label })`.
 */
defineOptions({ name: 'WxoaQrcodeStats' })
const { id, label } = defineProps<{ id: number; label: string }>()
const { t } = useI18n()

const RANGES = [7, 30, 90] as const
const days = ref<(typeof RANGES)[number]>(30)
const stats = shallowRef<WxoaQrcodeStatsVo>([])
const loading = ref(false)
let seq = 0
watch(
  days,
  async (n) => {
    const mine = ++seq
    loading.value = true
    try {
      const list = await wxoaQrcodeApi.stats(id, n)
      if (mine === seq) stats.value = list
    } catch (e) {
      if (mine === seq) toastRest(e)
    } finally {
      if (mine === seq) loading.value = false
    }
  },
  { immediate: true },
)

const totals = computed(() =>
  stats.value.reduce(
    (sum, d) => ({ scans: sum.scans + d.scans, subscribes: sum.subscribes + d.subscribes }),
    { scans: 0, subscribes: 0 },
  ),
)
const option = computed<QwChartOption>(() => ({
  grid: { left: 8, right: 16, top: 16, bottom: 8 },
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  xAxis: { type: 'category', data: stats.value.map((d) => d.day.slice(5)) },
  yAxis: { type: 'value', minInterval: 1 },
  series: [
    {
      type: 'bar',
      name: t('wxoa.qrcode.stats.scans'),
      data: stats.value.map((d) => d.scans),
      barMaxWidth: 12,
    },
    {
      type: 'bar',
      name: t('wxoa.qrcode.stats.subscribes'),
      data: stats.value.map((d) => d.subscribes),
      barMaxWidth: 12,
    },
  ],
}))
</script>

<template>
  <div v-loading="loading" class="wxoa-qrcode-stats">
    <div class="wxoa-qrcode-stats__head">
      <el-radio-group v-model="days" size="small">
        <el-radio-button v-for="n in RANGES" :key="n" :value="n">
          {{ t('wxoa.qrcode.stats.days', { days: n }) }}
        </el-radio-button>
      </el-radio-group>
      <!-- the chart's own key: its series take the first two palette colors -->
      <span class="wxoa-qrcode-stats__total" role="status">
        <span class="wxoa-qrcode-stats__key is-scans">
          {{ t('wxoa.qrcode.stats.scansTotal', { count: totals.scans }) }}
        </span>
        <span class="wxoa-qrcode-stats__key is-subscribes">
          {{ t('wxoa.qrcode.stats.subscribesTotal', { count: totals.subscribes }) }}
        </span>
      </span>
    </div>
    <QwChart
      :option="option"
      :title="t('wxoa.qrcode.stats.title', { name: label })"
      class="wxoa-qrcode-stats__chart"
    />
  </div>
</template>

<style scoped>
.wxoa-qrcode-stats {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.wxoa-qrcode-stats__head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
.wxoa-qrcode-stats__total {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: var(--qw-text-2);
}
.wxoa-qrcode-stats__key::before {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 6px;
  content: '';
  border-radius: var(--qw-radius-sm);
}
.wxoa-qrcode-stats__key.is-scans::before {
  background: var(--qw-brand);
}
.wxoa-qrcode-stats__key.is-subscribes::before {
  background: var(--qw-success);
}
.wxoa-qrcode-stats__chart {
  height: 320px;
}
</style>
