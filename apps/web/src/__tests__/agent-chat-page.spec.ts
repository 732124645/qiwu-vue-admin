// The assistant's chat page: the thread list (groups, search, rename, archive, delete after confirming,
// load more), opening a thread and its live events (items added or replaced, streamed text, the turn),
// catching up with afterSeq after a reconnect or a delta for an unknown item, sending (a new thread with
// the context the entry button brought, queued while a turn runs), stop, fork, the composer's slash
// commands and `$skill` completion, the notices when nothing is configured or the agent is paused, and the
// global entry button that carries the page and its published selection.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElDropdown, ElMessage, ElMessageBox } from 'element-plus'
import type { AgentItemVo, AgentOptionsVo, AgentThreadVo, AgentTurnVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken, ApiError } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { useMenuStore } from '@/core/stores/menu'
import FileUpload from '@/core/components/FileUpload.vue'
import InboxMessageView from '@/core/layout/InboxMessageView.vue'
import AgentEntry from '@/views/platform/agent/chat/AgentEntry.vue'
import SubtaskDetail from '@/views/platform/agent/chat/SubtaskDetail.vue'
import { agentApi } from '@/api/platform/agent'
import { clearHistory, pushHistory } from '@/views/platform/agent/chat/thread-state'
import ChatPage from '@/views/platform/agent/chat/index.vue'
import {
  pendingContext,
  pendingRoute,
  useAgentContext,
} from '@/views/platform/agent/chat/use-agent-context'
import { me, mockApi, node, ok, fail, type Route } from './mock-api'

/** the fake socket: one handler per type, and the connection state the page watches */
const rt = vi.hoisted(() => ({ handlers: new Map<string, (payload: unknown) => void>() }))
vi.mock('@/core/realtime/socket', async () => {
  const { shallowRef } = await import('vue')
  return {
    realtimeStatus: shallowRef('up'),
    onRealtime: (type: string, fn: (payload: unknown) => void) => {
      rt.handlers.set(type, fn)
      return () => rt.handlers.delete(type)
    },
  }
})
const socket = await import('@/core/realtime/socket')
const push = (payload: unknown) => rt.handlers.get('agent:event')!(payload)

const NOW = new Date().toISOString()
const OLD = '2026-01-05T08:00:00.000Z'
const thread = (id: number, p: Partial<AgentThreadVo> = {}): AgentThreadVo => ({
  id,
  title: `Thread ${id}`,
  status: 'active',
  providerId: 1,
  model: 'm1',
  reasoning: null,
  approvalMode: 'ask',
  planMode: false,
  pinned: false,
  temporary: false,
  unread: 0,
  shared: false,
  forkedFromId: null,
  profileId: null,
  memoryEnabled: true,
  parentThreadId: null,
  automationRunId: null,
  batchId: null,
  turnStatus: 'completed',
  lastActiveAt: NOW,
  createdAt: NOW,
  ...p,
})
const turn = (p: Partial<AgentTurnVo> = {}): AgentTurnVo => ({
  id: 1,
  threadId: 7,
  status: 'completed',
  steps: 3,
  promptTokens: 1200,
  completionTokens: 340,
  credits: '0.123456',
  unpricedCalls: 0,
  unreportedCalls: 0,
  legacyUsage: false,
  error: null,
  startedAt: NOW,
  endedAt: NOW,
  ...p,
})
const item = (
  id: number,
  seq: number,
  kind: string,
  payload: object,
  status: string | null = null,
) => ({ id, seq, turnId: 1, kind, status, payload, createdAt: NOW }) as AgentItemVo
const ITEMS = [
  item(1, 1, 'user', { text: 'Who is Acme?' }),
  item(2, 2, 'assistant', { text: 'Acme is' }, 'running'),
]
const OPTIONS: AgentOptionsVo = {
  providers: [
    {
      id: 1,
      name: 'DeepSeek',
      models: [
        {
          id: 'm1',
          label: 'Chat',
          reasoning: true,
          vision: false,
          fast: false,
          contextWindow: 64000,
        },
        {
          id: 'm2',
          label: 'Flash',
          reasoning: false,
          vision: true,
          fast: true,
          contextWindow: 32000,
        },
      ],
    },
  ],
  defaults: { providerId: 1, model: 'm1' },
  skills: [
    { name: 'fill-customer', description: 'Fill in customer details', scope: 'platform' },
    { name: 'report', description: 'Weekly report', scope: 'user' },
  ],
  approvalModes: ['read_only', 'ask', 'trust'],
  webSearch: true,
  paused: false,
  starters: ['Summarize this month', 'Find customers without a phone'],
  prompts: [{ id: 1, name: 'Weekly', body: 'Write the weekly report for {team}' }],
  trustSession: true,
  servers: [],
  tone: 'default',
}
const BASE: Record<string, Route> = {
  'GET /agent/options': ok(OPTIONS),
  'GET /agent/threads': ok({
    items: [thread(7), thread(8, { title: 'Old one', lastActiveAt: OLD })],
    total: 2,
  }),
  'GET /agent/threads/7/items': ok({
    thread: thread(7),
    items: ITEMS,
    turn: turn({ status: 'running' }),
  }),
  'GET /agent/threads/7/status': ok({
    threadId: 7,
    model: 'm1',
    contextUsed: 12000,
    contextWindow: 64000,
    turn: turn({ status: 'running' }),
    today: {
      userTokens: 5000,
      tenantTokens: 9000,
      userCredits: '1.5',
      tenantCredits: '2.75',
      userLimit: '0',
      tenantLimit: '10',
      userUnpricedCalls: 1,
      tenantUnpricedCalls: 2,
    },
  }),
}
type Call = { method?: string; url?: string; params?: unknown; data?: unknown }
const sent = (calls: Call[], method: string, url: string) =>
  calls.filter((c) => c.method === method && c.url === url)
const body = (c: Call | undefined) => JSON.parse(String(c?.data)) as unknown
const received = (clientMessageId: string) => ({
  clientMessageId,
  threadId: 7,
  itemId: 20,
  turnId: 1,
  status: 'accepted' as const,
  turn: turn({ status: 'running' }),
})

let w: VueWrapper
let router: Router
async function show(path = '/') {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'agent-chat', component: { render: () => null } },
      { path: '/other', name: 'other', component: { render: () => null } },
      { path: '/skills', name: 'agent-skill', component: { render: () => null } },
    ],
  })
  await router.push(path)
  w = mount(ChatPage, {
    global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
    attachTo: document.body,
  })
  await flushPromises()
}
const button = (text: string) => w.findAll('button').find((b) => b.text() === text)
const threadButton = (title: string) =>
  w.findAll('.agent-threads__open').find((b) => b.text().includes(title))!
async function open(title = 'Thread 7') {
  await threadButton(title).trigger('click')
  await flushPromises()
}
const textarea = () => w.find('textarea')
async function type(text: string) {
  await textarea().setValue(text)
  await flushPromises()
}
async function key(k: string, extra = {}) {
  await textarea().trigger('keydown', { key: k, ...extra })
  await flushPromises()
}
const suggestions = () =>
  w
    .findAll('.agent-composer__suggest [role="option"]')
    .map((o) => o.find('.agent-composer__label').text())

beforeEach(() => {
  clearHistory()
  sessionStorage.clear()
  localStorage.removeItem('qw.agent.layout.1')
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  useAuthStore().me = me(['*'])
  socket.realtimeStatus.value = 'up'
  pendingContext.value = null
  pendingRoute.value = null
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'warning').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'info').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  w?.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('thread list', () => {
  it('lists the own active threads by day, searches, loads more', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /agent/threads': (c) =>
        (c.params as { page: number }).page === 1
          ? ok({ items: [thread(7), thread(8, { title: 'Old one', lastActiveAt: OLD })], total: 3 })
          : ok({ items: [thread(9, { title: 'Third', lastActiveAt: OLD })], total: 3 }),
    })
    await show()
    expect(sent(calls, 'get', '/agent/threads')[0]!.params).toEqual({
      page: 1,
      pageSize: 30,
      sort: '-lastActiveAt',
      status: 'active',
      view: 'all',
    })
    expect(w.findAll('.agent-threads__label').map((l) => l.text())).toEqual(['Today', 'Older'])
    await button('Load more')!.trigger('click')
    await flushPromises()
    expect(w.findAll('.agent-threads__open').map((b) => b.text())).toEqual([
      'Thread 7',
      'Old one',
      'Third',
    ])
    expect(button('Load more')).toBeUndefined()

    vi.useFakeTimers()
    await w.find('input[aria-label="Search conversations"]').setValue('acme')
    await vi.advanceTimersByTimeAsync(400)
    vi.useRealTimers()
    await flushPromises()
    expect(sent(calls, 'get', '/agent/threads').at(-1)!.params).toMatchObject({
      page: 1,
      keyword: 'acme',
    })
  })

  it('renames inline, archives and deletes after confirming', async () => {
    const calls = mockApi({
      ...BASE,
      'PATCH /agent/threads/7': (c) =>
        ok(thread(7, JSON.parse(String(c.data)) as Partial<AgentThreadVo>)),
      'DELETE /agent/threads/8': ok(null),
    })
    await show()
    await open()
    const dropdowns = w.findAllComponents(ElDropdown)
    dropdowns[0]!.vm.$emit('command', 'rename')
    await flushPromises()
    const input = w.find('.agent-threads__rename input')
    await input.setValue('Acme research')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(body(sent(calls, 'patch', '/agent/threads/7')[0])).toEqual({ title: 'Acme research' })
    expect(threadButton('Acme research').exists()).toBe(true)

    // archiving the open thread leaves the list and closes it
    w.findAllComponents(ElDropdown)[0]!.vm.$emit('command', 'archive')
    await flushPromises()
    expect(body(sent(calls, 'patch', '/agent/threads/7')[1])).toEqual({ status: 'archived' })
    expect(w.findAll('.agent-threads__open').map((b) => b.text())).toEqual(['Old one'])
    expect(w.find('.agent-chat__title').text()).toBe('New conversation')

    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel')
    w.findAllComponents(ElDropdown)[0]!.vm.$emit('command', 'remove')
    await flushPromises()
    expect(sent(calls, 'delete', '/agent/threads/8')).toHaveLength(0)
    confirm.mockResolvedValueOnce('confirm' as never)
    w.findAllComponents(ElDropdown)[0]!.vm.$emit('command', 'remove')
    await flushPromises()
    expect(confirm.mock.calls[1]![0]).toContain('Old one')
    expect(sent(calls, 'delete', '/agent/threads/8')).toHaveLength(1)
    expect(w.findAll('.agent-threads__open')).toHaveLength(0)
  })
})

