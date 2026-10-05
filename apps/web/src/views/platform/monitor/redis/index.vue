<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import { REDIS_INFO_SECTIONS, type MonitorRedisVo, type RedisInfoSection } from '@qiwu/shared'
import { monitorApi } from '@/api/platform/monitor'
import IconButton from '@/core/components/IconButton.vue'
import QwChart from '@/core/components/QwChart.vue'
import { count, duration } from '../format'
import MonitorStats from '../MonitorStats.vue'
import { commandChart, infoNum, memoryChart, opsChart } from './charts'

// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'MonitorRedis' })

const { t } = useI18n()
const data = shallowRef<MonitorRedisVo>()
const updatedAt = ref<Date>()
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    data.value = await monitorApi.redis()
    updatedAt.value = new Date()
  } catch {
    // toasted by the request layer
  } finally {
    loading.value = false
  }
}
void load()

const stats = computed(() => {
  const d = data.value
  if (!d) return []
  const { info } = d
  const hits = infoNum(info, 'stats', 'keyspace_hits')
  const misses = infoNum(info, 'stats', 'keyspace_misses')
  return [
    { key: 'version', value: info.server?.redis_version ?? '' },
    { key: 'mode', value: info.server?.redis_mode ?? '' },
    { key: 'uptime', value: duration(infoNum(info, 'server', 'uptime_in_seconds')) },
    { key: 'clients', value: count(infoNum(info, 'clients', 'connected_clients')) },
    { key: 'memory', value: info.memory?.used_memory_human ?? '' },
    {
      key: 'keys',
      value: t('monitor.redis.keysOfDb', { keys: count(d.keyspace.keys), db: d.keyspace.db }),
    },
    { key: 'expires', value: count(d.keyspace.expires) },
    {
      key: 'hitRate',
      value: hits + misses ? `${((hits / (hits + misses)) * 100).toFixed(1)}%` : '—',
    },
  ].map((s) => ({ ...s, label: t(`monitor.redis.stat.${s.key}`) }))
})
// chart texts follow the language: recomputed on a switch like the rest of the page
const charts = computed(() => {
  const d = data.value
  if (!d) return []
  return [
    { key: 'memory', title: t('field.monitor.redis.memory'), option: memoryChart(d.info) },
    { key: 'ops', title: t('monitor.redis.ops'), option: opsChart(d.info) },
    {
      key: 'commands',
      title: t('field.monitor.redis.commandStats'),
      option: commandChart(d.commandStats),
    },
  ]
})

const section = ref<RedisInfoSection>('server')
const sections = computed(() =>
  REDIS_INFO_SECTIONS.filter((s) => data.value?.info[s]).map((s) => ({
    name: s,
    rows: Object.entries(data.value?.info[s] ?? {}).map(([field, value]) => ({ field, value })),
  })),
)
</script>

<template>
  <div class="qw-page monitor-redis">
    <div class="qw-page-bar">
      <span class="monitor-redis__updated" aria-live="polite">
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

      <div class="monitor-redis__charts">
        <el-card
          v-for="c in charts"
          :key="c.key"
          class="monitor-redis__chart-card"
          :class="`monitor-redis__chart-card--${c.key}`"
        >
          <h2 class="monitor-card__title">{{ c.title }}</h2>
          <QwChart :option="c.option" :title="c.title" class="monitor-redis__chart" />
        </el-card>
      </div>

      <el-card>
        <h2 class="monitor-card__title">{{ t('field.monitor.redis.info') }}</h2>
        <el-tabs v-model="section">
          <el-tab-pane
            v-for="s in sections"
            :key="s.name"
            :name="s.name"
            :label="t(`field.monitor.redis.${s.name}`)"
          >
            <el-table :data="s.rows" row-key="field" max-height="360">
              <el-table-column prop="field" :label="t('monitor.redis.field')" min-width="240" />
              <el-table-column
                prop="value"
                :label="t('monitor.redis.value')"
                min-width="240"
                show-overflow-tooltip
              />
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </el-card>
    </template>
    <el-card v-else v-loading="loading" class="monitor-redis__placeholder" />
  </div>
</template>

<style scoped>
.monitor-redis__updated {
  font-size: 13px;
  color: var(--qw-text-3);
}
.monitor-redis__placeholder {
  min-height: 240px;
}
.monitor-redis__charts {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(240px, 1fr) minmax(360px, 2fr);
  gap: 16px;
}
.monitor-card__title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--qw-text);
}
.monitor-redis__chart {
  height: 260px;
}
</style>
