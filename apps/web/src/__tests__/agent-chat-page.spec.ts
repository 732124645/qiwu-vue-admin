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
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { useMenuStore } from '@/core/stores/menu'
import FileUpload from '@/core/components/FileUpload.vue'
import AgentEntry from '@/views/platform/agent/chat/AgentEntry.vue'
import ChatPage from '@/views/platform/agent/chat/index.vue'
import {
  pendingContext,
  pendingRoute,
  useAgentContext,
} from '@/views/platform/agent/chat/use-agent-context'
import { me, mockApi, node, ok, type Route } from './mock-api'

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
    today: { userTokens: 5000, userLimit: 100000, tenantTokens: 9000, tenantLimit: 1000000 },
  }),
}
type Call = { method?: string; url?: string; params?: unknown; data?: unknown }
const sent = (calls: Call[], method: string, url: string) =>
  calls.filter((c) => c.method === method && c.url === url)
const body = (c: Call | undefined) => JSON.parse(String(c?.data)) as unknown

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
  w.findAll('[role="option"]').map((o) => o.find('.agent-composer__label').text())

beforeEach(() => {
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
    expect(w.find('summary').text()).toContain('Web search')
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
    expect(sent(calls, 'get', '/agent/threads/7/items')).toHaveLength(1)
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
    expect(body(sent(calls, 'post', '/agent/threads/9/messages')[0])).toEqual({ text: 'Fill them' })
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
    expect(body(sent(calls, 'post', '/agent/threads/7/fork')[0])).toEqual({ seq: 1 })
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

  it('on a narrow screen folds the header tools behind More', async () => {
    vi.stubGlobal('matchMedia', (media: string) => ({
      media,
      matches: media === '(max-width: 640px)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
    try {
      mockApi(BASE)
      await show()
      const tools = w.find('#agent-chat-tools')
      expect(tools.isVisible()).toBe(false)
      const more = w.find('button[aria-controls="agent-chat-tools"]')
      expect(more.attributes('aria-expanded')).toBe('false')
      await more.trigger('click')
      expect(tools.isVisible()).toBe(true)
      expect(more.attributes('aria-expanded')).toBe('true')
      expect(tools.find('[aria-label="Keyboard shortcuts"]').exists()).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('composer', () => {
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
    expect(status).toContain('You today5000 / 100000')
    expect(status).toContain('Tenant today9000 / 1000000')
    expect(status).toContain('Context12000 / 64000')

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
    expect(w.find('[role="option"]').text()).toContain('Fill in customer details')
    await key('Enter')
    expect(textarea().element.value).toBe('please $fill-customer ')
    expect(suggestions()).toEqual([])
    await type('please $fill-customer for Acme')
    await key('Enter')
    expect(body(sent(calls, 'post', '/agent/threads/7/messages')[0])).toEqual({
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
    expect(body(sent(calls, 'post', '/agent/threads/7/fork')[0])).toEqual({ seq: 0 })
    expect(body(sent(calls, 'post', '/agent/threads/11/messages')[0])).toEqual({
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
      text: 'Read this card',
      fileIds: [41],
    })
    expect(w.findComponent(FileUpload).exists()).toBe(false)

    await button('Plan mode')!.trigger('click')
    await flushPromises()
    expect(body(sent(calls, 'patch', '/agent/threads/7').at(-1))).toMatchObject({ planMode: true })
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
    expect(w.find('.agent-composer__context').text()).toContain('Context 19%')
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
      text: 'Go ahead with the plan',
    })
    expect(button('Plan mode')!.attributes('aria-pressed')).toBe('false')
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
      text: 'Check @record:demo.customer#4 with @skill:fill-customer now',
      skill: 'fill-customer',
    })
  })

  it('Ctrl+R searches the sent messages, newest first; Esc puts the draft back', async () => {
    sessionStorage.clear()
    sessionStorage.setItem(
      'qw.agent.history.1',
      JSON.stringify(['Weekly report', 'Find Acme', 'Weekly sales']),
    )
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
  it('shows only with the chat page in the menu and carries the page and its published selection', async () => {
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
      }),
    ]
    await flushPromises()
    await entry.find('button[aria-label="Assistant"]').trigger('click')
    await flushPromises()
    expect(pendingContext.value).toEqual({
      route: '/demo/customers?page=2',
      title: 'Customers',
      target: 'demo.customer',
      ids: [3, 4],
    })
    expect(pendingRoute.value).toBe('demo-customer')
    expect(router.currentRoute.value.name).toBe('agent-chat')
    // on the chat page itself the button hides
    expect(entry.find('button').exists()).toBe(false)
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