describe('conversation', () => {
  it('opens a thread, streams text into the answer, adds and replaces items, follows the turn', async () => {
    const calls = mockApi(BASE)
    await show()
    await open()
    expect(router.currentRoute.value.query).toEqual({ thread: '7' })
    expect(w.find('.agent-msg--user').text()).toContain('Who is Acme?')
    expect(w.find('.agent-chat__turn').text()).toBe('Running')
    expect(button('Stop')).toBeDefined()

    push({ threadId: 7, type: 'delta', itemId: 2, delta: ' a **company**.' })
    await flushPromises()
    expect(w.find('.agent-msg--assistant').text()).toBe('Acme is a company.')
    expect(w.find('.agent-msg--assistant strong').text()).toBe('company')
    // another thread's events do not touch this one
    push({ threadId: 8, type: 'delta', itemId: 2, delta: 'nope' })
    push({
      threadId: 7,
      type: 'item',
      item: item(3, 3, 'tool_call', {
        callId: 'c',
        tool: 'web.search',
        title: 'Web search',
        source: 'web',
        kind: 'read',
        args: {},
      }),
    })
    await flushPromises()
    expect(w.find('.agent-msg--assistant').text()).toBe('Acme is a company.')
    expect(w.find('summary').text()).toContain('Search the web')
    push({
      threadId: 7,
      type: 'item',
      item: item(2, 2, 'assistant', { text: 'Rewritten' }, 'done'),
    })
    push({ threadId: 7, type: 'turn', turn: turn({ status: 'completed' }) })
    await flushPromises()
    expect(w.find('.agent-msg--assistant').text()).toBe('Rewritten')
    expect(w.find('.agent-chat__turn').text()).toBe('Completed')
    expect(button('Stop')).toBeUndefined()
    // 终态补拉会话恢复标记，旧快照不能把刚收到的正文或轮次状态推回去。
    expect(sent(calls, 'get', '/agent/threads/7/items')).toHaveLength(2)
  })

  it('catches up with afterSeq after a reconnect and after a delta for an unknown item', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /agent/threads/7/items': (c) =>
        (c.params as { afterSeq?: number } | undefined)?.afterSeq == null
          ? ok({ thread: thread(7), items: ITEMS, turn: turn({ status: 'running' }) })
          : ok({
              thread: thread(7),
              items: [
                item(2, 2, 'assistant', { text: 'Acme is a maker of anvils.' }, 'done'),
                item(4, 3, 'assistant', { text: 'More' }, 'running'),
              ],
              turn: turn({ status: 'running' }),
            }),
    })
    await show()
    await open()
    socket.realtimeStatus.value = 'reconnecting'
    await flushPromises()
    socket.realtimeStatus.value = 'up'
    await flushPromises()
    // item 2 was still streaming: fetched again from before it
    expect(sent(calls, 'get', '/agent/threads/7/items').at(-1)!.params).toEqual({ afterSeq: 1 })
    expect(w.findAll('.agent-msg--assistant').map((m) => m.text())).toEqual([
      'Acme is a maker of anvils.',
      'More',
    ])

    push({ threadId: 7, type: 'delta', itemId: 99, delta: 'lost' })
    await flushPromises()
    expect(sent(calls, 'get', '/agent/threads/7/items').at(-1)!.params).toEqual({ afterSeq: 2 })
  })

  it('restores the thread named in the address after a reload', async () => {
    const calls = mockApi(BASE)
    await show('/?thread=7')
    expect(sent(calls, 'get', '/agent/threads/7/items')).toHaveLength(1)
    expect(w.find('.agent-chat__title').text()).toBe('Thread 7')
  })

  it('sends in a new thread with the brought context, then queues while the turn runs, and stops', async () => {
    pendingContext.value = {
      route: '/demo/customers',
      title: 'Customers',
      target: 'demo.customer',
      ids: [3, 4],
    }
    let release = () => {}
    const calls = mockApi({
      ...BASE,
      'POST /agent/threads': ok(thread(9, { title: 'Fill them' })),
      'POST /agent/threads/9/messages': async () => {
        await new Promise<void>((r) => (release = r))
        return ok(turn({ id: 5, threadId: 9, status: 'running' }))
      },
      'GET /agent/threads/9/items': ok({
        thread: thread(9, { title: 'Fill them' }),
        items: [item(10, 1, 'user', { text: 'Fill them' })],
        turn: turn({ id: 5, threadId: 9, status: 'running' }),
      }),
      'POST /agent/threads/9/cancel': ok(null),
    })
    await show()
    expect(w.find('.agent-chat__context').text()).toMatch(/From: Customers\s*· 2 selected/)
    await type('Fill them')
    await key('Enter')
    // no title: the server names the thread after its first turn
    expect(body(sent(calls, 'post', '/agent/threads')[0])).toEqual({
      clientDraftId: expect.any(String),
      approvalMode: 'ask',
      planMode: false,
      providerId: 1,
      model: 'm1',
      context: {
        route: '/demo/customers',
        title: 'Customers',
        target: 'demo.customer',
        ids: [3, 4],
      },
    })
    // pending: the send button spins and is disabled, a second Enter sends nothing
    const send = w.findAll('.agent-composer__bar button').at(-1)!
    expect(send.attributes('disabled')).toBeDefined()
    await key('Enter')
    release()
    await flushPromises()
    expect(sent(calls, 'post', '/agent/threads/9/messages')).toHaveLength(1)
    expect(body(sent(calls, 'post', '/agent/threads/9/messages')[0])).toEqual({
      clientMessageId: expect.any(String),
      text: 'Fill them',
    })
    expect(sent(calls, 'get', '/agent/threads/9/items')[0]!.params).toEqual({ afterSeq: 0 })
    expect(textarea().element.value).toBe('')
    expect(w.find('.agent-chat__context').exists()).toBe(false)
    expect(threadButton('Fill them').exists()).toBe(true)

    // running: the text is queued after the current step
    expect(w.text()).toContain('what you send now is handled after its current step')
    // while running the text joins the turn by default, or waits for the next one
    await w
      .findAll('.el-radio-button')
      .find((b) => b.text() === 'Queue for next turn')!
      .find('input')
      .setValue(true)
    await type('Then the phone')
    await key('Enter')
    release()
    await flushPromises()
    expect(body(sent(calls, 'post', '/agent/threads/9/messages')[1])).toEqual({
      clientMessageId: expect.any(String),
      text: 'Then the phone',
      mode: 'queue',
    })
    await button('Stop')!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/agent/threads/9/cancel')).toHaveLength(1)
  })

  it('keeps the text when sending fails, Shift+Enter does not send', async () => {
    const calls = mockApi({
      ...BASE,
      'POST /agent/threads/7/messages': [422, { code: 'B8003', msg: 'limit', data: null }],
    })
    await show()
    await open()
    await type('Hello')
    await key('Enter', { shiftKey: true })
    expect(sent(calls, 'post', '/agent/threads/7/messages')).toHaveLength(0)
    await key('Enter')
    expect(sent(calls, 'post', '/agent/threads/7/messages')).toHaveLength(1)
    expect(textarea().element.value).toBe('Hello')
  })

  it('forks from a message into a new thread and opens it', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /agent/threads/7/items': ok({ thread: thread(7), items: ITEMS, turn: turn() }),
      'POST /agent/threads/7/fork': ok(thread(11, { title: 'Fork', forkedFromId: 7 })),
      'GET /agent/threads/11/items': ok({
        thread: thread(11, { title: 'Fork' }),
        items: [ITEMS[0]],
        turn: null,
      }),
    })
    await show()
    await open()
    await w
      .find('.agent-msg--user button[aria-label="Fork a new conversation from here"]')
      .trigger('click')
    await flushPromises()
    expect(body(sent(calls, 'post', '/agent/threads/7/fork')[0])).toEqual({
      seq: 1,
      clientDraftId: expect.any(String),
    })
    expect(w.find('.agent-chat__title').text()).toBe('Fork')
    expect(router.currentRoute.value.query).toEqual({ thread: '11' })
  })

  it('says so when no model is configured or the agent is paused, with starter prompts', async () => {
    mockApi({ ...BASE, 'GET /agent/options': ok({ ...OPTIONS, defaults: null }) })
    await show()
    expect(w.text()).toContain('No model is configured yet')
    expect(textarea().attributes('disabled')).toBeDefined()
    w.unmount()
    mockApi({ ...BASE, 'GET /agent/options': ok({ ...OPTIONS, paused: true }) })
    await show()
    expect(w.text()).toContain('paused by the platform')
    expect(textarea().attributes('disabled')).toBeDefined()
    w.unmount()
    mockApi(BASE)
    await show()
    await w.findAll('.agent-chat__examples button')[1]!.trigger('click')
    await flushPromises()
    expect(textarea().element.value).toBe('Find customers without a phone')
  })

  it('keeps only labelled buttons in the header and the rest in the settings popover and More menu', async () => {
    mockApi({
      ...BASE,
      'GET /agent/threads/7/items': ok({ thread: thread(7), items: ITEMS, turn: turn() }),
    })
    await show()
    const head = w.find('.agent-chat__head')
    for (const label of ['Work panel', 'Focus mode', 'Conversation settings'])
      expect(head.findAll('button').some((b) => b.text() === label)).toBe(true)
    for (const label of ['Keyboard shortcuts', 'Notification settings', 'Open in a new window'])
      expect(head.find(`button[aria-label="${label}"]`).exists()).toBe(false)
    const toggle = w.find('.agent-chat__settings-toggle')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')
    // the popover opens after its (zero) show delay
    await wait(10)
    expect(toggle.attributes('aria-expanded')).toBe('true')
    const pop = w.find('.agent-settings')
    // 名称在弹层的 dialog 元素本身上
    expect(pop.attributes('role')).toBe('dialog')
    expect(pop.attributes('aria-label')).toBe('Conversation settings')
    expect(pop.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
      'Conversation',
      'Notifications',
      'Keyboard shortcuts',
    ])
    expect(pop.find('input[aria-label="Temporary conversation"]').exists()).toBe(true)
    // the open conversation: no temporary switch, its actions in More
    await open()
    expect(pop.find('input[aria-label="Temporary conversation"]').exists()).toBe(false)
    expect(head.findComponent(ElDropdown).exists()).toBe(true)
  })
})

