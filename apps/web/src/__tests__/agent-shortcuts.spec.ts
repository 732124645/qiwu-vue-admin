// The chat page's own keyboard shortcuts (new chat, focus the message box, stop, plan mode): combos by the
// physical key, conflicts refused (keys the page owns, a missing modifier, another action's combo), saved
// per user in this browser and read back with defaults filled in (a broken or blocked storage falls back),
// the settings page recording a combo, the page acting on the saved combos, and opening the current
// thread in a new window.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElDropdown, ElMessage } from 'element-plus'
import type { AgentOptionsVo, AgentThreadVo, AgentTurnVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import ChatPage from '@/views/platform/agent/chat/index.vue'
import ShortcutSettings from '@/views/platform/agent/chat/ShortcutSettings.vue'
import {
  comboLabel,
  comboOf,
  conflictOf,
  DEFAULT_SHORTCUTS,
  loadShortcuts,
  saveShortcuts,
  type Shortcuts,
} from '@/views/platform/agent/chat/shortcuts'
import { me, mockApi, ok, type Route } from './mock-api'

vi.mock('@/core/realtime/socket', async () => {
  const { shallowRef } = await import('vue')
  return { realtimeStatus: shallowRef('up'), onRealtime: () => () => undefined }
})

const press = (init: KeyboardEventInit) =>
  new KeyboardEvent('keydown', { cancelable: true, ...init })
const KEY = 'qw.agent.shortcuts.1'

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  useAuthStore().me = me(['*'])
  localStorage.clear()
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('shortcut combos', () => {
  it('reads the held modifiers and the physical key, ignoring a lone modifier', () => {
    expect(comboOf(press({ key: '˜', code: 'KeyN', altKey: true }))).toBe('Alt+KeyN')
    expect(comboOf(press({ code: 'KeyP', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+KeyP')
    expect(comboOf(press({ key: 'Escape' }))).toBe('Escape')
    expect(comboOf(press({ key: 'Alt', code: 'AltLeft', altKey: true }))).toBeNull()
    expect(comboOf(press({ code: 'KeyA', isComposing: true }))).toBeNull()
    expect(comboLabel('Meta+Shift+Digit1')).toBe('⌘+Shift+1')
  })

  it('refuses keys the page owns, a page-wide combo without a modifier and a taken combo', () => {
    const map = { ...DEFAULT_SHORTCUTS }
    expect(conflictOf(map, 'newChat', 'Ctrl+KeyK')).toBe('reserved')
    expect(conflictOf(map, 'stop', 'Enter')).toBe('reserved')
    // copy, paste, cut, undo, redo and select all stay with editing; new window, new tab and close tab
    // with the browser
    for (const k of ['C', 'V', 'X', 'Z', 'Y', 'A', 'N', 'T', 'W'])
      for (const mod of ['Ctrl', 'Meta'])
        expect(conflictOf(map, 'togglePlan', `${mod}+Key${k}`)).toBe('reserved')
    expect(conflictOf(map, 'togglePlan', 'Ctrl+Shift+KeyZ')).toBe('reserved')
    expect(conflictOf(map, 'togglePlan', 'Shift+Meta+KeyZ')).toBe('reserved')
    expect(conflictOf(map, 'newChat', 'Shift+KeyN')).toBe('modifier')
    expect(conflictOf(map, 'focusComposer', 'Alt+KeyN')).toBe('newChat')
    expect(conflictOf(map, 'newChat', 'Alt+KeyN')).toBeNull()
    // stop: Esc alone, or a combo with Ctrl, Alt or ⌘; no other plain key
    expect(conflictOf(map, 'stop', 'Escape')).toBeNull()
    expect(conflictOf(map, 'stop', 'Alt+KeyS')).toBeNull()
    expect(conflictOf(map, 'stop', 'F2')).toBe('modifier')
    expect(conflictOf(map, 'stop', 'Shift+Escape')).toBe('modifier')
    expect(conflictOf(map, 'newChat', 'Escape')).toBe('modifier')
  })

  it('saves per user and reads back with defaults; a broken or blocked storage falls back', () => {
    saveShortcuts(1, { ...DEFAULT_SHORTCUTS, stop: 'Alt+KeyS' })
    expect(loadShortcuts(1)).toEqual({ ...DEFAULT_SHORTCUTS, stop: 'Alt+KeyS' })
    expect(loadShortcuts(2)).toEqual(DEFAULT_SHORTCUTS)
    localStorage.setItem(KEY, JSON.stringify({ newChat: 7, focusComposer: 'Alt+KeyF' }))
    expect(loadShortcuts(1)).toEqual({ ...DEFAULT_SHORTCUTS, focusComposer: 'Alt+KeyF' })
    localStorage.setItem(KEY, '{not json')
    expect(loadShortcuts(1)).toEqual(DEFAULT_SHORTCUTS)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(loadShortcuts(1)).toEqual(DEFAULT_SHORTCUTS)
    expect(() => saveShortcuts(1, { ...DEFAULT_SHORTCUTS })).not.toThrow()
  })
})

describe('shortcut settings', () => {
  let w: VueWrapper
  afterEach(() => w?.unmount())

  async function mountSettings() {
    const model = { value: { ...DEFAULT_SHORTCUTS } as Shortcuts }
    w = mount(ShortcutSettings, {
      props: {
        modelValue: model.value,
        'onUpdate:modelValue': (v: Shortcuts) => {
          model.value = v
          void w.setProps({ modelValue: v })
        },
      },
      global: { plugins: [ElementPlus, i18n] },
      attachTo: document.body,
    })
    await flushPromises()
    return model
  }
  const row = (action: string) =>
    document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!

  it('records the next combo, and keeps the old one with a notice on a conflict', async () => {
    const model = await mountSettings()
    expect(row('newChat').textContent).toContain('Alt+N')
    row('newChat').click()
    await flushPromises()
    expect(row('newChat').textContent).toContain('Press the new keys')
    window.dispatchEvent(press({ code: 'KeyM', ctrlKey: true, altKey: true }))
    await flushPromises()
    expect(model.value.newChat).toBe('Ctrl+Alt+KeyM')
    expect(row('newChat').textContent).toContain('Ctrl+Alt+M')

    row('togglePlan').click()
    await flushPromises()
    window.dispatchEvent(press({ code: 'KeyM', ctrlKey: true, altKey: true }))
    await flushPromises()
    expect(model.value.togglePlan).toBe('Alt+KeyP')
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(
      'Ctrl+Alt+M is already used for “New conversation”',
    )

    document
      .querySelectorAll<HTMLButtonElement>('.agent-shortcuts button')
      .forEach((b) => b.textContent?.includes('Restore defaults') && b.click())
    await flushPromises()
    expect(model.value).toEqual(DEFAULT_SHORTCUTS)
  })

  it('lets Tab through while recording; Esc cancels other actions but is the stop key itself', async () => {
    const model = await mountSettings()
    row('newChat').click()
    await flushPromises()
    const tab = press({ key: 'Tab', code: 'Tab' })
    window.dispatchEvent(tab)
    await flushPromises()
    expect(tab.defaultPrevented).toBe(false)
    expect(row('newChat').textContent).toContain('Press the new keys')

    const esc = press({ key: 'Escape', code: 'Escape' })
    window.dispatchEvent(esc)
    await flushPromises()
    expect(esc.defaultPrevented).toBe(true)
    expect(model.value.newChat).toBe('Alt+KeyN')
    expect(row('newChat').textContent).toContain('Alt+N')
    expect(document.querySelector('[role="alert"]')).toBeNull()

    model.value = { ...model.value, stop: 'Alt+KeyS' }
    await w.setProps({ modelValue: model.value })
    row('stop').click()
    await flushPromises()
    window.dispatchEvent(press({ key: 'Escape', code: 'Escape' }))
    await flushPromises()
    expect(model.value.stop).toBe('Escape')
  })
})

// ---- the page ----
const NOW = new Date().toISOString()
const thread = (p: Partial<AgentThreadVo> = {}): AgentThreadVo => ({
  id: 7,
  title: 'Thread 7',
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
  turnStatus: 'running',
  lastActiveAt: NOW,
  createdAt: NOW,
  ...p,
})
const turn: AgentTurnVo = {
  id: 1,
  threadId: 7,
  status: 'running',
  steps: 1,
  promptTokens: 0,
  completionTokens: 0,
  credits: '0',
  unpricedCalls: 0,
  unreportedCalls: 0,
  legacyUsage: false,
  error: null,
  startedAt: NOW,
  endedAt: null,
}
const OPTIONS: AgentOptionsVo = {
  providers: [
    {
      id: 1,
      name: 'P',
      models: [
        {
          id: 'm1',
          label: 'M',
          reasoning: false,
          vision: false,
          fast: false,
          contextWindow: 64000,
        },
      ],
    },
  ],
  defaults: { providerId: 1, model: 'm1' },
  skills: [],
  approvalModes: ['ask'],
  webSearch: false,
  paused: false,
  starters: [],
  prompts: [],
  trustSession: false,
  servers: [],
  tone: 'default',
}
const ROUTES: Record<string, Route> = {
  'GET /agent/options': ok(OPTIONS),
  'GET /agent/threads': ok({ items: [thread()], total: 1 }),
  'GET /agent/threads/7/items': ok({ thread: thread(), items: [], turn }),
  'GET /agent/threads/7/status': ok({
    threadId: 7,
    model: 'm1',
    contextUsed: 0,
    contextWindow: 64000,
    turn,
    today: { userTokens: 0, userLimit: 0, tenantTokens: 0, tenantLimit: 0 },
  }),
  'POST /agent/threads/7/cancel': ok(null),
  'PATCH /agent/threads/7': (c) => ok(thread(JSON.parse(String(c.data)) as Partial<AgentThreadVo>)),
}

describe('chat page shortcuts and new window', () => {
  let w: VueWrapper
  afterEach(() => w?.unmount())

  async function showThread() {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/agent', name: 'agent-chat', component: { render: () => null } }],
    })
    await router.push('/agent?thread=7')
    w = mount(ChatPage, {
      global: { plugins: [ElementPlus, i18n, router], directives: { perm: vPerm } },
      attachTo: document.body,
    })
    await flushPromises()
  }

  it('acts on the saved combos only: plan mode, focus, new chat, stop', async () => {
    saveShortcuts(1, {
      newChat: 'Ctrl+Alt+KeyN',
      focusComposer: 'Alt+KeyF',
      stop: 'Alt+KeyS',
      togglePlan: 'Alt+KeyL',
    })
    const calls = mockApi(ROUTES)
    await showThread()
    const patches = () => calls.filter((c) => c.method === 'patch')

    window.dispatchEvent(press({ code: 'KeyP', altKey: true }))
    await flushPromises()
    expect(patches()).toHaveLength(0)
    window.dispatchEvent(press({ code: 'KeyL', altKey: true }))
    await flushPromises()
    expect(JSON.parse(String(patches()[0]?.data))).toMatchObject({ planMode: true })

    window.dispatchEvent(press({ code: 'KeyF', altKey: true }))
    expect(document.activeElement).toBe(w.find('textarea').element)

    // stop: the saved key in the empty message box, Esc no longer
    await w.find('textarea').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(calls.filter((c) => c.url === '/agent/threads/7/cancel')).toHaveLength(0)
    await w.find('textarea').trigger('keydown', { key: 'ß', code: 'KeyS', altKey: true })
    await flushPromises()
    expect(calls.filter((c) => c.url === '/agent/threads/7/cancel')).toHaveLength(1)

    window.dispatchEvent(press({ code: 'KeyN', altKey: true }))
    await flushPromises()
    expect(w.find('.agent-chat__title').text()).toBe('Thread 7')
    window.dispatchEvent(press({ code: 'KeyN', altKey: true, ctrlKey: true }))
    await flushPromises()
    expect(w.find('.agent-chat__title').text()).toBe('New conversation')
  })

  it('opens the current thread in a new window', async () => {
    mockApi(ROUTES)
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await showThread()
    w.find('.agent-chat__head').findComponent(ElDropdown).vm.$emit('command', 'window')
    expect(open).toHaveBeenCalledWith('/agent?thread=7', '_blank', 'noopener')
  })
})
