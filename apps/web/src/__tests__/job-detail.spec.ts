// Task detail drawer content (scheduler page-2): the task's settings, the next 5 fire times
// the server computes for its cron and its latest runs; against a fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import dayjs from 'dayjs'
import type { JobRunView, JobTaskView } from '@/api/platform/scheduler/job'
import CodeViewer from '@/core/components/CodeViewer.vue'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import JobDetail from '@/views/platform/scheduler/task/job-detail.vue'
import { mockApi, ok, type Route } from './mock-api'

const TASK: JobTaskView = {
  id: 3,
  name: 'Nightly purge',
  groupCode: 'system',
  handler: 'audit.purge',
  params: { days: 30 },
  cron: '0 0 2 * * *',
  enabled: false,
  retryMax: 2,
  retryDelayMs: 1500,
  timeoutMs: 60000,
  allowOverlap: false,
  misfire: 'run_once',
  lastFireAt: '2026-09-27T18:00:00.000Z',
  note: 'keeps 30 days',
}
const run = (id: number, extra: Partial<JobRunView> = {}): JobRunView => ({
  id,
  attempt: 1,
  outcome: 'ok',
  startedAt: '2026-09-27T18:00:00.000Z',
  endedAt: '2026-09-27T18:00:01.200Z',
  costMs: 1200,
  error: null,
  ...extra,
})
const TIMES = [1, 2, 3, 4, 5].map((d) => `2026-10-0${d}T18:00:00.000Z`)
const dict = (entries: [string, string, string][]) =>
  ok({
    version: 1,
    entries: entries.map(([value, label, tagType], sortNo) => ({
      value,
      label,
      labelI18n: null,
      tagType,
      cssClass: null,
      isDefault: false,
      sortNo,
    })),
  })

function backend(extra: Record<string, Route> = {}) {
  return mockApi({
    'GET /scheduler/tasks/3': ok(TASK),
    'GET /scheduler/runs': ok({
      items: [
        run(12, { outcome: 'failed', attempt: 3, error: 'Error: connection refused' }),
        run(11, { outcome: 'timeout', costMs: 60000 }),
        run(10),
      ],
      total: 3,
    }),
    'GET /scheduler/tasks/next-fire-times': ok({ times: TIMES }),
    'GET /settings/dicts/scheduler.job_group/entries': dict([['system', 'System', 'primary']]),
    'GET /settings/dicts/core.enabled/entries': dict([
      ['true', 'Enabled', 'success'],
      ['false', 'Disabled', 'info'],
    ]),
    'GET /settings/dicts/core.yes_no/entries': dict([
      ['true', 'Yes', 'success'],
      ['false', 'No', 'info'],
    ]),
    ...extra,
  })
}

let w: VueWrapper
async function mountDetail(props: { id: number; runs?: boolean } = { id: 3 }) {
  w = mount(JobDetail, { props, global: { plugins: [ElementPlus, i18n] } })
  await vi.waitFor(async () => {
    await flushPromises()
    expect(w.find('.el-descriptions').exists()).toBe(true)
  })
  await flushPromises()
}
const row = (label: string) =>
  w
    .findAll('.el-descriptions__label')
    .find((l) => l.text() === label)
    ?.element.nextElementSibling?.textContent?.trim()

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  // the generated modules' field labels (their fragments come with the generated task / run pages)
  i18n.global.mergeLocaleMessage('en-US', {
    field: {
      scheduler: {
        task: {
          name: 'Name',
          handler: 'Handler',
          cron: 'Cron',
          params: 'Params',
          misfire: 'Misfire',
        },
        run: { startedAt: 'Started at', outcome: 'Outcome' },
      },
    },
    scheduler: { handler: { audit: { purge: 'Purge audit logs' } } },
  })
})
afterEach(() => {
  w.unmount()
  vi.restoreAllMocks()
  setLocale('zh-CN')
})