describe('layout', () => {
  const KEY = 'qw.agent.layout.1'
  const separator = (name: string) => w.find(`[role="separator"][aria-label="${name}"]`)
  const saved = () => JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>

  it('resizes the list by keyboard within its bounds, restores it on double-click and remembers it', async () => {
    mockApi(BASE)
    await show()
    const list = separator('Resize the conversation list')
    expect(list.attributes()).toMatchObject({
      tabindex: '0',
      'aria-orientation': 'vertical',
      'aria-valuenow': '260',
      'aria-valuemin': '220',
      'aria-valuemax': '420',
    })
    await list.trigger('keydown', { key: 'ArrowRight' })
    expect(list.attributes('aria-valuenow')).toBe('276')
    expect(w.find<HTMLElement>('.agent-threads').element.style.width).toBe('276px')
    await list.trigger('keydown', { key: 'End' })
    await list.trigger('keydown', { key: 'ArrowRight', shiftKey: true })
    expect(list.attributes('aria-valuenow')).toBe('420')
    await list.trigger('keydown', { key: 'Home' })
    await list.trigger('keydown', { key: 'ArrowLeft' })
    expect(list.attributes('aria-valuenow')).toBe('220')
    await flushPromises()
    expect(saved()).toMatchObject({ list: 220 })
    w.unmount()
    await show()
    expect(separator('Resize the conversation list').attributes('aria-valuenow')).toBe('220')
    await separator('Resize the conversation list').trigger('dblclick')
    expect(separator('Resize the conversation list').attributes('aria-valuenow')).toBe('260')
  })

  it('a pointer drag writes the layout once, when the drag ends', async () => {
    mockApi(BASE)
    await show()
    const writes = vi.spyOn(localStorage, 'setItem')
    const layoutWrites = () => writes.mock.calls.filter(([key]) => key === KEY).length
    const list = separator('Resize the conversation list')
    list.element.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100 }))
    for (const x of [110, 120, 130]) {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: x }))
      await flushPromises()
    }
    expect(list.attributes('aria-valuenow')).toBe('290')
    expect(layoutWrites()).toBe(0)
    window.dispatchEvent(new PointerEvent('pointerup'))
    await flushPromises()
    expect(layoutWrites()).toBe(1)
    expect(saved()).toMatchObject({ list: 290 })
  })

  it('folds the list into a rail that stays, and the panel splitter widens the panel to the left', async () => {
    mockApi(BASE)
    await show()
    await w.find('button[aria-label="Collapse the conversation list"]').trigger('click')
    await flushPromises()
    expect(w.find('.agent-threads').isVisible()).toBe(false)
    expect(separator('Resize the conversation list').exists()).toBe(false)
    expect(saved()).toMatchObject({ listCollapsed: true })
    w.unmount()
    await show()
    const expand = w.find('.agent-chat__rail button[aria-label="Expand the conversation list"]')
    expect(expand.attributes('aria-expanded')).toBe('false')

    await w.find('.agent-chat__panel-toggle').trigger('click')
    const panel = separator('Resize the side panel')
    expect(panel.attributes('aria-valuenow')).toBe('380')
    // the panel sits right of its splitter: moving the splitter left makes it wider
    await panel.trigger('keydown', { key: 'ArrowLeft' })
    expect(panel.attributes('aria-valuenow')).toBe('396')
    expect(w.find<HTMLElement>('.agent-chat__panel').element.style.width).toBe('396px')
    await expand.trigger('click')
    expect(w.find('.agent-threads').isVisible()).toBe(true)
    expect(w.find('.agent-chat__rail').exists()).toBe(false)
  })

  it('focus mode covers the app chrome until Esc or the button, and is remembered', async () => {
    mockApi(BASE)
    await show()
    const button = () => w.find('.agent-chat__focus-toggle')
    expect(button().attributes('aria-pressed')).toBe('false')
    await button().trigger('click')
    expect(w.find('.agent-chat').classes()).toContain('agent-chat--focus')
    expect(button().text()).toBe('Exit focus')
    await flushPromises()
    expect(saved()).toMatchObject({ focus: true })
    w.unmount()
    await show()
    expect(w.find('.agent-chat').classes()).toContain('agent-chat--focus')
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(w.find('.agent-chat').classes()).not.toContain('agent-chat--focus')
    await button().trigger('click')
    await button().trigger('click')
    expect(w.find('.agent-chat').classes()).not.toContain('agent-chat--focus')
  })

  it('moves the work panel and a subtask into the main area and back to the conversation', async () => {
    mockApi({
      ...BASE,
      'GET /agent/threads/7/items': ok({
        thread: thread(7),
        turn: turn(),
        items: [
          ...ITEMS,
          item(10, 10, 'subagent', {
            callId: 'children',
            tasks: [{ title: 'Check stock', threadId: 41, status: 'running' }],
          }),
        ],
      }),
      'GET /agent/threads/41/items': ok({
        thread: thread(41, { parentThreadId: 7, title: 'Check stock' }),
        turn: turn({ threadId: 41 }),
        items: [item(21, 1, 'assistant', { text: 'Stock is available.' }, 'done')],
      }),
    })
    await show()
    await open()
    await type('draft kept')
    await w.find('.agent-subtasks__task').trigger('click')
    await flushPromises()
    // a subtask card opens in the side panel first
    expect(w.find('.agent-chat__panel .agent-child').exists()).toBe(true)
    expect(w.find('.agent-chat__main').isVisible()).toBe(true)
    await w.find('.agent-child button[aria-label="Open in the main area"]').trigger('click')
    expect(w.find('.agent-chat__main').isVisible()).toBe(false)
    expect(separator('Resize the side panel').exists()).toBe(false)
    expect(w.find('.agent-chat__crumb-list').text()).toBe('Thread 7Subtask details')
    await w.find('.agent-child button[aria-label="Back to the side panel"]').trigger('click')
    expect(w.find('.agent-chat__main').isVisible()).toBe(true)
    expect(separator('Resize the side panel').exists()).toBe(true)
    await w.find('.agent-child button[aria-label="Back to main task"]').trigger('click')
    // the work panel goes to the main area too; back to the conversation closes it
    await w.find('.agent-chat__panel-toggle').trigger('click')
    await w.find('.agent-context button[aria-label="Open in the main area"]').trigger('click')
    expect(w.find('.agent-chat__crumb-list').text()).toBe('Thread 7Work panel')
    expect(w.find('.agent-chat__main').isVisible()).toBe(false)
    await w
      .findAll('.agent-chat__crumbs button')
      .find((b) => b.text() === 'Back to the conversation')!
      .trigger('click')
    expect(w.find('.agent-context').exists()).toBe(false)
    expect(w.find('.agent-chat__main').isVisible()).toBe(true)
    expect(textarea().element.value).toBe('draft kept')
    // reopened, the panel starts in the side again
    await w.find('.agent-chat__panel-toggle').trigger('click')
    expect(w.find('.agent-chat__main').isVisible()).toBe(true)
  })
})

