<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import type { MonitorMysqlVo } from '@qiwu/shared'
import { monitorApi } from '@/api/platform/monitor'
import IconButton from '@/core/components/IconButton.vue'
import { bytes, count, duration, percent } from '../format'
import GaugeCard from '../GaugeCard.vue'
import MonitorStats from '../MonitorStats.vue'

// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'MonitorMysql' })

const { t } = useI18n()
const data = shallowRef<MonitorMysqlVo>()
const updatedAt = ref<Date>()
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    data.value = await monitorApi.mysql()
    updatedAt.value = new Date()
  } catch {
    // toasted by the request layer
  } finally {
    loading.value = false
  }
}
void load()

const label = (key: string) => t(`field.monitor.mysql.${key}`)
/** a whitelisted status counter; 0 when the server left it out */
const status = (key: keyof MonitorMysqlVo['status']) => data.value?.status[key] ?? 0
const ratio = (part: number, whole: number) => percent(whole ? (part / whole) * 100 : 0)

const stats = computed(() => {
  const d = data.value
  if (!d) return []
  const uptime = status('Uptime')
  return [
    { key: 'version', label: label('version'), value: d.variables.version ?? '' },
    { key: 'Uptime', label: label('Uptime'), value: duration(uptime) },
    { key: 'Questions', label: label('Questions'), value: count(status('Questions')) },
    {
      key: 'qps',
      label: t('monitor.mysql.qps'),
      value: uptime ? (status('Questions') / uptime).toFixed(1) : '—',
    },
    { key: 'Slow_queries', label: label('Slow_queries'), value: count(status('Slow_queries')) },
    {
      key: 'Bytes_received',
      label: label('Bytes_received'),
      value: bytes(status('Bytes_received')),
    },
    { key: 'Bytes_sent', label: label('Bytes_sent'), value: bytes(status('Bytes_sent')) },
  ]
})

type Gauge = {
  key: string
  title: string
  value: number
  facts: [string, string][]
  /** a full gauge is no warning (a warm buffer pool) */
  plain?: boolean
}
const gauges = computed((): Gauge[] => {
  const d = data.value
  if (!d) return []
  const max = Number(d.variables.max_connections) || 0
  const pages = status('Innodb_buffer_pool_pages_total')
  const free = status('Innodb_buffer_pool_pages_free')
  const requests = status('Innodb_buffer_pool_read_requests')
  const reads = status('Innodb_buffer_pool_reads')
  const out: Gauge[] = [
    {
      key: 'connections',
      title: t('monitor.mysql.connections'),
      value: ratio(status('Threads_connected'), max),
      facts: [
        [label('Threads_connected'), count(status('Threads_connected'))],
        [label('Threads_running'), count(status('Threads_running'))],
        [label('max_connections'), max ? count(max) : '—'],
      ],
    },
    {
      key: 'bufferPool',
      title: t('monitor.mysql.bufferPool'),
      plain: true,
      value: ratio(pages - free, pages),
      facts: [
        [label('Innodb_buffer_pool_pages_total'), count(pages)],
        [label('Innodb_buffer_pool_pages_free'), count(free)],
        [
          t('monitor.mysql.hitRate'),
          // two decimals: a healthy pool sits just under 100 %
          requests ? `${(((requests - reads) / requests) * 100).toFixed(2)}%` : '—',
        ],
      ],
    },
  ]
  if (d.pool)
    out.push({
      key: 'pool',
      title: label('pool'),
      value: ratio(d.pool.total, d.pool.limit),
      facts: [
        [label('total'), `${count(d.pool.total)} / ${count(d.pool.limit)}`],
        [label('idle'), count(d.pool.idle)],
        [label('queued'), count(d.pool.queued)],
      ],
    })
  return out
})
</script>

<template>
  <div class="qw-page">
    <div class="qw-page-bar">
      <span class="monitor-mysql__updated" aria-live="polite">
        {{
          updatedAt
            ? t('monitor.common.updatedAt', { time: dayjs(updatedAt).format('HH:mm:ss') })
            : ''
        }}
      </span>
      <IconButton icon="lucide:refresh-cw" :label="t('crud.action.refresh')" @click="load" />
    </div>

    <template v-if="data">
      <MonitorStats :items="stats" />
      <div class="monitor-mysql__gauges">
        <GaugeCard
          v-for="g in gauges"
          :key="g.key"
          :title="g.title"
          :value="g.value"
          :facts="g.facts"
          :plain="g.plain"
          :data-gauge="g.key"
        />
      </div>
      <p v-if="!data.pool" class="monitor-mysql__note">{{ t('monitor.mysql.noPool') }}</p>
    </template>
    <el-card v-else v-loading="loading" class="monitor-mysql__placeholder" />
  </div>
</template>

<style scoped>
.monitor-mysql__updated {
  font-size: 13px;
  color: var(--qw-text-3);
}
.monitor-mysql__gauges {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
}
.monitor-mysql__note {
  margin: 0;
  font-size: 13px;
  color: var(--qw-text-3);
}
.monitor-mysql__placeholder {
  min-height: 240px;
}
</style>
