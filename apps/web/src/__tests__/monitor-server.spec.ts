// Server monitor page (monitor/server): gauges and facts from GET /monitor/server, polled
// every 5 s only while the page is on screen (tab visible, not parked by keep-alive).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, KeepAlive, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { MonitorServerVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import ServerPage from '@/views/platform/monitor/server/index.vue'
import { bytes, duration } from '@/views/platform/monitor/format'
import { mockApi, ok } from './mock-api'

const GiB = 1024 ** 3
const DATA: MonitorServerVo = {
  cpu: { model: 'Apple M3', cores: 8, usage: 12.345, loadAvg: [1.5, 1.25, 1] },
  mem: { total: 16 * GiB, used: 12 * GiB, usage: 75 },
  disks: [
    { mount: '/', fs: '/dev/disk1', type: 'apfs', size: 500 * GiB, used: 460 * GiB, usage: 92 },
  ],
  os: {
    platform: 'darwin',
    distro: 'macOS',
    release: '26.0',
    arch: 'arm64',
    hostname: 'host-1',
    uptime: 93784,
  },
  node: { version: 'v22.22.1', v8: '12.4' },
  process: {
    pid: 42,
    uptime: 3600,
    rss: 200 * 1024 ** 2,
    heapTotal: 100 * 1024 ** 2,
    heapUsed: 50 * 1024 ** 2,
    external: 1024,
  },
}

const show = ref(true)
// the page inside keep-alive, swapped for another page and back
const Host = defineComponent({
  setup: () => () => h(KeepAlive, null, [show.value ? h(ServerPage) : h('p', 'other')]),
})

let host: VueWrapper
let calls: ReturnType<typeof mockApi>
const polls = () => calls.filter((c) => c.url === '/monitor/server').length
let visibility: DocumentVisibilityState
async function setVisibility(v: DocumentVisibilityState) {
  visibility = v
  document.dispatchEvent(new Event('visibilitychange'))
  await flushPromises()
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  show.value = true
  calls = mockApi({ 'GET /monitor/server': ok(DATA) })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  host = mount(Host, { global: { plugins: [ElementPlus, i18n, router] }, attachTo: document.body })
  await flushPromises()
})
afterEach(() => {
  host.unmount()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('format', () => {
  it('shows sizes and durations', () => {
    expect(bytes(512)).toBe('512 B')
    expect(bytes(1536)).toBe('1.5 KB')
    expect(bytes(12 * GiB)).toBe('12.0 GB')
    expect(duration(93784)).toBe('1 d 2 h 3 min')
    expect(duration(3720)).toBe('1 h 2 min')
    expect(duration(59)).toBe('0 min')
  })
})

describe('server monitor', () => {
  it('shows the CPU, memory and heap gauges, host facts and disks', () => {
    const gauge = (k: string) => host.find(`[data-gauge="${k}"]`)
    expect(gauge('cpu').find('.el-progress__text').text()).toBe('12.3%')
    expect(gauge('cpu').text()).toContain('Apple M3')
    expect(gauge('cpu').text()).toContain('1.50 / 1.25 / 1.00')
    expect(gauge('mem').find('.el-progress__text').text()).toBe('75.0%')
    expect(gauge('mem').text()).toContain('4.0 GB') // free
    expect(gauge('heap').find('.el-progress__text').text()).toBe('50.0%')
    expect(host.text()).toContain('1 d 2 h 3 min')
    expect(host.text()).toContain('v22.22.1')
    const disk = host.find('.el-table__body .el-table__row')
    expect(disk.text()).toContain('460.0 GB')
    expect(disk.text()).toContain('92.0%')
  })

  it('polls every 5 s while visible and active, pauses when hidden or parked, resumes at once', async () => {
    expect(polls()).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(polls()).toBe(2)

    await setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(polls()).toBe(2)
    await setVisibility('visible')
    expect(polls()).toBe(3)

    // keep-alive parks the page (another tab of the app): no polling until it comes back
    show.value = false
    await flushPromises()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(polls()).toBe(3)
    show.value = true
    await flushPromises()
    expect(polls()).toBe(4)
    await vi.advanceTimersByTimeAsync(5000)
    expect(polls()).toBe(5)

    // the first load toasts errors, the polls after it are silent
    expect(calls[0]?.silent).toBe(false)
    expect(calls.at(-1)?.silent).toBe(true)

    host.unmount()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(polls()).toBe(5)
    host = mount({ render: () => null })
  })
})
