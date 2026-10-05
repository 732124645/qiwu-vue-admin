// MySQL status cards (monitor/mysql): whitelisted status / variables as figures and
// gauges (connections, InnoDB buffer pool, the app's pool when the driver exposes it).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { MonitorMysqlVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import MysqlPage from '@/views/platform/monitor/mysql/index.vue'
import { mockApi, ok } from './mock-api'

const DATA: MonitorMysqlVo = {
  status: {
    Uptime: 7200,
    Threads_connected: 38,
    Threads_running: 2,
    Questions: 36000,
    Slow_queries: 3,
    Innodb_buffer_pool_pages_total: 8192,
    Innodb_buffer_pool_pages_free: 2048,
    Innodb_buffer_pool_read_requests: 10000,
    Innodb_buffer_pool_reads: 100,
    Bytes_received: 1536,
    Bytes_sent: 3 * 1024 ** 2,
  },
  variables: { version: '8.4.6', max_connections: '151' },
  pool: { limit: 10, total: 4, idle: 3, queued: 0 },
}

let page: VueWrapper
async function mountPage(data: MonitorMysqlVo) {
  mockApi({ 'GET /monitor/mysql': ok(data) })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  page = mount(MysqlPage, {
    global: { plugins: [ElementPlus, i18n, router] },
    attachTo: document.body,
  })
  await flushPromises()
}
const stat = (k: string) => page.find(`[data-stat="${k}"] dd`).text()
const gauge = (k: string) => page.find(`[data-gauge="${k}"]`)

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
})
afterEach(() => {
  page.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('mysql monitor', () => {
  it('shows the figures and the connection, buffer pool and app pool gauges', async () => {
    await mountPage(DATA)
    expect(stat('version')).toBe('8.4.6')
    expect(stat('Uptime')).toBe('2 h 0 min')
    expect(stat('qps')).toBe('5.0')
    expect(stat('Bytes_sent')).toBe('3.0 MB')
    expect(gauge('connections').find('.el-progress__text').text()).toBe('25.2%')
    expect(gauge('connections').text()).toContain('151')
    expect(gauge('bufferPool').find('.el-progress__text').text()).toBe('75.0%')
    expect(gauge('bufferPool').text()).toContain('99.00%') // hit rate
    expect(gauge('pool').find('.el-progress__text').text()).toBe('40.0%')
    expect(gauge('pool').text()).toContain('4 / 10')
    expect(page.text()).not.toContain('not available')
  })

  it('says so when the driver exposes no pool, and survives missing counters', async () => {
    await mountPage({ status: {}, variables: {}, pool: null })
    expect(gauge('pool').exists()).toBe(false)
    expect(page.text()).toContain("The connection pool's state is not available")
    expect(stat('qps')).toBe('—')
    expect(gauge('connections').find('.el-progress__text').text()).toBe('0.0%')
  })
})