describe('task detail', () => {
  it('shows the settings, the next fire times of its cron and its latest runs', async () => {
    const calls = backend()
    await mountDetail()
    expect(calls.find((c) => c.url === '/scheduler/runs')?.params).toEqual({
      taskId: 3,
      page: 1,
      pageSize: 10,
    })
    expect(calls.find((c) => c.url === '/scheduler/tasks/next-fire-times')?.params).toEqual({
      cron: '0 0 2 * * *',
    })

    expect(row('Name')).toBe('Nightly purge')
    expect(row('Group')).toBe('System')
    // the label, then the registry name below it; the cron, then its words below it
    expect(row('Handler')).toMatch(/^Purge audit logs\s*audit\.purge$/)
    expect(row('Cron')).toMatch(/^0 0 2 \* \* \*\s*At 02:00$/)
    expect(w.getComponent(CodeViewer).props('files')).toEqual([
      { path: 'params.json', content: '{\n  "days": 30\n}', language: 'json' },
    ])
    await vi.waitFor(() =>
      expect(w.find('.code-viewer__line span').attributes('style')).toContain('--shiki-light'),
    )
    expect(row('Enabled')).toBe('Disabled')
    expect(row('Allow overlap')).toBe('No')
    expect(row('Misfire')).toBe('Run once at start-up')
    expect(row('Retry delay (ms)')).toBe('1,500 ms')
    expect(row('Timeout (ms)')).toBe('60,000 ms')
    expect(row('Last fired')).toBe(dayjs(TASK.lastFireAt).format('YYYY-MM-DD HH:mm:ss'))

    // disabled: said so above the times it would fire
    expect(w.text()).toContain('Disabled: these are the times it would fire once enabled.')
    expect(w.findAll('.job-detail__times li').map((li) => li.text())).toEqual(
      TIMES.map((iso) => dayjs(iso).format('YYYY-MM-DD HH:mm:ss')),
    )

    const runs = w
      .findAll('.el-table__body .el-table__row')
      .map((r) => r.findAll('td').map((td) => td.text()))
    expect(runs.map((r) => r[1])).toEqual(['Failed', 'Timed out', 'Succeeded'])
    expect(runs[0]!.slice(2)).toEqual(['3', '1,200 ms', 'Error: connection refused'])
    expect(
      w
        .findAll('.el-table__header th')
        .map((th) => th.text())
        .slice(0, 2),
    ).toEqual(['Started at', 'Outcome'])
  })

  it('without the run log perm: no runs asked or shown; a label-less handler shows its name', async () => {
    const calls = backend({
      'GET /scheduler/tasks/3': ok({
        ...TASK,
        handler: 'biz.label-less',
        params: null,
        enabled: true,
      }),
    })
    await mountDetail({ id: 3, runs: false })
    expect(calls.some((c) => c.url === '/scheduler/runs')).toBe(false)
    expect(w.find('.el-table').exists()).toBe(false)
    expect(row('Handler')).toBe('biz.label-less')
    expect(w.findComponent(CodeViewer).exists()).toBe(false)
    expect(w.text()).not.toContain('Disabled: these are the times')
  })

  it.each([
    [[1, null], '[\n  1,\n  null\n]'],
    ['{"days":30}', '{"days":30}'],
    ['not JSON <script>alert(1)</script>', 'not JSON <script>alert(1)</script>'],
    [{ html: '<img src=x onerror=alert(1)>' }, '{\n  "html": "<img src=x onerror=alert(1)>"\n}'],
  ])('keeps params %j as read-only text', async (params, content) => {
    backend({ 'GET /scheduler/tasks/3': ok({ ...TASK, params }) })
    await mountDetail({ id: 3, runs: false })
    const viewer = w.getComponent(CodeViewer)
    expect(viewer.props('files')).toEqual([{ path: 'params.json', content, language: 'json' }])
    expect(
      viewer
        .findAll('.code-viewer__line')
        .map((line) =>
          line
            .findAll('span')
            .map((token) => token.element.textContent)
            .join(''),
        )
        .join('\n'),
    ).toBe(content)
    expect(viewer.findAll('input, textarea, [contenteditable], img, script')).toHaveLength(0)
    expect(viewer.find('.el-tree').exists()).toBe(false)
  })

  it.each([null, ''])('keeps empty params %j hidden', async (params) => {
    backend({ 'GET /scheduler/tasks/3': ok({ ...TASK, params }) })
    await mountDetail({ id: 3, runs: false })
    expect(w.findComponent(CodeViewer).exists()).toBe(false)
  })

  it('keeps the params file when the locale causes a parent render', async () => {
    backend()
    await mountDetail({ id: 3, runs: false })
    const files = w.getComponent(CodeViewer).props('files')
    setLocale('zh-CN')
    await flushPromises()
    expect(w.getComponent(CodeViewer).props('files')).toBe(files)
  })

  it('a task gone meanwhile leaves the drawer empty', async () => {
    backend({ 'GET /scheduler/tasks/3': [404, { code: 'A0404', msg: 'Not found', data: null }] })
    w = mount(JobDetail, { props: { id: 3 }, global: { plugins: [ElementPlus, i18n] } })
    await flushPromises()
    expect(w.find('.el-descriptions').exists()).toBe(false)
  })
})
