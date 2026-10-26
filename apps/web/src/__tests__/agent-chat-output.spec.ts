// The agent's output cards in the conversation: a chart (declarative options for QwChart, a table drawn as
// a table, xlsx export), a generated image (the private file fetched with the session, shown by a local URL),
// a research report (Markdown, numbered sources with the unverified ones marked, Markdown export, print as
// PDF with only the report, one xlsx export per table) and the subtasks card (status, summary, a link to the
// subtask's thread). Model text is only ever text; a shared snapshot offers no exports.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { AgentItemVo } from '@qiwu/shared'
import QwChart from '@/core/components/QwChart.vue'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import ChatItem from '@/views/platform/agent/chat/ChatItem.vue'
import { chartOption, reportMarkdown } from '@/views/platform/agent/chat/output'
import { chatRows } from '@/views/platform/agent/chat/thread-state'
import { mockApi } from './mock-api'

const AT = '2026-10-22T08:00:00.000Z'
const item = <K extends AgentItemVo['kind']>(
  id: number,
  kind: K,
  payload: Extract<AgentItemVo, { kind: K }>['payload'],
) => ({ id, seq: id, turnId: 1, kind, status: null, payload, createdAt: AT }) as AgentItemVo

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/agent/chat', component: { render: () => null } }],
})

let w: VueWrapper
const blobs: Blob[] = []
const downloads: string[] = []
async function render(i: AgentItemVo, readonly = false) {
  await router.push('/agent/chat')
  const [row] = chatRows([i])
  w = mount(ChatItem, {
    props: { row: row!, readonly },
    global: { plugins: [ElementPlus, i18n, router], stubs: { QwChart: true } },
  })
  await flushPromises()
  return w
}
const button = (text: string) => w.findAll('button').find((b) => b.text() === text)

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  blobs.length = 0
  URL.createObjectURL = vi.fn<(b: Blob) => string>((b) => {
    blobs.push(b)
    return `blob:${blobs.length}`
  })
  URL.revokeObjectURL = vi.fn<(url: string) => void>()
  downloads.length = 0
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download)
  })
})
afterEach(() => {
  w?.unmount()
  vi.restoreAllMocks()
  document.body.className = ''
  setLocale('zh-CN')
})

describe('chart', () => {
  const spec = {
    kind: 'bar' as const,
    title: 'Sales',
    categories: ['Q1', 'Q2'],
    series: [{ name: 'Tea', data: [3, '4.5'] as (number | string | null)[] }],
    unit: 'kg',
  }

  it('hands QwChart declarative options only and exports the data', async () => {
    const calls = mockApi({ 'GET /agent/items/5/xlsx': [200, new Blob(['xlsx'])] })
    await render(item(5, 'chart', spec))
    const chart = w.findComponent(QwChart)
    expect(chart.props('title')).toBe('Sales')
    expect(chart.props('option')).toMatchObject({
      tooltip: { renderMode: 'richText', trigger: 'axis' },
      xAxis: { data: ['Q1', 'Q2'] },
      yAxis: { name: 'kg' },
      series: [{ type: 'bar', name: 'Tea', data: [3, 4.5] }],
    })
    await button('Export to Excel')!.trigger('click')
    await flushPromises()
    expect(calls.map((c) => c.url)).toEqual(['/agent/items/5/xlsx'])
  })

  it('draws pies from one series and tables as tables, model text as text', async () => {
    expect(chartOption({ ...spec, kind: 'pie' }).series).toEqual([
      expect.objectContaining({
        type: 'pie',
        data: [
          { name: 'Q1', value: 3 },
          { name: 'Q2', value: 4.5 },
        ],
      }),
    ])
    await render(
      item(6, 'chart', {
        ...spec,
        kind: 'table',
        categories: ['Name', 'Note'],
        series: [{ name: 'r1', data: ['<b>Acme</b>', null] }],
      }),
      true,
    )
    expect(w.findComponent(QwChart).exists()).toBe(false)
    expect(w.findAll('th').map((c) => c.text())).toEqual(['Name', 'Note'])
    expect(w.find('td').text()).toBe('<b>Acme</b>')
    expect(w.find('td b').exists()).toBe(false)
    expect(button('Export to Excel')).toBeUndefined()
  })
})