describe('composer', () => {
  it('keeps keyboard candidates visible through loops and filtering without moving page or focus', async () => {
    mockApi(BASE)
    await show()
    await type('/')
    const list = w.find<HTMLUListElement>('.agent-composer__suggest').element
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 80 })
    for (const row of Array.from(list.children)) {
      Object.defineProperty(row, 'offsetTop', {
        configurable: true,
        get: () => Array.from(list.children).indexOf(row) * 32,
      })
      Object.defineProperty(row, 'offsetHeight', { configurable: true, value: 32 })
    }
    textarea().element.focus()
    const pageScroll = document.documentElement.scrollTop
    const movePage = vi.spyOn(window, 'scrollTo')
    await key('ArrowUp')
    expect(w.find('.agent-composer__suggest [aria-selected="true"]').text()).toContain('/clear')
    expect(list.scrollTop).toBe(240)
    expect(document.activeElement).toBe(textarea().element)
    await key('ArrowDown')
    expect(w.find('.agent-composer__suggest [aria-selected="true"]').text()).toContain('/new')
    expect(list.scrollTop).toBe(0)
    for (let i = 0; i < 9; i++) await key('ArrowDown')
    expect(list.scrollTop).toBe(240)
    await type('/c')
    expect(suggestions()).toEqual(['/compact', '/clear'])
    expect(w.find('.agent-composer__suggest [aria-selected="true"]').text()).toContain('/compact')
    expect(list.scrollTop).toBe(0)
    expect(document.activeElement).toBe(textarea().element)
    expect(document.documentElement.scrollTop).toBe(pageScroll)
    expect(movePage).not.toHaveBeenCalled()
  })

  it('shows the complete skill name and multiline description on hover', async () => {
    const skill = {
      name: `record-${'x'.repeat(57)}`,
      description: `First paragraph ${'description '.repeat(35)}\nSecond paragraph with details`,
      scope: 'user',
    }
    mockApi({ ...BASE, 'GET /agent/options': ok({ ...OPTIONS, skills: [skill] }) })
    await show()
    await type('$')
    await w.find('.agent-composer__suggest [role="option"]').trigger('mouseenter')
    await vi.waitFor(() => {
      const tooltip = document.querySelector('.agent-composer__tooltip')
      expect(tooltip?.textContent).toContain(`$${skill.name}`)
      expect(tooltip?.textContent).toContain(skill.description)
    })
  })

  it('slash commands: completion, /status, /compact, /new and /mcp without the settings page', async () => {
    const calls = mockApi({ ...BASE, 'POST /agent/threads/7/compact': ok(null) })
    await show()
    await open()
    await type('/')
    expect(suggestions()).toEqual([
      '/new',
      '/compact',
      '/model',
      '/approvals',
      '/plan',
      '/skills',
      '/prompts',
      '/mcp',
      '/status',
      '/clear',
    ])
    await type('/st')
    expect(suggestions()).toEqual(['/status'])
    await key('Enter')
    expect(textarea().element.value).toBe('')
    const status = w.find('.agent-chat__status').text()
    expect(status).toContain('1200 in / 340 out')
    expect(status).toContain('Running')
    expect(status).toContain('Your credits today1.5 / Unlimited')
    expect(status).toContain('Turn credits0.123456')
    expect(status).toContain('Tenant credits today2.75 / 10')
    expect(status).toContain('Context estimate 19%12000 / 64000')

    await type('/compact')
    await key('Enter')
    expect(sent(calls, 'post', '/agent/threads/7/compact')).toHaveLength(1)
    expect(ElMessage.success).toHaveBeenCalledWith('Earlier messages were compacted')

    await type('/mcp')
    await key('Tab')
    expect(ElMessage.warning).toHaveBeenCalledWith('You have no access to the Agent settings page')

    // Escape closes the list; the text then sends as typed
    await type('/c')
    expect(suggestions()).toEqual(['/compact', '/clear'])
    await key('ArrowDown')
    await key('Enter')
    expect(w.find('.agent-chat__title').text()).toBe('New conversation')
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('/mcp opens the settings page when it exists and is permitted', async () => {
    mockApi(BASE)
    await show()
    router.addRoute({
      path: '/agent/settings',
      name: 'agent-setting',
      component: { render: () => null },
    })
    await type('/mcp')
    await key('Enter')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('agent-setting')
  })

  it('$ completes skills by prefix and sends the chosen skill with the text', async () => {
    const calls = mockApi({
      ...BASE,
      'POST /agent/threads/7/messages': ok(turn({ status: 'running' })),
    })
    await show()
    await open()
    await type('please $')
    expect(suggestions()).toEqual(['$fill-customer', '$report'])
    await type('please $f')
    expect(suggestions()).toEqual(['$fill-customer'])
    expect(w.find('.agent-composer__suggest [role="option"]').text()).toContain(
      'Fill in customer details',
    )
    await key('Enter')
    expect(textarea().element.value).toBe('please $fill-customer ')
    expect(suggestions()).toEqual([])
    await type('please $fill-customer for Acme')
    await key('Enter')
    expect(body(sent(calls, 'post', '/agent/threads/7/messages')[0])).toEqual({
      clientMessageId: expect.any(String),
      text: 'please $fill-customer for Acme',
      skill: 'fill-customer',
      // the turn of thread 7 is still running: the message joins it
      mode: 'steer',
    })
  })

  it('/skills opens the skill completion; Escape closes it', async () => {
    mockApi(BASE)
    await show()
    await type('/skills')
    await key('Enter')
    expect(textarea().element.value).toBe('$')
    expect(suggestions()).toEqual(['$fill-customer', '$report'])
    await key('Escape')
    expect(suggestions()).toEqual([])
  })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** runs a command of the open thread's header menu */
async function threadMenu(cmd: string) {
  w.find('.agent-chat__head').findComponent(ElDropdown).vm.$emit('command', cmd)
  await flushPromises()
}

describe('thread views and conversation actions', () => {
  it('shows unread counts, marks a thread read when opened, filters by view and pins', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /agent/threads': ok({
        items: [thread(7, { unread: 3 }), thread(8, { title: 'Old one', lastActiveAt: OLD })],
        total: 2,
      }),
      'GET /agent/threads/7/items': ok({
        thread: thread(7, { unread: 3 }),
        items: ITEMS,
        turn: turn(),
      }),
      'POST /agent/threads/7/read': ok(null),
      'PATCH /agent/threads/8': ok(
        thread(8, { title: 'Old one', lastActiveAt: OLD, pinned: true }),
      ),
    })
    await show()
    expect(threadButton('Thread 7').find('.agent-threads__unread').text()).toBe('3')
    await open()
    await wait(350)
    await flushPromises()
    expect(body(sent(calls, 'post', '/agent/threads/7/read')[0])).toEqual({ seq: 2 })
    expect(threadButton('Thread 7').find('.agent-threads__unread').exists()).toBe(false)

    w.findAllComponents(ElDropdown)[1]!.vm.$emit('command', 'pin')
    await flushPromises()
    expect(body(sent(calls, 'patch', '/agent/threads/8')[0])).toEqual({ pinned: true })
    expect(w.findAll('.agent-threads__label').map((l) => l.text())).toEqual(['Pinned', 'Today'])

    await w
      .findAll('.agent-threads__views .el-radio-button')
      .find((b) => b.text() === 'Unread')!
      .find('input')
      .setValue(true)
    await flushPromises()
    expect(sent(calls, 'get', '/agent/threads').at(-1)!.params).toMatchObject({ view: 'unread' })
  })

  it('a temporary chat stays out of the list and is deleted when left (Alt+N; Ctrl+K is the menu search)', async () => {
    const calls = mockApi({
      ...BASE,
      'POST /agent/threads': ok(thread(9, { title: 'Secret', temporary: true })),
      'POST /agent/threads/9/messages': ok(turn({ id: 5, threadId: 9 })),
      'GET /agent/threads/9/items': ok({
        thread: thread(9, { temporary: true }),
        items: [],
        turn: turn({ id: 5, threadId: 9 }),
      }),
      'DELETE /agent/threads/9': ok(null),
    })
    await show()
    await w.find('.agent-chat__head .el-switch input').setValue(true)
    await type('Secret')
    await key('Enter')
    expect(body(sent(calls, 'post', '/agent/threads')[0])).toMatchObject({ temporary: true })
    expect(w.findAll('.agent-threads__open').map((b) => b.text())).toEqual(['Thread 7', 'Old one'])
    // the global menu search owns Ctrl/⌘+K: the chat ignores it
    for (const mod of [{ ctrlKey: true }, { metaKey: true }])
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ...mod }))
    await flushPromises()
    expect(sent(calls, 'delete', '/agent/threads/9')).toHaveLength(0)
    // a shortcut another handler already took is left alone
    const taken = new KeyboardEvent('keydown', { code: 'KeyN', altKey: true, cancelable: true })
    taken.preventDefault()
    window.dispatchEvent(taken)
    await flushPromises()
    expect(sent(calls, 'delete', '/agent/threads/9')).toHaveLength(0)
    // ⌥N on a mac types a character: matched by the physical key
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '˜', code: 'KeyN', altKey: true }))
    await flushPromises()
    expect(sent(calls, 'delete', '/agent/threads/9')).toHaveLength(1)
    expect(w.find('.agent-chat__title').text()).toBe('New conversation')
  })

  it('edits the last message: forks before it and sends the new text there', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /agent/threads/7/items': ok({ thread: thread(7), items: ITEMS, turn: turn() }),
      'POST /agent/threads/7/fork': ok(thread(11, { title: 'Edited' })),
      'GET /agent/threads/11/items': ok({
        thread: thread(11, { title: 'Edited' }),
        items: [],
        turn: null,
      }),
      'POST /agent/threads/11/messages': ok(turn({ id: 6, threadId: 11 })),
    })
    await show()
    await open()
    await w.find('button[aria-label="Edit and resend"]').trigger('click')
    await flushPromises()
    expect(textarea().element.value).toBe('Who is Acme?')
    expect(w.find('.agent-chat__context').text()).toContain('Editing the last message')
    await type('Who is Acme Ltd?')
    await key('Enter')
    expect(body(sent(calls, 'post', '/agent/threads/7/fork')[0])).toEqual({
      seq: 0,
      clientDraftId: expect.any(String),
    })
    expect(body(sent(calls, 'post', '/agent/threads/11/messages')[0])).toEqual({
      clientMessageId: expect.any(String),
      text: 'Who is Acme Ltd?',
    })
    expect(sent(calls, 'post', '/agent/threads/7/messages')).toHaveLength(0)
    expect(w.find('.agent-chat__title').text()).toBe('Edited')
  })

  it('reverts the last turn after a confirmation that says writes stay, exports Markdown, shares and stops sharing', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const alert = vi.spyOn(ElMessageBox, 'alert').mockResolvedValue('confirm' as never)
    const blob = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:md')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const calls = mockApi({
      ...BASE,
      'GET /agent/threads/7/items': ok({ thread: thread(7), items: ITEMS, turn: turn() }),
      'POST /agent/threads/7/revert': ok(null),
      'GET /agent/threads/7/export': ok({ name: 'acme.md', text: '# Acme' }),
      'POST /agent/threads/7/share': ok({ token: 'tok-1' }),
      'DELETE /agent/threads/7/share': ok(null),
    })
    await show()
    await open()
    await threadMenu('revert')
    expect(confirm.mock.calls[0]![0]).toContain('already made in that turn stay')
    expect(sent(calls, 'post', '/agent/threads/7/revert')).toHaveLength(1)
    expect(sent(calls, 'get', '/agent/threads/7/items')).toHaveLength(2)

    await threadMenu('export')
    expect(await (blob.mock.calls[0]![0] as Blob).text()).toBe('# Acme')
    expect(click).toHaveBeenCalledTimes(1)

    await threadMenu('share')
    expect(writeText.mock.calls[0]![0]).toMatch(/\?shared=tok-1$/)
    expect(alert.mock.calls[0]![0]).toMatch(/\?shared=tok-1$/)
    await threadMenu('unshare')
    expect(sent(calls, 'delete', '/agent/threads/7/share')).toHaveLength(1)
  })

  it('shows a shared conversation read-only, without the composer', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /agent/shared/tok-1': ok({
        thread: thread(30, { title: 'Shared research' }),
        items: [
          ITEMS[0],
          item(
            5,
            2,
            'approval',
            { callId: 'c', tool: 't', title: 'Update', args: {}, sources: [] },
            'pending',
          ),
        ],
        turn: null,
      }),
    })
    await show('/?shared=tok-1')
    expect(sent(calls, 'get', '/agent/shared/tok-1')).toHaveLength(1)
    expect(w.find('.agent-chat__title').text()).toBe('Shared research')
    expect(w.text()).toContain('Shared, read only')
    expect(w.find('.agent-msg--user').text()).toContain('Who is Acme?')
    expect(textarea().exists()).toBe(false)
    expect(button('Approve')).toBeUndefined()
  })
})

describe('composer extras', () => {
  it('attaches files, keeps images away from a model without vision, switches to the fast model', async () => {
    vi.spyOn(ElMessage, 'warning').mockReturnValue(undefined as never)
    const calls = mockApi({
      ...BASE,
      'GET /agent/threads/7/items': ok({ thread: thread(7), items: ITEMS, turn: turn() }),
      'PATCH /agent/threads/7': (c) =>
        ok(thread(7, JSON.parse(String(c.data)) as Partial<AgentThreadVo>)),
      'POST /agent/threads/7/messages': ok(turn()),
    })
    await show()
    await open()
    await w.find('button[aria-label="Attachments"]').trigger('click')
    w.findComponent(FileUpload).vm.$emit('update:modelValue', [
      {
        id: 41,
        originalName: 'card.png',
        mime: 'image/png',
        size: 10,
        url: null,
        isPublic: false,
        bizTag: 'attachment',
        createdAt: NOW,
      },
    ])
    await type('Read this card')
    await key('Enter')
    expect(ElMessage.warning).toHaveBeenCalledWith(expect.stringContaining('cannot read images'))
    expect(sent(calls, 'post', '/agent/threads/7/messages')).toHaveLength(0)

    await button('Fast')!.trigger('click')
    await flushPromises()
    expect(body(sent(calls, 'patch', '/agent/threads/7')[0])).toMatchObject({
      providerId: 1,
      model: 'm2',
    })
    expect(button('Fast')!.attributes('aria-pressed')).toBe('true')
    await key('Enter')
    expect(body(sent(calls, 'post', '/agent/threads/7/messages')[0])).toEqual({
      clientMessageId: expect.any(String),
      text: 'Read this card',
      fileIds: [41],
    })
    expect(w.findComponent(FileUpload).exists()).toBe(false)

    const plan = w.find('.agent-composer__plan')
    expect(plan.find('input').attributes('aria-checked')).toBe('false')
    await plan.trigger('click')
    await flushPromises()
    expect(body(sent(calls, 'patch', '/agent/threads/7').at(-1))).toMatchObject({ planMode: true })
    expect(plan.find('input').attributes('aria-checked')).toBe('true')
  })

  it('inserts a prompt template with /prompts and recalls sent messages with Up and Down', async () => {
    sessionStorage.clear()
    mockApi({
      ...BASE,
      'GET /agent/threads/7/items': ok({ thread: thread(7), items: ITEMS, turn: turn() }),
      'POST /agent/threads/7/messages': ok(turn()),
    })
    await show()
    await open()
    await type('/prompts')
    await key('Enter')
    expect(suggestions()).toEqual(['Weekly'])
    await key('Enter')
    expect(textarea().element.value).toBe('Write the weekly report for {team}')

    await type('First')
    await key('Enter')
    await type('Second')
    await key('Enter')
    await key('ArrowUp')
    expect(textarea().element.value).toBe('Second')
    await key('ArrowUp')
    expect(textarea().element.value).toBe('First')
    await key('ArrowDown')
    await key('ArrowDown')
    expect(textarea().element.value).toBe('')
  })

  it('shows the context use, stops a running turn with Esc on an empty composer, leaves Ctrl+F to the browser', async () => {
    const calls = mockApi({ ...BASE, 'POST /agent/threads/7/cancel': ok(null) })
    await show()
    await open()
    const meter = w.find('meter')
    expect(meter.attributes()).toMatchObject({ max: '64000', value: '12000' })
    expect(w.find('.agent-composer__context').text()).toContain('Context estimate 19%')
    await key('Escape')
    expect(sent(calls, 'post', '/agent/threads/7/cancel')).toHaveLength(1)
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      const find = new KeyboardEvent('keydown', { key: 'f', cancelable: true, ...mod })
      window.dispatchEvent(find)
      expect(find.defaultPrevented).toBe(false)
    }
  })
})

