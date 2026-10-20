<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { WXOA_STAT_MAX_DAYS, wxoaPerms } from '@qiwu/shared'
import {
  WXOA_STAT_GROUPS,
  wxoaStatApi,
  type WxoaStatGroup,
  type WxoaStatVo,
} from '@/api/platform/wxoa/stat'
import QwChart, { type QwChartOption } from '@/core/components/QwChart.vue'
import { openDialog } from '@/core/dialog'
import { usePerm } from '@/core/permission'
import WxoaAccountQuota from '../account/quota.vue'
import { useWxoaAccount } from '../components/use-wxoa-account'
import AccountSwitch from '../components/AccountSwitch.vue'
import VerifiedHint from '../components/VerifiedHint.vue'

/**
 * 数据统计：用户、消息、接口、图文四组折线图。区间最多 90 天且不含今天（微信是 T+1 数据）；
 * 四组各自请求、各自报错，一组失败不影响其余几组。
 */
defineOptions({ name: 'WxoaStat' })
const { t, te } = useI18n()
const { accountId } = useWxoaAccount()
const perm = usePerm()
/** 接口配额对话框（与账号管理同一个），要账号的浏览权限 */
const canQuota = computed(() => perm.has(wxoaPerms.account.browse))
function openQuota() {
  if (accountId.value == null) return
  void openDialog(
    WxoaAccountQuota,
    { id: accountId.value },
    { title: () => t('wxoa.account.quota.title'), width: 640 },
  )
}
const from = ref(dayjs().subtract(7, 'day').format('YYYY-MM-DD'))
const to = ref(dayjs().subtract(1, 'day').format('YYYY-MM-DD'))
const loading = ref(false)
type GroupState = { data: WxoaStatVo | null; failed: boolean }
const empty = (): Record<WxoaStatGroup, GroupState> =>
  Object.fromEntries(WXOA_STAT_GROUPS.map((g) => [g, { data: null, failed: false }])) as Record<
    WxoaStatGroup,
    GroupState
  >
const result = ref(empty())
const days = computed(() =>
  from.value && to.value ? dayjs(to.value).diff(dayjs(from.value), 'day') + 1 : 0,
)
const invalidRange = computed(
  () =>
    days.value < 1 || days.value > WXOA_STAT_MAX_DAYS || to.value >= dayjs().format('YYYY-MM-DD'),
)
/** 指标名按 `wxoa.stat.metric.<key>` 翻译，没有译文时显示原始键 */
const metricName = (key: string) =>
  te(`wxoa.stat.metric.${key}`) ? t(`wxoa.stat.metric.${key}`) : key

/** 一组统计的折线图配置：横轴是日期，每个指标一条线，图例显示指标名。 */
function option(data: WxoaStatVo | null): QwChartOption {
  const series = data?.series ?? []
  return {
    tooltip: { trigger: 'axis' },
    legend: { show: series.length > 1 },
    grid: { left: 40, right: 20, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: data?.dates ?? [] },
    yAxis: { type: 'value' },
    series: series.map((s) => ({
      name: metricName(s.key),
      type: 'line' as const,
      smooth: true,
      data: s.values,
    })),
  } as QwChartOption
}

let seq = 0
/** 四组并行请求，按组记录结果或失败；切换账号后先到的旧应答丢弃。 */
async function load() {
  const id = accountId.value
  if (id == null || invalidRange.value) return
  const mine = ++seq
  loading.value = true
  const params = { accountId: id, from: from.value, to: to.value }
  const settled = await Promise.allSettled(
    WXOA_STAT_GROUPS.map((g) => wxoaStatApi.group(g, params)),
  )
  if (mine !== seq) return
  const next = empty()
  settled.forEach((r, i) => {
    next[WXOA_STAT_GROUPS[i]!] =
      r.status === 'fulfilled' ? { data: r.value, failed: false } : { data: null, failed: true }
  })
  result.value = next
  loading.value = false
}
function changeRange(value: string[] | null) {
  if (!value?.length) return
  from.value = value[0] ?? from.value
  to.value = value[1] ?? to.value
}
// 打开页面时（账号已选好）与切换账号时各查一次
watch(
  accountId,
  () => {
    result.value = empty()
    void load()
  },
  { immediate: true },
)
</script>

<template>
  <div class="qw-page wxoa-stat-page">
    <AccountSwitch />
    <template v-if="accountId != null">
      <VerifiedHint />
      <el-card class="wxoa-stat__filters">
        <el-form inline>
          <el-form-item :label="t('wxoa.stat.range')">
            <el-date-picker
              :model-value="[from, to]"
              type="daterange"
              value-format="YYYY-MM-DD"
              :clearable="false"
              :disabled-date="(date: Date) => date >= new Date()"
              @update:model-value="changeRange"
            />
          </el-form-item>
          <el-button type="primary" :loading="loading" :disabled="invalidRange" @click="load">{{
            t('wxoa.stat.query')
          }}</el-button>
          <el-button v-if="canQuota" @click="openQuota">{{ t('wxoa.stat.quota') }}</el-button>
          <span v-if="invalidRange" class="wxoa-stat__hint">{{
            t('wxoa.stat.rangeHint', { max: WXOA_STAT_MAX_DAYS })
          }}</span>
        </el-form>
      </el-card>
      <el-row v-loading="loading" :gutter="16" class="wxoa-stat__grid">
        <el-col v-for="name in WXOA_STAT_GROUPS" :key="name" :xs="24" :lg="12">
          <el-card class="wxoa-stat__card" :data-group="name"
            ><template #header>{{ t(`wxoa.stat.group.${name}`) }}</template>
            <el-alert
              v-if="result[name].failed"
              type="error"
              :closable="false"
              show-icon
              :title="t('wxoa.stat.failed')" />
            <QwChart
              v-else
              :title="t(`wxoa.stat.group.${name}`)"
              :option="option(result[name].data)"
              class="wxoa-stat__chart"
          /></el-card>
        </el-col>
      </el-row>
    </template>
  </div>
</template>

<style scoped>
.wxoa-stat__filters {
  margin-bottom: 16px;
}
.wxoa-stat__hint {
  color: var(--qw-danger);
  font-size: 12px;
}
.wxoa-stat__grid {
  row-gap: 16px;
}
.wxoa-stat__chart {
  height: 300px;
}
</style>