describe('image', () => {
  it('shows the stored picture through a local URL and offers a download', async () => {
    const calls = mockApi({
      'GET /storage/objects/9/download': [200, new Blob(['webp'], { type: 'image/webp' })],
    })
    await render(item(7, 'image', { fileId: 9, prompt: 'a red teapot', width: 1024, height: 1024 }))
    expect(calls[0]!.params).toEqual({ inline: true })
    const img = w.find('img')
    expect(img.attributes('src')).toBe('blob:1')
    expect(img.attributes('alt')).toBe('a red teapot')
    await button('Download')!.trigger('click')
    // named after the picture's actual type
    expect(downloads).toEqual(['a red teapot.webp'])
    w.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1')
  })

  it('a shared snapshot does not fetch the picture and says why', async () => {
    const calls = mockApi({})
    await render(item(14, 'image', { fileId: 11, prompt: 'shared' }), true)
    expect(calls).toEqual([])
    expect(w.text()).toContain('Images are not shown in a shared view')
    expect(w.text()).not.toContain('could not be loaded')
  })

  it('says so when the picture cannot be read', async () => {
    mockApi({})
    await render(item(8, 'image', { fileId: 10, prompt: 'gone' }))
    expect(w.find('img').exists()).toBe(false)
    expect(w.text()).toContain('The image could not be loaded')
  })
})

describe('report', () => {
  const report = {
    title: 'Tea market',
    text: 'Tea grows [1] <script>x</script>.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nMore.\n\n| C |\n|---|\n| 3 |',
    citations: [
      { title: 'Source A', url: 'https://example.com/a' },
      { title: 'Made up', url: '' },
    ],
  }

  it('renders the text and sources, marks unverified ones, exports Markdown and each table', async () => {
    const calls = mockApi({
      'GET /agent/items/11/xlsx': [200, new Blob(['xlsx'])],
    })
    await render(item(11, 'report', report))
    expect(w.find('h3').text()).toBe('Tea market')
    expect(w.text()).toContain('<script>x</script>')
    expect(w.find('script').exists()).toBe(false)
    const sources = w.findAll('.agent-report__sources li')
    expect(sources[0]!.find('a').attributes()).toMatchObject({
      href: 'https://example.com/a',
      rel: 'noopener noreferrer',
    })
    expect(sources[1]!.find('a').exists()).toBe(false)
    expect(sources[1]!.text()).toContain('Unverified')

    await button('Export Markdown')!.trigger('click')
    expect(await blobs.at(-1)!.text()).toBe(reportMarkdown(report))
    expect(reportMarkdown(report)).toContain('1. [Source A](https://example.com/a)\n2. Made up')

    await button('Export table 2')!.trigger('click')
    await flushPromises()
    expect(calls.at(-1)).toMatchObject({ url: '/agent/items/11/xlsx', params: { table: 1 } })
    expect(button('Export table 1')).toBeDefined()
  })

  it('prints only the report', async () => {
    await render(item(12, 'report', report))
    const seen: boolean[] = []
    const print = vi.fn<() => void>(() => {
      seen.push(
        document.body.classList.contains('qw-print-report'),
        w.find('article').classes().includes('qw-print-target'),
      )
    })
    window.print = print
    await button('Print as PDF')!.trigger('click')
    expect(print).toHaveBeenCalledOnce()
    expect(seen).toEqual([true, true])
    window.dispatchEvent(new Event('afterprint'))
    expect(document.body.classList.contains('qw-print-report')).toBe(false)
    expect(w.find('article').classes()).not.toContain('qw-print-target')
  })
})

describe('subagents', () => {
  it('groups each subtask by real status and opens details without a new window', async () => {
    await render(
      item(13, 'subagent', {
        callId: 'c1',
        tasks: [
          { title: 'Prices', threadId: 41, status: 'completed', summary: 'Prices rose.' },
          { title: 'Makers', threadId: 42, status: 'running' },
          { title: 'Stopped one', threadId: 43, status: 'cancelled' },
        ],
      }),
    )
    const tasks = w.findAll('.agent-subtasks__list > li')
    expect(tasks).toHaveLength(3)
    expect(tasks[2]!.text()).toContain('Stopped')
    expect(tasks[0]!.text()).toContain('Done')
    expect(tasks[0]!.find('details').text()).toContain('Prices rose.')
    expect(tasks[1]!.text()).toContain('Running')
    expect(tasks[1]!.find('details').exists()).toBe(false)
    expect(w.text()).toContain('Active 1 · Finished 2')
    await tasks[0]!.find('button').trigger('click')
    expect(w.emitted('inspectChild')).toEqual([[41]])
    expect(w.find('a').exists()).toBe(false)
    await w.setProps({ readonly: true })
    expect(tasks[0]!.find('button').attributes('disabled')).toBeDefined()
  })
})