describe('live list, trust, plans and mentions', () => {
  it('counts unread live for other threads, refetches the list for an unknown thread, a turn change and a reconnect, marks all read', async () => {
    const calls = mockApi({ ...BASE, 'POST /agent/threads/read-all': ok(null) })
    await show()
    await open()
    const listLoads = () => sent(calls, 'get', '/agent/threads').length
    const badge = () => threadButton('Old one').find('.agent-threads__unread')
    const answer = item(30, 9, 'assistant', { text: 'x' }, 'running')
    push({ threadId: 8, type: 'item', item: answer })
    push({ threadId: 8, type: 'item', item: { ...answer, status: 'done' } })
    push({ threadId: 8, type: 'item', item: item(31, 10, 'user', { text: 'mine' }) })
    await flushPromises()
    // one new item from the agent; its rewrite and the owner's own message do not count
    expect(badge().text()).toBe('1')
    expect(listLoads()).toBe(1)

    push({ threadId: 12, type: 'item', item: item(40, 1, 'assistant', { text: 'y' }, 'running') })
    await wait(1100)
    await flushPromises()
    expect(listLoads()).toBe(2)
    push({ threadId: 8, type: 'turn', turn: turn({ id: 3, threadId: 8, status: 'completed' }) })
    await wait(1100)
    await flushPromises()
    expect(listLoads()).toBe(3)
    socket.realtimeStatus.value = 'reconnecting'
    await flushPromises()
    socket.realtimeStatus.value = 'up'
    await wait(1100)
    await flushPromises()
    expect(listLoads()).toBe(4)

    push({ threadId: 8, type: 'item', item: item(32, 11, 'error', { code: 'x', message: 'm' }) })
    await flushPromises()
    expect(badge().exists()).toBe(true)
    await button('Mark all read')!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/agent/threads/read-all')).toHaveLength(1)
    expect(w.find('.agent-threads__unread').exists()).toBe(false)
  })

  it('marks the log busy while a turn runs and hides "approve for this conversation" when the platform turns it off', async () => {
    const approval = item(
      5,
      3,
      'approval',
      { callId: 'c', tool: 't', title: 'Update', args: {}, sources: [] },
      'pending',
    )
    mockApi({
      ...BASE,
      'GET /agent/options': ok({ ...OPTIONS, trustSession: false }),
      'GET /agent/threads/7/items': ok({
        thread: thread(7),
        items: [...ITEMS, approval],
        turn: turn({ status: 'waiting' }),
      }),
    })
    await show()
    await open()
    expect(w.find('[role="log"]').attributes('aria-busy')).toBe('true')
    expect(button('Approve')).toBeDefined()
    expect(button('Approve for this conversation')).toBeUndefined()
    push({ threadId: 7, type: 'turn', turn: turn({ status: 'completed' }) })
    await flushPromises()
    expect(w.find('[role="log"]').attributes('aria-busy')).toBe('false')
  })

  it('a follow-up suggestion sends only on an empty draft, otherwise joins the draft', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /agent/threads/7/items': ok({
        thread: thread(7),
        items: [
          ITEMS[0],
          item(2, 2, 'assistant', { text: 'Done.', suggestions: ['Also the phone'] }, 'done'),
        ],
        turn: turn(),
      }),
      'POST /agent/threads/7/messages': ok(turn()),
    })
    await show()
    await open()
    await type('My own words')
    await button('Also the phone')!.trigger('click')
    await flushPromises()
    expect(textarea().element.value).toBe('My own words\nAlso the phone')
    expect(sent(calls, 'post', '/agent/threads/7/messages')).toHaveLength(0)
    await type('')
    await button('Also the phone')!.trigger('click')
    await flushPromises()
    expect(body(sent(calls, 'post', '/agent/threads/7/messages')[0])).toEqual({
      clientMessageId: expect.any(String),
      text: 'Also the phone',
    })
  })

  it('runs a finished plan: plan mode off first, then the localized go-ahead', async () => {
    const order: string[] = []
    const calls = mockApi({
      ...BASE,
      'GET /agent/threads/7/items': () =>
        ok({
          thread: thread(7, { planMode: !order.includes('patch') }),
          items: [ITEMS[0], item(2, 2, 'assistant', { text: '1. Search\n2. Update' }, 'done')],
          turn: turn(),
        }),
      'PATCH /agent/threads/7': () => (order.push('patch'), ok(thread(7, { planMode: false }))),
      'POST /agent/threads/7/messages': () => (order.push('send'), ok(turn())),
    })
    await show()
    await open()
    await button('Run this plan')!.trigger('click')
    await flushPromises()
    expect(order).toEqual(['patch', 'send'])
    expect(body(sent(calls, 'patch', '/agent/threads/7')[0])).toEqual({ planMode: false })
    expect(body(sent(calls, 'post', '/agent/threads/7/messages')[0])).toEqual({
      clientMessageId: expect.any(String),
      text: 'Go ahead with the plan',
    })
    expect(w.find('.agent-composer__plan input').attributes('aria-checked')).toBe('false')
    expect(button('Run this plan')).toBeUndefined()
  })

  it('saves the conversation as a skill draft and opens it on the skill page', async () => {
    const calls = mockApi({
      ...BASE,
      'POST /agent/skills/from-thread/7': ok({ id: 15, name: 'acme-research' }),
    })
    await show()
    await open()
    await threadMenu('skill')
    expect(sent(calls, 'post', '/agent/skills/from-thread/7')).toHaveLength(1)
    expect(router.currentRoute.value).toMatchObject({
      name: 'agent-skill',
      query: { edit: '15' },
    })
  })

  it('asks for the starters of the page the entry button was pressed on', async () => {
    pendingContext.value = { route: '/demo/customers', title: 'Customers' }
    pendingRoute.value = 'demo-customer'
    const calls = mockApi(BASE)
    await show()
    expect(sent(calls, 'get', '/agent/options').map((c) => c.params)).toEqual([
      { route: 'demo-customer' },
    ])
    expect(pendingRoute.value).toBeNull()
  })

  it('@ mentions skills, external servers and the records the page brought; a skill mention sets the skill', async () => {
    pendingContext.value = {
      route: '/demo/customers',
      title: 'Customers',
      target: 'demo.customer',
      ids: [3, 4],
    }
    const calls = mockApi({
      ...BASE,
      'GET /agent/options': ok({ ...OPTIONS, servers: [{ name: 'crm-tools' }] }),
      'POST /agent/threads': ok(thread(9)),
      'POST /agent/threads/9/messages': ok(turn({ id: 5, threadId: 9 })),
      'GET /agent/threads/9/items': ok({ thread: thread(9), items: [], turn: turn() }),
    })
    await show()
    await type('Check @')
    expect(suggestions()).toEqual([
      '@skill:fill-customer',
      '@skill:report',
      '@server:crm-tools',
      '@record:demo.customer#3',
      '@record:demo.customer#4',
    ])
    await type('Check @rec')
    expect(suggestions()).toEqual(['@record:demo.customer#3', '@record:demo.customer#4'])
    await key('ArrowDown')
    await key('Enter')
    expect(textarea().element.value).toBe('Check @record:demo.customer#4 ')
    await type('Check @record:demo.customer#4 with @fill')
    await key('Enter')
    await type(`${textarea().element.value}now`)
    await key('Enter')
    expect(body(sent(calls, 'post', '/agent/threads/9/messages')[0])).toEqual({
      clientMessageId: expect.any(String),
      text: 'Check @record:demo.customer#4 with @skill:fill-customer now',
      skill: 'fill-customer',
    })
  })

  it('Ctrl+R searches the sent messages, newest first; Esc puts the draft back', async () => {
    sessionStorage.clear()
    for (const text of ['Weekly report', 'Find Acme', 'Weekly sales']) pushHistory(1, text)
    mockApi(BASE)
    await show()
    await type('half a thought')
    await key('r', { ctrlKey: true })
    expect(textarea().element.value).toBe('')
    expect(suggestions()).toEqual(['Weekly sales', 'Find Acme', 'Weekly report'])
    await type('week')
    expect(suggestions()).toEqual(['Weekly sales', 'Weekly report'])
    await key('Escape')
    expect(textarea().element.value).toBe('half a thought')
    expect(suggestions()).toEqual([])
    await key('r', { ctrlKey: true })
    await type('acme')
    await key('Enter')
    expect(textarea().element.value).toBe('Find Acme')
  })
})

describe('entry button', () => {
  it('opens beside the business page with its selection, keeps its URL and clears after access is revoked', async () => {
    mockApi(BASE)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'agent-chat', component: { render: () => null } },
        {
          path: '/demo/customers',
          name: 'demo-customer',
          component: { render: () => null },
          meta: { title: 'Customers' },
        },
      ],
    })
    await router.push('/demo/customers?page=2')
    const selection = ref([3, 4])
    const Page = defineComponent({
      setup() {
        useAgentContext('demo.customer', () => selection.value)
        return () => h(AgentEntry)
      },
    })
    const entry = mount(Page, { global: { plugins: [ElementPlus, i18n, router] } })
    expect(entry.find('button').exists()).toBe(false)
    useMenuStore().tree = [
      node({
        id: 1,
        routePath: '/',
        routeName: 'agent-chat',
        component: 'platform/agent/chat/index',
        visible: false,
      }),
    ]
    await flushPromises()
    await entry.find('button[aria-label="Assistant"]').trigger('click')
    await flushPromises()
    const chat = entry.findComponent(ChatPage)
    expect(chat.props('entryContext')).toEqual({
      route: '/demo/customers?page=2',
      title: 'Customers',
      target: 'demo.customer',
      ids: [3, 4],
    })
    expect(chat.props('entryRoute')).toBe('demo-customer')
    expect(router.currentRoute.value.fullPath).toBe('/demo/customers?page=2')
    expect(chat.props('embedded')).toBe(true)
    expect(chat.props('active')).toBe(true)
    expect(pendingContext.value).toBeNull()
    useAuthStore().me = me([])
    await flushPromises()
    expect(entry.findComponent(ChatPage).exists()).toBe(false)
    expect(entry.find('.agent-entry').exists()).toBe(false)
    entry.unmount()
  })

  it.each(['workflow/admin/model-design', 'workflow/admin/model', 'workflow/center/detail'])(
    'hides on %s, whose BPMN diagram carries the bpmn.io watermark',
    async (component) => {
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [
          { path: '/', name: 'agent-chat', component: { render: () => null } },
          { path: '/bpmn', name: 'bpmn', component: { render: () => null }, meta: { component } },
          {
            path: '/plain',
            name: 'plain',
            component: { render: () => null },
            meta: { component: 'workflow/admin/form' },
          },
        ],
      })
      useMenuStore().tree = [
        node({
          id: 1,
          routePath: '/',
          routeName: 'agent-chat',
          component: 'platform/agent/chat/index',
          visible: false,
        }),
      ]
      await router.push('/plain')
      const entry = mount(AgentEntry, { global: { plugins: [ElementPlus, i18n, router] } })
      await flushPromises()
      expect(entry.find('button').exists()).toBe(true)
      await router.push('/bpmn')
      await flushPromises()
      expect(entry.find('button').exists()).toBe(false)
      entry.unmount()
    },
  )
})

