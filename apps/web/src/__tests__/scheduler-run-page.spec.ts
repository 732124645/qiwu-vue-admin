// Run log page: the process that ran each attempt and its max event-loop delay; rows written before
// these were recorded show a dash.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { RunVo } from '@qiwu/shared'
import { useTablePrefsStore } from '@/core/composables/use-table-prefs'
import { i18n, setLocale } from '@/core/i18n'
import RunPage from '@/views/platform/scheduler/run/index.vue'
import { mockApi, ok } from './mock-api'

const run = (id: number, extra: Partial<RunVo> = {}): RunVo => ({
  id,
  taskId: 3,
  taskName: 'Nightly purge',
  handler: 'audit.purge',
  params: null,
  attempt: 1,
  outcome: 'ok',
  output: null,
  error: null,
  startedAt: '2026-10-30T02:00:00.000Z',
  endedAt: '2026-10-30T02:00:01.000Z',
  costMs: 1000,
  instance: null,
  loopMaxMs: null,
  ...extra,
})

let page: VueWrapper
beforeEach(async () => {
  setActivePinia(createPinia())
  setLocale('en-US')
  mockApi({
    'GET /iam/profile/prefs/table.scheduler.run': ok({ value: null }),
    'GET /scheduler/runs': ok({
      items: [run(2, { instance: 'web-1:4242', loopMaxMs: 812 }), run(1)],
      total: 2,
    }),
    'GET /settings/dicts/scheduler.run_outcome/entries': ok({ version: 1, entries: [] }),
  })
  page = mount(RunPage, {
    global: { plugins: [ElementPlus, i18n], stubs: { TableToolbar: true } },
    attachTo: document.body,
  })
  await flushPromises()
})
afterEach(() => {
  page.unmount()
  useTablePrefsStore().clear()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('run log page', () => {
  it('shows the instance and the max loop delay, a dash where none was recorded', () => {
    const t = i18n.global.t
    const headers = page.findAll('.el-table__header th').map((th) => th.text())
    expect(headers).toContain(t('field.scheduler.run.instance'))
    expect(headers).toContain(t('field.scheduler.run.loopMaxMs'))
    const [recorded, old] = page.findAll('.el-table__body .el-table__row')
    expect(recorded!.text()).toContain('web-1:4242')
    expect(recorded!.text()).toContain('812')
    expect(old!.text()).toContain('—')
  })
})
