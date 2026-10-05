// Redis monitor page (monitor/redis): stat tiles, the memory / ops / command charts
// (QwChart, stubbed here; its language rebuild is in set-locale.spec) and the INFO sections.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { MonitorRedisVo } from '@qiwu/shared'
import QwChart from '@/core/components/QwChart.vue'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import RedisPage from '@/views/platform/monitor/redis/index.vue'
import { commandChart, memoryChart, opsChart, scaleOf } from '@/views/platform/monitor/redis/charts'
import { mockApi, ok } from './mock-api'

const MiB = 1024 ** 2
const DATA: MonitorRedisVo = {
  info: {
    server: { redis_version: '8.2.1', redis_mode: 'standalone', uptime_in_seconds: '93784' },
    clients: { connected_clients: '7' },
    memory: {
      used_memory: String(4 * MiB),
      used_memory_human: '4.00M',
      maxmemory: '0',
      total_system_memory: String(16 * MiB),
    },
    stats: { instantaneous_ops_per_sec: '42', keyspace_hits: '90', keyspace_misses: '10' },
  },
  commandStats: Array.from({ length: 12 }, (_, i) => ({
    command: `cmd${i}`,
    calls: (i + 1) * 10,
    usec: (i + 1) * 100,
    usecPerCall: 10,
  })),
  keyspace: { db: 13, keys: 1234, expires: 56, avgTtl: 1000 },
}
type Gauge = {
  max: number
  data: { value: number; name: string }[]
  detail: { formatter: () => string }
}
const gauge = (o: ReturnType<typeof memoryChart>) => (o.series as Gauge[])[0]!

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('redis charts', () => {
  it('memory: used of maxmemory, else of the host memory', () => {
    const g = gauge(memoryChart(DATA.info))
    expect(g.data[0]).toEqual({ value: 25, name: '25% of 16.0 MB' })
    expect(g.detail.formatter()).toBe('4.0 MB')
    const limited = { ...DATA.info, memory: { ...DATA.info.memory, maxmemory: String(8 * MiB) } }
    expect(gauge(memoryChart(limited)).data[0]?.value).toBe(50)
  })

  it('ops on a power-of-ten scale; the 10 most called commands, most called on top', () => {
    expect([0, 9, 10, 42, 999].map(scaleOf)).toEqual([10, 10, 100, 100, 1000])
    const g = gauge(opsChart(DATA.info))
    expect([g.data[0]?.value, g.max, g.detail.formatter()]).toEqual([42, 100, '42'])
    const bars = commandChart(DATA.commandStats)
    const axis = bars.yAxis as { data: string[] }
    expect(axis.data).toHaveLength(10)
    expect(axis.data.at(-1)).toBe('cmd11')
    expect(axis.data[0]).toBe('cmd2')
  })
})

describe('redis monitor page', () => {
  let page: VueWrapper
  afterEach(() => page.unmount())

  it('shows the stat tiles, the three charts and the INFO sections', async () => {
    mockApi({ 'GET /monitor/redis': ok(DATA) })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { render: () => null } }],
    })
    await router.push('/')
    page = mount(RedisPage, {
      global: { plugins: [ElementPlus, i18n, router], stubs: { QwChart: true } },
      attachTo: document.body,
    })
    await flushPromises()
    const stat = (k: string) => page.find(`[data-stat="${k}"]`).text()
    expect(stat('version')).toBe('Version8.2.1')
    expect(stat('uptime')).toBe('Uptime1 d 2 h 3 min')
    expect(stat('keys')).toBe('Keys1,234 (db 13)')
    expect(stat('hitRate')).toBe('Hit rate90.0%')
    const charts = page.findAllComponents(QwChart)
    expect(charts.map((c) => c.props('title'))).toEqual([
      'Memory',
      'Operations',
      'Command statistics',
    ])
    expect(page.findAll('.el-tabs__item').map((t) => t.text())).toEqual([
      'Server',
      'Clients',
      'Memory',
      'Statistics',
    ])
    expect(page.find('.el-tab-pane .el-table__body').text()).toContain('redis_version8.2.1')
  })
})
