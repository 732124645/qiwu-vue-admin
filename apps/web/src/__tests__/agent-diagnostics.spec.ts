// The agent settings' diagnostics tab, root only (hidden from everyone else): the overview (queue, turns of
// every tenant, sweep stats, providers, search providers, MCP servers, recent failures), refresh, and the
// connectivity tests whose result (time, or the reason code explained) shows in the row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import type { AgentDiagnosticsVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { vPerm } from '@/core/permission'
import DiagnosticsTab from '@/views/platform/agent/setting/DiagnosticsTab.vue'
import SettingPage from '@/views/platform/agent/setting/index.vue'
import { me, mockApi, ok } from './mock-api'

const VO: AgentDiagnosticsVo = {
  providers: [{ id: 3, name: 'DeepSeek', enabled: true, hasKey: true }],
  search: [{ id: 4, name: 'Tavily', enabled: false }],
  mcpServers: [{ id: 5, name: 'CRM', status: 'error', lastError: 'network' }],
  queue: { waiting: 2, active: 1, failed: 0, delayed: 3 },
  turns: { running: 4, waiting: 1, failedToday: 6 },
  recentFailures: [
    { turnId: 91, tenantId: 2, code: 'A0500', message: 'boom', at: '2026-10-22T01:00:00.000Z' },
  ],
  sweeps: { lastAt: null, requeued: 0, failed: 0 },
}

let w: VueWrapper
async function show() {
  useAuthStore().me = me(['*'])
  w = mount(DiagnosticsTab, { global: { plugins: [ElementPlus, i18n] }, attachTo: document.body })
  await flushPromises()
}
const table = (kind: string) => w.find(`[data-kind="${kind}"]`)
const testButton = (kind: string) =>
  table(kind)
    .findAll('button')
    .find((b) => b.text() === 'Test')

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  w?.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('diagnostics tab', () => {
  it('shows the overview and refreshes it', async () => {
    const calls = mockApi({ 'GET /agent/diagnostics': ok(VO) })
    await show()
    const text = w.text()
    for (const s of ['Waiting', 'Delayed', 'Failed today', 'Not run yet', 'DeepSeek', 'Tavily'])
      expect(text).toContain(s)
    // the last error's reason code, explained
    expect(table('mcp').text()).toContain('Unreachable (network error)')
    expect(table('failures').text()).toContain('A0500')
    expect(table('failures').text()).toContain('boom')
    await w
      .findAll('button')
      .find((b) => b.text() === 'Refresh')!
      .trigger('click')
    await flushPromises()
    expect(calls.filter((c) => c.url === '/agent/diagnostics')).toHaveLength(2)
  })

  it('runs a test as root and shows its time or reason code', async () => {
    const calls = mockApi({
      'GET /agent/diagnostics': ok(VO),
      'POST /agent/diagnostics/test-provider/3': ok({ ok: true, ms: 120 }),
      'POST /agent/diagnostics/test-mcp/5': ok({ ok: false, ms: 20, error: 'timeout' }),
      'POST /agent/diagnostics/test-search/4': ok({ ok: false, ms: 9, error: 'http_502' }),
    })
    await show()
    await testButton('provider')!.trigger('click')
    await flushPromises()
    expect(table('provider').text()).toContain('OK (120 ms)')
    await testButton('mcp')!.trigger('click')
    await flushPromises()
    expect(table('mcp').text()).toContain('Failed: Timed out (20 ms)')
    await testButton('search')!.trigger('click')
    await flushPromises()
    expect(table('search').text()).toContain('Failed: HTTP 502 (9 ms)')
    expect(calls.filter((c) => c.method === 'post').map((c) => c.url)).toEqual([
      '/agent/diagnostics/test-provider/3',
      '/agent/diagnostics/test-mcp/5',
      '/agent/diagnostics/test-search/4',
    ])
  })

  it('shows a reason code it does not know as it is', async () => {
    mockApi({
      'GET /agent/diagnostics': ok({
        ...VO,
        mcpServers: [{ id: 5, name: 'CRM', status: 'ok', lastError: 'tools_changed: lookup' }],
      }),
    })
    await show()
    expect(table('mcp').text()).toContain('tools_changed: lookup')
  })

  it('the settings page shows the tab to root only', async () => {
    mockApi({})
    const tabs = async (perms: string[], roles: string[]) => {
      useAuthStore().me = { ...me(perms), roles }
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/', component: { render: () => null } }],
      })
      await router.push('/')
      w = mount(SettingPage, {
        global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
        attachTo: document.body,
      })
      await flushPromises()
      const labels = w.findAll('.el-tabs__item').map((x) => x.text())
      w.unmount()
      return labels
    }
    expect(await tabs(['*'], ['root'])).toContain('Diagnostics')
    const other = await tabs(['agent.setting.browse', 'agent.setting.modify'], ['admin'])
    expect(other).toContain('Models')
    expect(other).not.toContain('Diagnostics')
  })
})
