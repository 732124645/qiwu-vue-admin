import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { AgentItemVo, AgentTurnVo } from '@qiwu/shared'
import { agentOutputApi } from '@/api/platform/agent-output'
import { i18n, setLocale } from '@/core/i18n'
import ContextPanel from '@/views/platform/agent/chat/ContextPanel.vue'

const item = (id: number, kind: AgentItemVo['kind'], payload: object, status = 'done') =>
  ({
    id,
    seq: id,
    turnId: 1,
    kind,
    payload,
    status,
    createdAt: '2026-10-22T10:00:00Z',
  }) as AgentItemVo
const turn: AgentTurnVo = {
  id: 1,
  threadId: 7,
  status: 'waiting',
  steps: 3,
  promptTokens: 0,
  completionTokens: 0,
  credits: '0',
  unpricedCalls: 0,
  unreportedCalls: 0,
  legacyUsage: false,
  error: null,
  startedAt: '2026-10-22T10:00:00Z',
  endedAt: null,
}
const data = [
  item(3, 'plan', {
    steps: [
      { text: 'Current plan', status: 'doing' },
      { text: 'Write summary', status: 'pending' },
    ],
  }),
  item(4, 'tool_call', {
    callId: 'read',
    tool: 'custom.search',
    title: 'Search records',
    source: 'local',
    kind: 'read',
    args: {},
  }),
  item(5, 'tool_result', { callId: 'read', ok: true, preview: 'Found records', untrusted: false }),
  item(
    6,
    'tool_call',
    {
      callId: 'write',
      tool: 'custom.write',
      title: 'Update record',
      source: 'local',
      kind: 'write',
      args: {},
    },
    'pending',
  ),
  item(
    7,
    'approval',
    {
      callId: 'write',
      tool: 'custom.write',
      title: 'Update record',
      args: {},
      sources: [{ title: 'Approval-only source', url: 'https://approval.test/' }],
      perCallConfirmation: true,
    },
    'pending',
  ),
  item(8, 'assistant', {
    text: '# Overview\n\nSafe **answer** <script>bad()</script>',
    citations: [
      { title: 'First source', url: 'https://example.test/doc' },
      { title: 'Duplicate', url: 'HTTPS://EXAMPLE.test/doc' },
      { title: 'Unicode source', url: 'https://example.test/说明' },
      ...[
        null,
        'javascript:bad()',
        'data:text/html,bad',
        'file:///private/test',
        'mailto:reader@example.test',
        '/local',
        '//relative.test',
        'https://user:pass@secret.test/',
        'https://user@secret.test/',
        'https://:pass@secret.test/',
        'https://exa\nmple.test/control',
        'https://example.test/\u007f',
        'https://example.test/\u009f',
      ].map((url) => ({ title: 'Unsafe', url })),
    ],
  }),
  item(9, 'report', {
    title: 'Research report',
    text: '# Findings\n\nReport content.',
    citations: [{ title: 'Another source', url: 'https://source.test/report' }],
  }),
  item(10, 'chart', {
    title: 'Results',
    kind: 'table',
    categories: ['Count'],
    series: [{ name: 'Result', data: [2] }],
  }),
  item(11, 'image', { fileId: 55, prompt: 'Private generated illustration' }),
  item(1, 'plan', { steps: [{ text: 'Outdated plan', status: 'done' }] }),
]
let wrapper: VueWrapper
async function show(props: Partial<InstanceType<typeof ContextPanel>['$props']> = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  wrapper = mount(ContextPanel, {
    props: { items: data, turn, ...props },
    attachTo: document.body,
    global: { plugins: [ElementPlus, i18n, router], stubs: { QwChart: true } },
  })
  await flushPromises()
}
async function tab(name: string) {
  await wrapper
    .findAll('[role="tab"]')
    .find((node) => node.text() === name)!
    .trigger('click')
  await flushPromises()
}
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
})
afterEach(() => {
  wrapper?.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  setLocale('zh-CN')
})

describe('conversation context panel', () => {
  it('shows only the latest plan and visible tool states, without duplicating approval actions', async () => {
    await show()
    expect(wrapper.text()).toContain('Current plan')
    expect(wrapper.text()).not.toContain('Outdated plan')
    expect(wrapper.find('.agent-context__tools').text()).toContain('Search recordsDone')
    expect(wrapper.find('.agent-context__tools').text()).toContain('Update recordWaiting for you')
    expect(
      wrapper
        .findAll('button')
        .some((button) => /^(Approve|Reject|Run this plan)$/.test(button.text())),
    ).toBe(false)
    expect(wrapper.findComponent({ name: 'AgentApprovalCard' }).exists()).toBe(false)
  })
  it('deduplicates strict web sources and never fetches external metadata', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected metadata request'))
    await show()
    await tab('Sources')
    expect(
      wrapper.findAll('.agent-context__sources a').map((link) => link.attributes('href')),
    ).toEqual([
      'https://example.test/doc',
      'https://example.test/%E8%AF%B4%E6%98%8E',
      'https://source.test/report',
    ])
    for (const link of wrapper.findAll('.agent-context__sources a'))
      expect(link.attributes()).toMatchObject({ target: '_blank', rel: 'noopener noreferrer' })
    expect(wrapper.find('.agent-context__sources').text()).not.toContain('Approval-only source')
    expect(wrapper.findAll('img, script')).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('previews only a current item, reacts to replacements and clears old selection and sources', async () => {
    await show({ selectedId: 8 })
    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toBe('Outputs')
    expect(wrapper.find('.agent-context__preview .qw-md').text()).toContain('Safe answer')
    expect(wrapper.findAll('.agent-context__preview script')).toHaveLength(0)
    await wrapper.setProps({
      items: [
        item(20, 'assistant', {
          text: 'Other conversation',
          citations: [{ title: 'New source', url: 'https://new.test/' }],
        }),
      ],
      selectedId: null,
    })
    expect(wrapper.find('.agent-context__preview').exists()).toBe(false)
    await tab('Sources')
    expect(wrapper.find('.agent-context__sources').text()).toContain('New source')
    expect(wrapper.text()).not.toContain('First source')
    await wrapper.setProps({ selectedId: 8 })
    expect(wrapper.find('.agent-context__preview').exists()).toBe(false)
  })
  it('reuses artifact cards and keeps shared private images behind the original readonly boundary', async () => {
    const image = vi
      .spyOn(agentOutputApi, 'image')
      .mockRejectedValue(new Error('unexpected private image request'))
    await show({ selectedId: 11, readonly: true })
    expect(wrapper.text()).toContain(i18n.global.t('agent.output.image.shared'))
    expect(image).not.toHaveBeenCalled()
    expect(wrapper.find('img').exists()).toBe(false)
    await wrapper.setProps({ selectedId: 10 })
    await flushPromises()
    expect(wrapper.find('.agent-output__table').text()).toContain('Count')
    expect(wrapper.find('.agent-output__table').text()).toContain('2')
    await wrapper.find('.agent-context__outputs button').trigger('click')
    expect(wrapper.emitted('select')?.at(-1)).toEqual([9])
  })
})