describe('work panel scope', () => {
  it('starts collapsed, expands a current answer, and clears preview and sources before another thread responds', async () => {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = item(2, 2, 'assistant', {
      text: '# First answer',
      citations: [{ title: 'Old source', url: 'https://old.test/' }],
    })
    const second = item(20, 1, 'assistant', {
      text: '# Second answer',
      citations: [{ title: 'New source', url: 'https://new.test/' }],
    })
    const calls = mockApi({
      ...BASE,
      'GET /agent/threads/7/items': ok({ thread: thread(7), items: [first], turn: turn() }),
      'GET /agent/threads/8/items': async () => {
        await waiting
        return ok({ thread: thread(8), items: [second], turn: turn() })
      },
      'GET /agent/threads/8/status': ok({
        threadId: 8,
        model: 'm1',
        contextUsed: 0,
        contextWindow: 64000,
        turn: null,
        today: {
          userTokens: null,
          tenantTokens: null,
          userCredits: '0',
          tenantCredits: '0',
          userLimit: '0',
          tenantLimit: '0',
          userUnpricedCalls: 0,
          tenantUnpricedCalls: 0,
        },
      }),
    })
    await show()
    await open()
    expect(w.findComponent({ name: 'AgentContextPanel' }).exists()).toBe(false)
    const answer = w.findComponent({ name: 'AgentChatItem' })
    answer.vm.$emit('inspect', 2)
    await flushPromises()
    expect(w.find('.agent-context__preview').text()).toContain('First answer')
    await w
      .findAll('.agent-context [role="tab"]')
      .find((node) => node.text() === 'Sources')!
      .trigger('click')
    await flushPromises()
    expect(w.find('.agent-context__sources').text()).toContain('Old source')
    answer.vm.$emit('inspect', 2)
    await flushPromises()
    expect(w.find('.agent-context [role="tab"][aria-selected="true"]').text()).toBe('Outputs')
    await open('Old one')
    expect(w.find('.agent-context__preview').exists()).toBe(false)
    expect(w.findAll('.agent-context__sources a')).toHaveLength(0)
    expect(w.find('.agent-context').text()).not.toContain('Old source')
    release()
    await flushPromises()
    await w
      .findAll('.agent-context [role="tab"]')
      .find((node) => node.text() === 'Sources')!
      .trigger('click')
    await flushPromises()
    expect(w.find('.agent-context__sources').text()).toContain('New source')
    expect(w.find('.agent-context').text()).not.toContain('Old source')
    expect(
      calls.some((call) => call.url === '/agent/usage' || call.url === '/agent/usage/entries'),
    ).toBe(false)
    await button('New conversation')!.trigger('click')
    await flushPromises()
    expect(w.findAll('.agent-context__sources a')).toHaveLength(0)
  })
})

describe('embedded chat and subtasks', () => {
  it('preserves chosen model and approval mode when draft options arrive late', async () => {
    const selected = { model: 'm2', approvalMode: 'read_only' as const, planMode: true }
    const created = thread(9, selected)
    const calls = mockApi({
      ...BASE,
      'POST /agent/threads': ok(created),
      'POST /agent/threads/9/messages': ok(turn({ threadId: 9 })),
      'GET /agent/threads/9/items': ok({ thread: created, items: [], turn: turn({ threadId: 9 }) }),
    })
    await show('/other')
    await w.setProps({ embedded: true, entryRoute: 'other' })
    let release!: (options: AgentOptionsVo) => void
    const waiting = new Promise<AgentOptionsVo>((resolve) => (release = resolve))
    vi.spyOn(agentApi, 'options').mockImplementationOnce(() => waiting)
    await w.find('.agent-chat__head button[aria-label="New conversation"]').trigger('click')
    const composer = w.findComponent({ name: 'AgentComposer' })
    composer.vm.$emit('update:settings', { ...composer.props('settings'), ...selected })
    await flushPromises()
    release(OPTIONS)
    await flushPromises()
    expect(composer.props('settings')).toMatchObject(selected)
    await type('Use my chosen model')
    await key('Enter')
    expect(body(sent(calls, 'post', '/agent/threads')[0])).toMatchObject(selected)
  })

  it('keeps only options for the latest draft and source', async () => {
    mockApi(BASE)
    await show('/other')
    await w.setProps({
      embedded: true,
      entryRoute: 'first-page',
      entryContext: { route: '/first', title: 'First page' },
    })
    let first!: (options: AgentOptionsVo) => void, second!: (options: AgentOptionsVo) => void
    const firstOptions = new Promise<AgentOptionsVo>((resolve) => (first = resolve))
    const secondOptions = new Promise<AgentOptionsVo>((resolve) => (second = resolve))
    const load = vi
      .spyOn(agentApi, 'options')
      .mockImplementationOnce(() => firstOptions)
      .mockImplementationOnce(() => secondOptions)
    const create = () =>
      w.find('.agent-chat__head button[aria-label="New conversation"]').trigger('click')
    await create()
    await w.setProps({
      entryRoute: 'second-page',
      entryContext: { route: '/second', title: 'Second page' },
    })
    await create()
    const current: AgentOptionsVo = {
      ...OPTIONS,
      defaults: { providerId: 1, model: 'm2' },
      approvalModes: ['read_only'],
      starters: ['Current page starter'],
    }
    second(current)
    await flushPromises()
    const composer = w.findComponent({ name: 'AgentComposer' })
    expect(composer.props('settings')).toMatchObject({ model: 'm2', approvalMode: 'read_only' })
    first({ ...OPTIONS, starters: ['Previous page starter'] })
    await flushPromises()
    expect(composer.props('options')).toEqual(current)
    expect(composer.props('settings')).toMatchObject({ model: 'm2', approvalMode: 'read_only' })
    expect(w.find('.agent-chat__context').text()).toContain('Second page')
    expect(w.text()).toContain('Current page starter')
    expect(w.text()).not.toContain('Previous page starter')
    expect(load.mock.calls).toEqual([['first-page'], ['second-page']])
  })

  it('applies the first options defaults to an untouched embedded draft', async () => {
    mockApi(BASE)
    await show('/other')
    w.unmount()
    let release!: (options: AgentOptionsVo) => void
    const waiting = new Promise<AgentOptionsVo>((resolve) => (release = resolve))
    const load = vi.spyOn(agentApi, 'options').mockImplementationOnce(() => waiting)
    w = mount(ChatPage, {
      props: { embedded: true, entryRoute: 'first-page' },
      global: { plugins: [ElementPlus, i18n, router] },
    })
    const composer = w.findComponent({ name: 'AgentComposer' })
    expect(composer.props('settings').model).toBeNull()
    release({ ...OPTIONS, defaults: { providerId: 1, model: 'm2' }, approvalModes: ['read_only'] })
    await flushPromises()
    expect(composer.props('settings')).toMatchObject({ model: 'm2', approvalMode: 'read_only' })
    expect(load.mock.calls).toEqual([['first-page']])
  })

  it('retains the submitted model while thread creation and options refresh overlap', async () => {
    const created = thread(9)
    mockApi({
      ...BASE,
      'POST /agent/threads/9/messages': ok(turn({ threadId: 9 })),
      'GET /agent/threads/9/items': ok({ thread: created, items: [], turn: turn({ threadId: 9 }) }),
    })
    await show('/other')
    await w.setProps({ embedded: true, entryRoute: 'other' })
    let options!: (options: AgentOptionsVo) => void, complete!: (value: AgentThreadVo) => void
    const refreshing = new Promise<AgentOptionsVo>((resolve) => (options = resolve))
    const creating = new Promise<AgentThreadVo>((resolve) => (complete = resolve))
    vi.spyOn(agentApi, 'options').mockImplementationOnce(() => refreshing)
    const create = vi.spyOn(agentApi, 'createThread').mockImplementationOnce(() => creating)
    await w.find('.agent-chat__head button[aria-label="New conversation"]').trigger('click')
    await type('Send with the displayed model')
    await key('Enter')
    expect(create.mock.calls[0]?.[0]).toMatchObject({ providerId: 1, model: 'm1' })
    options({ ...OPTIONS, defaults: { providerId: 1, model: 'm2' } })
    await flushPromises()
    expect(w.findComponent({ name: 'AgentComposer' }).props('settings').model).toBe('m1')
    complete(created)
    await flushPromises()
    expect(w.findComponent({ name: 'AgentComposer' }).props('settings').model).toBe('m1')
  })

  it('keeps the business query and draft while hidden, then catches up without cancelling the turn', async () => {
    const calls = mockApi(BASE)
    await show('/other?filter=mine')
    await w.setProps({
      embedded: true,
      active: true,
      entryContext: { route: '/other?filter=mine' },
    })
    await type('Keep this private draft')
    await open()
    expect(router.currentRoute.value.fullPath).toBe('/other?filter=mine')
    await type('My next question')
    await w.setProps({ active: false })
    const before = sent(calls, 'get', '/agent/threads/7/items').length
    push({
      type: 'item',
      threadId: 7,
      item: item(88, 88, 'assistant', { text: 'Hidden event' }, 'done'),
    })
    await flushPromises()
    expect(w.text()).not.toContain('Hidden event')
    expect(sent(calls, 'get', '/agent/threads/7/items')).toHaveLength(before)
    expect(sent(calls, 'post', '/agent/threads/7/cancel')).toHaveLength(0)
    await w.setProps({ active: true })
    await flushPromises()
    expect(textarea().element.value).toBe('My next question')
    expect(sent(calls, 'get', '/agent/threads/7/items').length).toBeGreaterThan(before)
    expect(router.currentRoute.value.fullPath).toBe('/other?filter=mine')
  })

  it('opens an authorized child read-only without changing the parent or offering another approval', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /agent/threads/7/items': ok({
        thread: thread(7),
        turn: turn(),
        items: [
          ...ITEMS,
          item(10, 10, 'subagent', {
            callId: 'children',
            tasks: [{ title: 'Check stock', threadId: 41, status: 'running' }],
          }),
        ],
      }),
      'GET /agent/threads/41/items': ok({
        thread: thread(41, { parentThreadId: 7 }),
        turn: turn({ threadId: 41 }),
        items: [
          item(21, 1, 'assistant', { text: 'Stock is available.' }, 'done'),
          item(
            22,
            2,
            'approval',
            {
              callId: 'write',
              tool: 'custom.write',
              title: 'Child write',
              sources: [],
              args: {},
              perCallConfirmation: true,
            },
            'pending',
          ),
        ],
      }),
    })
    await show()
    await open()
    const parentUrl = router.currentRoute.value.fullPath
    await w.find('.agent-subtasks__task').trigger('click')
    await flushPromises()
    const child = w.find('.agent-child')
    expect(child.text()).toContain('Stock is available.')
    expect(child.find('textarea').exists()).toBe(false)
    expect(
      child.find(`button[aria-label="${i18n.global.t('agent.chat.markdown.expand')}"]`).exists(),
    ).toBe(false)
    expect(
      child.find(`button[aria-label="${i18n.global.t('agent.chat.markdown.source')}"]`).exists(),
    ).toBe(true)
    expect(
      child.find(`button[aria-label="${i18n.global.t('agent.chat.markdown.download')}"]`).exists(),
    ).toBe(true)
    expect(child.findAll('button').some((b) => b.text() === 'Approve once')).toBe(false)
    expect(w.find('.agent-chat__title').text()).toBe('Thread 7')
    expect(router.currentRoute.value.fullPath).toBe(parentUrl)
    await w.find('.agent-child button[aria-label="Back to main task"]').trigger('click')
    expect(w.find('.agent-child').exists()).toBe(false)
    expect(textarea().exists()).toBe(true)
    expect(sent(calls, 'post', '/agent/approvals/22')).toHaveLength(0)
  })

  it('refuses details belonging to a different parent and hides input in a standalone child', async () => {
    mockApi({
      ...BASE,
      'GET /agent/threads/7/items': ok({
        thread: thread(7),
        turn: turn(),
        items: [
          item(10, 10, 'subagent', {
            callId: 'children',
            tasks: [{ title: 'Check stock', threadId: 41, status: 'running' }],
          }),
        ],
      }),
      'GET /agent/threads/41/items': ok({
        thread: thread(41, { parentThreadId: 8 }),
        turn: turn({ threadId: 41 }),
        items: [item(21, 1, 'assistant', { text: 'Must not enter this parent.' }, 'done')],
      }),
    })
    await show()
    await open()
    await w.find('.agent-subtasks__task').trigger('click')
    await flushPromises()
    expect(w.find('.agent-child').text()).toContain('This subtask could not be loaded.')
    expect(w.text()).not.toContain('Must not enter this parent.')
    w.unmount()
    await show('/?thread=41')
    expect(textarea().exists()).toBe(false)
    expect(button('Back to main task')).toBeDefined()
  })
})

