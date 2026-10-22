// Profiles and memories on the chat page: "My memories" lists the own entries with their source, adds one and
// forgets everything only after the current password is entered; the profile form sends the tool list one
// name per line (empty: any tool); the header bar picks the default profile for a new chat and brings its
// settings into the composer, "no profile" clears it, and an open chat switches its memory on and off (not
// shown for temporary chats).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import type { AgentMemoryVo, AgentProfileVo, AgentThreadVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import { appSettings } from '@/core/stores/app'
import { useAuthStore } from '@/core/stores/auth'
import MemoryForm from '@/views/platform/agent/chat/MemoryForm.vue'
import MemoryPanel from '@/views/platform/agent/chat/MemoryPanel.vue'
import ProfileForm from '@/views/platform/agent/chat/ProfileForm.vue'
import ProfileMemoryBar from '@/views/platform/agent/chat/ProfileMemoryBar.vue'
import { me, mockApi, ok } from './mock-api'

const AT = '2026-10-22T01:00:00.000Z'
let w: VueWrapper
const t = (key: string, args?: Record<string, unknown>) => i18n.global.t(key, args ?? {})
const button = (text: string) => w.findAll('button').find((b) => b.text() === text)
const sent = (
  calls: { method?: string; url?: string; data?: unknown }[],
  method: string,
  url: string,
) =>
  calls
    .filter((c) => c.method === method && c.url === url)
    .map((c) => JSON.parse(String(c.data)) as Record<string, unknown>)

async function show(component: object, props: Record<string, unknown> = {}) {
  useAuthStore().me = me(['agent.chat.use'])
  w = mount(component, { props, global: { plugins: [ElementPlus, i18n] }, attachTo: document.body })
  await flushPromises()
}

const MEMORY: AgentMemoryVo = {
  id: 5,
  content: 'Prefers green tea',
  source: 'chat',
  sourceThreadId: 9,
  lastUsedAt: null,
  createdAt: AT,
}
const profile = (p: Partial<AgentProfileVo>): AgentProfileVo => ({
  id: 1,
  scope: 'user',
  name: 'Quick',
  providerId: 3,
  model: 'fast-1',
  reasoning: null,
  approvalMode: 'read_only',
  tools: null,
  instructions: null,
  isDefault: false,
  editable: true,
  ...p,
})
const THREAD = {
  id: 7,
  title: 'T',
  temporary: false,
  memoryEnabled: true,
  profileId: null,
} as unknown as AgentThreadVo

beforeEach(() => {
  appSettings.value.tableActionsVisible = 9
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  w?.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('my memories', () => {
  it('lists the own memories with their source', async () => {
    mockApi({ 'GET /agent/memories': ok({ items: [MEMORY], total: 1 }) })
    await show(MemoryPanel)
    expect(w.text()).toContain('Prefers green tea')
    expect(w.text()).toContain(t('agent.memory.source.chat'))
  })

  it('forgets everything only after the current password is entered', async () => {
    const calls = mockApi({
      'GET /agent/memories': ok({ items: [MEMORY], total: 1 }),
      'POST /agent/memories/forget-all': ok({ removed: 1 }),
    })
    await show(MemoryPanel)
    const prompt = vi.spyOn(ElMessageBox, 'prompt').mockRejectedValueOnce('cancel')
    await button(t('agent.memory.forgetAll'))!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/agent/memories/forget-all')).toEqual([])

    prompt.mockResolvedValueOnce({ value: 'my-password', action: 'confirm' } as never)
    await button(t('agent.memory.forgetAll'))!.trigger('click')
    await flushPromises()
    expect(prompt.mock.calls[1]![2]).toMatchObject({ inputType: 'password' })
    expect(sent(calls, 'post', '/agent/memories/forget-all')).toEqual([
      { currentPassword: 'my-password' },
    ])
    expect(ElMessage.success).toHaveBeenCalledWith(t('agent.memory.forgotten', { n: 1 }))
  })

  it('adds a memory', async () => {
    const calls = mockApi({ 'POST /agent/memories': [201, { code: 0, msg: 'ok', data: MEMORY }] })
    await show(MemoryForm)
    await w.find('textarea').setValue('Prefers green tea')
    await button(t('crud.action.save'))!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/agent/memories')).toEqual([{ content: 'Prefers green tea' }])
  })
})

describe('profiles', () => {
  it('sends the tool list one name per line, empty for any tool', async () => {
    const calls = mockApi({
      'POST /agent/profiles': [201, { code: 0, msg: 'ok', data: profile({ id: 4 }) }],
    })
    await show(ProfileForm)
    await w.find('input[maxlength="64"]').setValue('Readers')
    const [tools] = w.findAll('textarea')
    await tools!.setValue('demo.customer.get\n\n demo.customer.search ')
    await button(t('crud.action.save'))!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/agent/profiles')[0]).toMatchObject({
      scope: 'user',
      name: 'Readers',
      providerId: null,
      model: null,
      approvalMode: 'ask',
      tools: ['demo.customer.get', 'demo.customer.search'],
      instructions: null,
    })
    await tools!.setValue('  ')
    await button(t('crud.action.save'))!.trigger('click')
    await flushPromises()
    expect(sent(calls, 'post', '/agent/profiles')[1]).toMatchObject({ tools: null })
  })

  it('picks the default profile for a new chat and brings its settings; no profile clears it', async () => {
    mockApi({
      'GET /agent/profiles': ok([
        profile({ id: 1, scope: 'tenant', isDefault: true, name: 'Shared' }),
        profile({ id: 2, isDefault: true, name: 'Mine' }),
      ]),
    })
    await show(ProfileMemoryBar, { draft: { profileId: undefined, memoryEnabled: true } })
    const draft = w.emitted('update:draft') as [{ profileId: number | null }][]
    // the personal default wins
    expect(draft.at(-1)![0]).toMatchObject({ profileId: 2 })
    expect((w.emitted('apply') as [AgentProfileVo][]).at(-1)![0]).toMatchObject({ id: 2 })
    await w.setProps({ draft: { profileId: 2, memoryEnabled: true } })
    // the clear button of the select
    w.findComponent({ name: 'ElSelect' }).vm.$emit('update:modelValue', undefined)
    await flushPromises()
    expect(
      (w.emitted('update:draft') as [{ profileId: number | null }][]).at(-1)![0],
    ).toMatchObject({ profileId: null })
    expect((w.emitted('apply') as [AgentProfileVo | null][]).at(-1)![0]).toBeNull()
  })

  it('switches the memory of an open chat; temporary chats have no switch', async () => {
    const calls = mockApi({
      'GET /agent/profiles': ok([]),
      'PATCH /agent/threads/7': ok({ ...THREAD, memoryEnabled: false }),
    })
    await show(ProfileMemoryBar, {
      thread: THREAD,
      draft: { profileId: undefined, memoryEnabled: true },
    })
    await w.find('.el-switch').trigger('click')
    await flushPromises()
    expect(sent(calls, 'patch', '/agent/threads/7')).toEqual([{ memoryEnabled: false }])
    expect((w.emitted('updated') as [AgentThreadVo][])[0]![0]).toMatchObject({
      memoryEnabled: false,
    })
    await w.setProps({ thread: { ...THREAD, temporary: true } })
    expect(w.find('.el-switch').exists()).toBe(false)
  })
})
