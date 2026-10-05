<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDocumentVisibility } from '@vueuse/core'
import dayjs from 'dayjs'
import type { MonitorServerVo } from '@qiwu/shared'
import { monitorApi } from '@/api/platform/monitor'
import IconButton from '@/core/components/IconButton.vue'
import { bytes, duration, loadColor, percent } from '../format'
import GaugeCard from '../GaugeCard.vue'

// keep-alive name = the seeded menu's component_name
defineOptions({ name: 'MonitorServer' })

/** Poll interval while the page is shown. */
const POLL_MS = 5000

const { t } = useI18n()
const data = shallowRef<MonitorServerVo>()
const updatedAt = ref<Date>()
const loading = ref(false)

// polls only while this page is on screen: the tab is visible and keep-alive has not parked the page
const visibility = useDocumentVisibility()
const active = ref(true)
onActivated(() => (active.value = true))
onDeactivated(() => (active.value = false))
const polling = computed(() => active.value && visibility.value === 'visible')

let run = 0
let timer: ReturnType<typeof setTimeout> | undefined
function stop() {
  run++
  clearTimeout(timer)
}
/** Loads now, then again 5 s after the answer while polling; a newer load or a stop takes over the turn. */
async function load() {
  stop()
  const mine = run
  loading.value = true
  try {
    // the first load shows errors; the polls after it retry quietly
    data.value = await monitorApi.server(!!data.value)
    updatedAt.value = new Date()
  } catch {
    // toasted (first load) or retried on the next turn
  } finally {
    loading.value = false
  }
  if (mine === run && polling.value) timer = setTimeout(load, POLL_MS)
}
watch(polling, (on) => (on ? void load() : stop()))
onBeforeUnmount(stop)
// the first load happens anyway (a page opened in a background tab is ready when shown)
void load()

const gauges = computed(
  (): { key: string; title: string; value: number; facts: [string, string][] }[] => {
    const d = data.value
    if (!d) return []
    return [
      {
        key: 'cpu',
        title: t('field.monitor.server.cpu'),
        value: percent(d.cpu.usage),
        facts: [
          [t('field.monitor.server.model'), d.cpu.model],
          [t('field.monitor.server.cores'), String(d.cpu.cores)],
          [t('field.monitor.server.loadAvg'), d.cpu.loadAvg.map((n) => n.toFixed(2)).join(' / ')],
        ],
      },
      {
        key: 'mem',
        title: t('field.monitor.server.mem'),
        value: percent(d.mem.usage),
        facts: [
          [t('field.monitor.server.used'), bytes(d.mem.used)],
          [t('field.monitor.server.total'), bytes(d.mem.total)],
          [t('monitor.server.free'), bytes(d.mem.total - d.mem.used)],
        ],
      },
      {
        key: 'heap',
        title: t('monitor.server.heap'),
        value: percent(d.process.heapTotal ? (d.process.heapUsed / d.process.heapTotal) * 100 : 0),
        facts: [
          [t('field.monitor.server.heapUsed'), bytes(d.process.heapUsed)],
          [t('field.monitor.server.heapTotal'), bytes(d.process.heapTotal)],
          [t('field.monitor.server.rss'), bytes(d.process.rss)],
        ],
      },
    ]
  },
)
const barText = (p: number) => `${p.toFixed(1)}%`
</script>

<template>
  <div class="qw-page monitor-server">
    <div class="qw-page-bar">
      <span class="monitor-server__updated" aria-live="polite">
        {{
          updatedAt
            ? t('monitor.common.updatedAt', { time: dayjs(updatedAt).format('HH:mm:ss') })
            : ''
        }}
      </span>
      <IconButton icon="lucide:refresh-cw" :label="t('crud.action.refresh')" @click="load" />
    </div>

    <template v-if="data">
      <div class="monitor-server__gauges">
        <GaugeCard
          v-for="g in gauges"
          :key="g.key"
          :title="g.title"
          :value="g.value"
          :facts="g.facts"
          :data-gauge="g.key"
        />
      </div>

      <div class="monitor-server__info">
        <el-card>
          <h2 class="monitor-card__title">{{ t('field.monitor.server.os') }}</h2>
          <el-descriptions :column="1" border>
            <el-descriptions-item :label="t('field.monitor.server.hostname')">
              {{ data.os.hostname }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('field.monitor.server.distro')">
              {{ data.os.distro }} {{ data.os.release }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('field.monitor.server.platform')">
              {{ data.os.platform }} / {{ data.os.arch }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('field.monitor.server.uptime')">
              {{ duration(data.os.uptime) }}
            </el-descriptions-item>
          </el-descriptions>
        </el-card>
        <el-card>
          <h2 class="monitor-card__title">{{ t('field.monitor.server.process') }}</h2>
          <el-descriptions :column="1" border>
            <el-descriptions-item :label="t('field.monitor.server.node')">
              {{ data.node.version }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('field.monitor.server.v8')">
              {{ data.node.v8 }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('field.monitor.server.pid')">
              {{ data.process.pid }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('field.monitor.server.uptime')">
              {{ duration(data.process.uptime) }}
            </el-descriptions-item>
          </el-descriptions>
        </el-card>
      </div>

      <el-card class="qw-table-panel">
        <h2 class="monitor-card__title monitor-card__title--table">
          {{ t('field.monitor.server.disks') }}
        </h2>
        <el-table :data="data.disks" row-key="mount">
          <el-table-column prop="mount" :label="t('field.monitor.server.mount')" min-width="160" />
          <el-table-column
            prop="fs"
            :label="t('field.monitor.server.fs')"
            min-width="160"
            show-overflow-tooltip
          />
          <el-table-column prop="type" :label="t('field.monitor.server.type')" width="120" />
          <el-table-column :label="t('field.monitor.server.size')" width="120" align="right">
            <template #default="{ row }">{{ bytes(row.size) }}</template>
          </el-table-column>
          <el-table-column :label="t('field.monitor.server.used')" width="120" align="right">
            <template #default="{ row }">{{ bytes(row.used) }}</template>
          </el-table-column>
          <el-table-column :label="t('field.monitor.server.usage')" min-width="200">
            <template #default="{ row }">
              <el-progress
                :percentage="percent(row.usage)"
                :color="loadColor"
                :format="barText"
                :aria-label="`${row.mount} ${t('field.monitor.server.usage')}`"
              />
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>
    <el-card v-else v-loading="loading" class="monitor-server__placeholder" />
  </div>
</template>

<style scoped>
.monitor-server__updated {
  font-size: 13px;
  color: var(--qw-text-3);
}
.monitor-server__gauges,
.monitor-server__info {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
}
.monitor-server__placeholder {
  min-height: 240px;
}
.monitor-card__title {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--qw-text);
}
.monitor-card__title--table {
  padding: 16px 16px 0;
}
</style>