describe('durable delivery and recovery', () => {
  it('reconciles a lost creation acknowledgement before explicitly sending into the same draft', async () => {
    const created = thread(9)
    const calls = mockApi({
      ...BASE,
      'POST /agent/threads/9/messages': ok(turn({ threadId: 9 })),
      'GET /agent/threads/9/items': ok({ thread: created, items: [], turn: turn({ threadId: 9 }) }),
    })
    await show()
    const create = vi
      .spyOn(agentApi, 'createThread')
      .mockRejectedValue(new ApiError(503, 'A0500', 'Acknowledgement unavailable'))
    vi.spyOn(agentApi, 'draftReceipt').mockImplementation(async (clientDraftId) => ({
      clientDraftId,
      threadId: 9,
      status: 'accepted',
      thread: created,
    }))
    vi.spyOn(agentApi, 'messageReceipt').mockRejectedValue(
      new ApiError(404, 'A0440', 'No message accepted'),
    )
    await type('Private creation intent')
    await key('Enter')
    const saved = JSON.parse(sessionStorage.getItem('qw.agent.delivery.1:1')!) as {
      clientDraftId: string
      clientMessageId: string
    }
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0]).toMatchObject({ clientDraftId: saved.clientDraftId })
    expect(sent(calls, 'post', '/agent/threads/9/messages')).toHaveLength(0)
    expect(textarea().element.value).toBe('Private creation intent')
    await key('Enter')
    expect(create).toHaveBeenCalledTimes(1)
    expect(body(sent(calls, 'post', '/agent/threads/9/messages')[0])).toMatchObject({
      clientMessageId: saved.clientMessageId,
    })
    expect(textarea().element.value).toBe('')
    expect(w.find('.agent-chat__title').text()).toBe('Thread 9')
  })
  it('labels saved interrupted generation and expired queued intent without presenting them as completed output', async () => {
    mockApi({
      ...BASE,
      'GET /agent/threads/7/items': ok({
        thread: thread(7),
        turn: turn({ status: 'failed' }),
        items: [
          item(20, 1, 'assistant', { text: 'Saved answer prefix' }, 'failed'),
          item(21, 2, 'reasoning', { text: 'Saved thought prefix' }, 'failed'),
          { ...item(22, 3, 'user', { text: 'Old queue', mode: 'queue' }, 'expired'), turnId: null },
        ],
      }),
    })
    await show()
    await open()
    expect(w.findAll('.agent-msg__interrupted')).toHaveLength(2)
    expect(w.text()).toContain('Saved answer prefix')
    expect(w.text()).toContain('Saved thought prefix')
    expect(w.find('.agent-msg__queued-expired').exists()).toBe(true)
  })
  async function uncertainSend() {
    const routes: Record<string, Route> = {
      ...BASE,
      'POST /agent/threads/7/messages': fail(503, 'A0500'),
      'PATCH /agent/threads/7': (call: Call) => ok(thread(7, JSON.parse(String(call.data)))),
    }
    const calls = mockApi(routes)
    const lookup = vi
      .spyOn(agentApi, 'messageReceipt')
      .mockRejectedValue(new ApiError(503, 'A0500', 'Unavailable'))
    await show()
    await open()
    await type('Private uncertain message')
    await key('Enter')
    const message = body(sent(calls, 'post', '/agent/threads/7/messages')[0]) as {
      clientMessageId: string
    }
    expect(message.clientMessageId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(w.find('.agent-chat__delivery').exists()).toBe(true)
    return { routes, calls, lookup, id: message.clientMessageId }
  }

  it('checks a lost acknowledgement after reconnect without sending the accepted message again', async () => {
    const { calls, lookup, id } = await uncertainSend()
    expect(sessionStorage.getItem('qw.agent.delivery.1:1')).not.toContain(
      'Private uncertain message',
    )
    lookup.mockResolvedValue(received(id))
    socket.realtimeStatus.value = 'reconnecting'
    await flushPromises()
    socket.realtimeStatus.value = 'up'
    await flushPromises()
    expect(sent(calls, 'post', '/agent/threads/7/messages')).toHaveLength(1)
    expect(textarea().element.value).toBe('')
    expect(w.find('.agent-chat__delivery').exists()).toBe(false)
    expect(sessionStorage.getItem('qw.agent.delivery.1:1')).toBeNull()
  })

  it('reuses the same message identity only for an explicit unchanged retry', async () => {
    const { calls, routes, lookup, id } = await uncertainSend()
    lookup.mockRejectedValue(new ApiError(404, 'A0440', 'Not found'))
    routes['POST /agent/threads/7/messages'] = ok(turn())
    await key('Enter')
    expect(sent(calls, 'post', '/agent/threads/7/messages')).toHaveLength(2)
    expect(body(sent(calls, 'post', '/agent/threads/7/messages')[1])).toMatchObject({
      clientMessageId: id,
    })
    await type('A separate next message')
    await key('Enter')
    const next = body(sent(calls, 'post', '/agent/threads/7/messages')[2]) as {
      clientMessageId: string
    }
    expect(next.clientMessageId).not.toBe(id)
  })

  it('a late receipt preserves later text, model and queue selection without creating another intent', async () => {
    const { calls, lookup, id } = await uncertainSend()
    let release!: (value: ReturnType<typeof received>) => void
    const response = new Promise<ReturnType<typeof received>>((resolve) => (release = resolve))
    lookup.mockImplementationOnce(() => response)
    socket.realtimeStatus.value = 'reconnecting'
    await flushPromises()
    socket.realtimeStatus.value = 'up'
    await flushPromises()
    await type('A later private draft')
    const composer = w.findComponent({ name: 'AgentComposer' })
    composer.vm.$emit('update:settings', { ...composer.props('settings'), model: 'm2' })
    await flushPromises()
    await w.find('input[value="queue"]').setValue(true)
    release(received(id))
    await flushPromises()
    expect(textarea().element.value).toBe('A later private draft')
    expect(composer.props('settings').model).toBe('m2')
    expect((w.find('input[value="queue"]').element as HTMLInputElement).checked).toBe(true)
    expect(sent(calls, 'post', '/agent/threads/7/messages')).toHaveLength(1)
  })

  it('restores only identifiers after remount and queries receipt without replaying text', async () => {
    const { calls, lookup, id } = await uncertainSend()
    w.unmount()
    lookup.mockResolvedValue(received(id))
    await show('/?thread=7')
    expect(sent(calls, 'post', '/agent/threads/7/messages')).toHaveLength(1)
    expect(textarea().element.value).toBe('')
    expect(sessionStorage.getItem('qw.agent.delivery.1:1')).toBeNull()
  })

  it('does not clear an identical-looking draft after the user opens a different conversation', async () => {
    const { calls, routes, lookup, id } = await uncertainSend()
    routes['GET /agent/threads/8/items'] = ok({ thread: thread(8), items: [], turn: null })
    let release!: (value: ReturnType<typeof received>) => void
    const response = new Promise<ReturnType<typeof received>>((resolve) => (release = resolve))
    lookup.mockImplementationOnce(() => response)
    socket.realtimeStatus.value = 'reconnecting'
    await flushPromises()
    socket.realtimeStatus.value = 'up'
    await flushPromises()
    await open('Old one')
    release(received(id))
    await flushPromises()
    expect(w.find('.agent-chat__title').text()).toBe('Thread 8')
    expect(textarea().element.value).toBe('Private uncertain message')
    expect(sent(calls, 'post', '/agent/threads/7/messages')).toHaveLength(1)
  })

  it('ends a removed receipt without reviving or resending its message', async () => {
    const { calls, lookup, id } = await uncertainSend()
    lookup.mockResolvedValue({ ...received(id), status: 'removed', turn: null })
    await w.find('.agent-chat__delivery button').trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/agent/threads/7/messages')).toHaveLength(1)
    expect(textarea().element.value).toBe('')
    expect(w.find('.agent-chat__delivery').exists()).toBe(false)
  })

  it('does not overwrite live committed text with a slow snapshot and repairs a later offset gap', async () => {
    const initial = {
      thread: thread(7),
      items: [{ ...ITEMS[1], revision: 1 }],
      turn: turn({ status: 'running' }),
    }
    let release!: (value: ReturnType<typeof ok>) => void
    const waiting = new Promise<ReturnType<typeof ok>>((resolve) => (release = resolve))
    const routes: Record<string, Route> = {
      ...BASE,
      'GET /agent/threads/7/items': (call) =>
        (call.params as { afterSeq?: number })?.afterSeq === undefined ? ok(initial) : waiting,
    }
    mockApi(routes)
    await show()
    await open()
    socket.realtimeStatus.value = 'reconnecting'
    await flushPromises()
    socket.realtimeStatus.value = 'up'
    await flushPromises()
    push({ threadId: 7, type: 'delta', itemId: 2, revision: 2, offset: 7, delta: ' updated' })
    release(ok(initial))
    await flushPromises()
    expect(w.find('.agent-msg--assistant').text()).toBe('Acme is updated')
    routes['GET /agent/threads/7/items'] = ok({
      ...initial,
      items: [{ ...ITEMS[1], revision: 4, payload: { text: 'Acme is updated and complete' } }],
    })
    push({ threadId: 7, type: 'delta', itemId: 2, revision: 4, offset: 24, delta: 'ete' })
    await flushPromises()
    expect(w.find('.agent-msg--assistant').text()).toBe('Acme is updated and complete')
  })

  it('an old actor creation response cannot send a message or alter the new actor draft', async () => {
    mockApi(BASE)
    await show()
    let release!: (value: AgentThreadVo) => void
    const response = new Promise<AgentThreadVo>((resolve) => (release = resolve))
    vi.spyOn(agentApi, 'createThread').mockImplementationOnce(() => response)
    const send = vi.spyOn(agentApi, 'send')
    await type('Previous actor text')
    await key('Enter')
    useAuthStore().me = { ...me(['*']), user: { ...me(['*']).user, id: 2 } }
    await flushPromises()
    await type('New actor draft')
    release(thread(9))
    await flushPromises()
    expect(send).not.toHaveBeenCalled()
    expect(textarea().element.value).toBe('New actor draft')
    expect(w.find('.agent-chat__title').text()).toBe('New conversation')
    expect(sessionStorage.getItem('qw.agent.delivery.1:1')).toBeNull()
  })

  it('an older recovery acknowledgement cannot clear a newer risk revision', async () => {
    const routes = {
      ...BASE,
      'GET /agent/threads/7/items': ok({
        thread: thread(7, { recoveryRequired: true, recoveryRevision: 2 }),
        items: ITEMS,
        turn: turn(),
      }),
    }
    mockApi(routes)
    await show()
    await open()
    let release!: (value: AgentThreadVo) => void
    const response = new Promise<AgentThreadVo>((resolve) => (release = resolve))
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const acknowledge = vi
      .spyOn(agentApi, 'acknowledgeRecovery')
      .mockImplementationOnce(() => response)
    await w.find('.agent-chat__recovery button').trigger('click')
    await flushPromises()
    expect(acknowledge).toHaveBeenCalledWith(7, 2)
    routes['GET /agent/threads/7/items'] = ok({
      thread: thread(7, { recoveryRequired: true, recoveryRevision: 3 }),
      items: ITEMS,
      turn: turn({ status: 'failed' }),
    })
    socket.realtimeStatus.value = 'reconnecting'
    await flushPromises()
    socket.realtimeStatus.value = 'up'
    await flushPromises()
    release(thread(7, { recoveryRequired: false, recoveryRevision: 2 }))
    await flushPromises()
    expect(w.find('.agent-chat__recovery').exists()).toBe(true)
    expect(w.findComponent({ name: 'AgentComposer' }).props('disabled')).toBe(false)
  })
})

it('drops late child responses even when the transport ignores cancellation', async () => {
  mockApi(BASE)
  await show()
  w.unmount()
  const data = (id: number, text: string) => ({
    thread: thread(id, { parentThreadId: 7 }),
    turn: turn({ threadId: id }),
    items: [item(id, 1, 'assistant', { text }, 'done')],
  })
  let finish!: (value: ReturnType<typeof data>) => void
  const stalled = new Promise<ReturnType<typeof data>>((resolve) => {
    finish = resolve
  })
  const signals: (AbortSignal | undefined)[] = []
  vi.spyOn(agentApi, 'items').mockImplementation((id, _seq, signal) => {
    signals.push(signal)
    return id === 41 ? stalled : Promise.resolve(data(42, 'Current child output'))
  })
  w = mount(SubtaskDetail, {
    props: { parentId: 7, threadId: 41 },
    global: { plugins: [ElementPlus, i18n, router] },
  })
  await flushPromises()
  await w.setProps({ threadId: 42 })
  await flushPromises()
  expect(w.text()).toContain('Current child output')
  expect(signals[0]!.aborted).toBe(true)
  finish(data(41, 'Late old child output'))
  await flushPromises()
  expect(w.text()).not.toContain('Late old child output')
  expect(w.text()).toContain('Current child output')
})

describe('editing identities and full conversation snapshots', () => {
  it('uses a distinct draft identity for each edit after creating and successfully sending a conversation', async () => {
    const detail = (id: number, text: string) => ({
      thread: thread(id),
      items: [
        item(id * 10, 1, 'user', { text }),
        item(id * 10 + 1, 2, 'assistant', { text: 'Done' }, 'done'),
      ],
      turn: turn({ threadId: id }),
    })
    const calls = mockApi({
      ...BASE,
      'POST /agent/threads': ok(thread(9)),
      'POST /agent/threads/9/messages': ok(turn({ threadId: 9 })),
      'GET /agent/threads/9/items': ok(detail(9, 'Original')),
      'POST /agent/threads/9/fork': ok(thread(10)),
      'GET /agent/threads/10/items': ok(detail(10, 'First edit')),
      'POST /agent/threads/10/messages': ok(turn({ threadId: 10 })),
      'POST /agent/threads/10/fork': ok(thread(11)),
      'GET /agent/threads/11/items': ok(detail(11, 'Second edit')),
      'POST /agent/threads/11/messages': ok(turn({ threadId: 11 })),
    })
    await show()
    await type('Original')
    await key('Enter')
    for (const text of ['First edit', 'Second edit']) {
      await w.find('button[aria-label="Edit and resend"]').trigger('click')
      await flushPromises()
      await type(text)
      await key('Enter')
      expect(textarea().element.value).toBe('')
    }
    const identities = [
      body(sent(calls, 'post', '/agent/threads')[0]),
      body(sent(calls, 'post', '/agent/threads/9/fork')[0]),
      body(sent(calls, 'post', '/agent/threads/10/fork')[0]),
    ] as { clientDraftId: string }[]
    expect(identities.map((request) => request.clientDraftId)).toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ])
    expect(new Set(identities.map((request) => request.clientDraftId)).size).toBe(3)
    expect(sent(calls, 'post', '/agent/threads/11/messages')).toHaveLength(1)
  })

  it('keeps the fork identity when explicitly retrying the same edit after an unknown acknowledgement', async () => {
    mockApi({
      ...BASE,
      'GET /agent/threads/7/items': ok({ thread: thread(7), items: ITEMS, turn: turn() }),
      'GET /agent/threads/11/items': ok({ thread: thread(11), items: [], turn: null }),
      'POST /agent/threads/11/messages': ok(turn({ threadId: 11 })),
    })
    const fork = vi
      .spyOn(agentApi, 'fork')
      .mockRejectedValueOnce(new ApiError(503, 'A0500', 'Unavailable'))
      .mockResolvedValue(thread(11))
    vi.spyOn(agentApi, 'draftReceipt').mockRejectedValue(new ApiError(404, 'A0440', 'Not found'))
    await show()
    await open()
    await w.find('button[aria-label="Edit and resend"]').trigger('click')
    await flushPromises()
    await type('Same edited intent')
    await key('Enter')
    expect(fork).toHaveBeenCalledTimes(1)
    expect(textarea().element.value).toBe('Same edited intent')
    await key('Enter')
    expect(fork).toHaveBeenCalledTimes(2)
    expect(fork.mock.calls[1]).toEqual(fork.mock.calls[0])
    expect(textarea().element.value).toBe('')
  })

  it('keeps newer committed text and turn state when reopening the current conversation returns an older snapshot', async () => {
    const initial = {
      thread: thread(7),
      items: [{ ...ITEMS[1], revision: 1 }],
      turn: turn({ status: 'running' }),
    }
    const routes: Record<string, Route> = { ...BASE, 'GET /agent/threads/7/items': ok(initial) }
    mockApi(routes)
    await show()
    await open()
    let release!: (value: ReturnType<typeof ok>) => void
    const delayed = new Promise<ReturnType<typeof ok>>((resolve) => (release = resolve))
    routes['GET /agent/threads/7/items'] = () => delayed
    await threadButton('Thread 7').trigger('click')
    await flushPromises()
    push({ threadId: 7, type: 'delta', itemId: 2, revision: 2, offset: 7, delta: ' updated' })
    push({ threadId: 7, type: 'turn', turn: turn({ status: 'waiting' }) })
    await flushPromises()
    expect(w.find('.agent-msg--assistant').text()).toBe('Acme is updated')
    release(ok(initial))
    await flushPromises()
    expect(w.find('.agent-msg--assistant').text()).toBe('Acme is updated')
    expect(w.find('.agent-chat__turn').text()).toBe('Waiting for you')
    routes['GET /agent/threads/8/items'] = ok({ thread: thread(8), items: [], turn: null })
    await open('Old one')
    expect(w.find('.agent-msg--assistant').exists()).toBe(false)
    expect(w.find('.agent-chat__turn').text()).toBe('')
  })

  it('applies deleted items from a full snapshot while retaining a new item received during the request', async () => {
    const routes: Record<string, Route> = { ...BASE }
    mockApi(routes)
    await show()
    await open()
    let release!: (value: ReturnType<typeof ok>) => void
    const delayed = new Promise<ReturnType<typeof ok>>((resolve) => (release = resolve))
    routes['GET /agent/threads/7/items'] = () => delayed
    await threadButton('Thread 7').trigger('click')
    await flushPromises()
    push({
      threadId: 7,
      type: 'item',
      item: { ...item(99, 20, 'assistant', { text: 'New live item' }, 'running'), revision: 1 },
    })
    release(ok({ thread: thread(7), items: [], turn: null }))
    await flushPromises()
    expect(w.findAll('.agent-msg--assistant')).toHaveLength(1)
    expect(w.find('.agent-msg--assistant').text()).toBe('New live item')
    expect(w.text()).not.toContain('Who is Acme?')
  })

  it('opens a notification target while the conversation route is already mounted without duplicating its read', async () => {
    const calls = mockApi({
      ...BASE,
      'GET /agent/threads/8/items': ok({ thread: thread(8), items: [], turn: null }),
    })
    await show('/?thread=7')
    useMenuStore().tree = [
      node({
        id: 1,
        routePath: '/',
        routeName: 'agent-chat',
        component: 'platform/agent/chat/index',
      }),
    ]
    const notice = mount(InboxMessageView, {
      props: {
        message: {
          id: 1,
          category: 'business',
          senderLabel: null,
          title: 'Waiting',
          body: 'Plain notice',
          readAt: null,
          createdAt: NOW,
          action: { kind: 'agent-thread', threadId: 8 },
        },
      },
      global: { plugins: [ElementPlus, i18n, router] },
    })
    try {
      await notice
        .findAll('button')
        .find((button) => button.text() === 'Open conversation')!
        .trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.query.thread).toBe('8')
      expect(w.find('.agent-chat__title').text()).toBe('Thread 8')
      expect(sent(calls, 'get', '/agent/threads/8/items')).toHaveLength(1)
    } finally {
      notice.unmount()
    }
  })

  it('keeps the latest query target when earlier navigation returns late and ignores invalid identifiers', async () => {
    let release!: (value: ReturnType<typeof ok>) => void
    const delayed = new Promise<ReturnType<typeof ok>>((resolve) => (release = resolve))
    const calls = mockApi({
      ...BASE,
      'GET /agent/threads/8/items': () => delayed,
      'GET /agent/threads/9/items': ok({ thread: thread(9), items: [], turn: null }),
    })
    await show('/?thread=7')
    await router.push({ query: { thread: '8' } })
    await flushPromises()
    await router.push({ query: { thread: '9' } })
    await flushPromises()
    release(ok({ thread: thread(8), items: [], turn: null }))
    await flushPromises()
    expect(w.find('.agent-chat__title').text()).toBe('Thread 9')
    expect(router.currentRoute.value.query.thread).toBe('9')
    for (const invalid of ['9007199254740992', '8garbage', ['8', '9']]) {
      await router.push({ query: { thread: invalid } })
      await flushPromises()
    }
    expect(sent(calls, 'get', '/agent/threads/8/items')).toHaveLength(1)
    expect(w.find('.agent-chat__title').text()).toBe('Thread 9')
  })

  it('preserves an uncertain delivery and later input when a query target opens another conversation', async () => {
    const calls = mockApi({
      ...BASE,
      'POST /agent/threads/7/messages': fail(503, 'A0500'),
      'GET /agent/threads/8/items': ok({ thread: thread(8), items: [], turn: null }),
    })
    const receipt = vi
      .spyOn(agentApi, 'messageReceipt')
      .mockRejectedValue(new ApiError(503, 'A0500', 'Unavailable'))
    await show('/?thread=7')
    await type('Uncertain original text')
    await key('Enter')
    const identity = sessionStorage.getItem('qw.agent.delivery.1:1')
    await type('A later unsent draft')
    await router.push({ query: { thread: '8' } })
    await flushPromises()
    expect(w.find('.agent-chat__title').text()).toBe('Thread 8')
    expect(textarea().element.value).toBe('A later unsent draft')
    expect(sessionStorage.getItem('qw.agent.delivery.1:1')).toBe(identity)
    const original = body(sent(calls, 'post', '/agent/threads/7/messages')[0]) as {
      clientMessageId: string
    }
    receipt.mockResolvedValue(received(original.clientMessageId))
    await w.find('.agent-chat__delivery button').trigger('click')
    await flushPromises()
    expect(w.find('.agent-chat__title').text()).toBe('Thread 8')
    expect(textarea().element.value).toBe('A later unsent draft')
    expect(sent(calls, 'post', '/agent/threads/7/messages')).toHaveLength(1)
    expect(sent(calls, 'post', '/agent/threads/8/messages')).toHaveLength(0)
  })
})
