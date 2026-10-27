// The plan card of the plan mode: the proposed plan (title, summary, numbered steps, expected changes,
// assumptions), the three choices with the right primary button, Enter on the focused card, the feedback box
// of "keep refining", buttons disabled while pending, the decided state read-only; the chat row picks the plan
// card for a proposal and folds the runtime's execution message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import type { AgentItemVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import ChatItem from '@/views/platform/agent/chat/ChatItem.vue'
import PlanCard from '@/views/platform/agent/chat/PlanCard.vue'
import { mockApi, ok, type Route } from './mock-api'

type Question = Extract<AgentItemVo, { kind: 'question' }>
const AT = '2026-10-22T08:00:00.000Z'
const PLAN = {
  title: 'Rename note 1',
  summary: 'Read the note, then change its title.',
  steps: ['Read note 1', 'Change its title'],
  changes: 'The title of note 1',
  assumptions: ['Note 1 exists'],
}
const card = (
  status: Question['status'] = 'pending',
  extra: Partial<Question['payload']> = {},
): Question => ({
  id: 31,
  seq: 31,
  turnId: 1,
  kind: 'question',
  status,
  payload: { callId: 'c1', from: 'agent', questions: [], proposal: PLAN, ...extra },
  createdAt: AT,
})

let w: VueWrapper
const global = { plugins: [ElementPlus, i18n] }
type Call = { url?: string; data?: unknown }
const body = (c: Call | undefined) => JSON.parse(String(c?.data)) as unknown
const button = (text: string) => w.findAll('button').find((b) => b.text() === text)
const L = {
  auto: 'Approve, run with automatic review',
  ask: 'Approve, confirm each change',
  refine: 'Keep refining',
}
function held(): { route: Route; release: () => void } {
  let release = () => {}
  const gate = new Promise<void>((r) => (release = r))
  return { route: async () => (await gate, ok(null)), release }
}

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

describe('plan card', () => {
  it('shows the plan; with the automatic review it is the primary choice and Enter on the card picks it', async () => {
    const gate = held()
    const calls = mockApi({ 'POST /agent/plans/31': gate.route })
    w = mount(PlanCard, { props: { item: card(), autoReview: true }, global })
    expect(w.text()).toContain('Rename note 1')
    expect(w.text()).toContain('Read the note, then change its title.')
    expect(w.findAll('.agent-plan-card__steps li').map((l) => l.text())).toEqual(PLAN.steps)
    expect(w.text()).toContain('The title of note 1')
    expect(w.text()).toContain('Note 1 exists')
    expect(button(L.auto)!.classes()).toContain('el-button--primary')
    expect(button(L.ask)!.classes()).not.toContain('el-button--primary')
    // Enter on a button keeps the button's own behavior
    await button(L.refine)!.trigger('keydown', { key: 'Enter' })
    expect(calls).toHaveLength(0)
    await w.find('section').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    for (const label of [L.auto, L.ask, L.refine])
      expect(button(label)!.attributes('disabled')).toBeDefined()
    await w.find('section').trigger('keydown', { key: 'Enter' })
    gate.release()
    await flushPromises()
    expect(calls).toHaveLength(1)
    expect(body(calls[0])).toEqual({ decision: 'auto_review' })
    expect(w.emitted('decided')).toEqual([['auto_review']])
    expect(button(L.auto)).toBeUndefined()
    expect(w.text()).toContain('Approved · automatic review')
  })

  it('without the automatic review only the two others show and confirming each change is primary', async () => {
    const calls = mockApi({ 'POST /agent/plans/31': ok(null) })
    w = mount(PlanCard, { props: { item: card() }, global })
    expect(button(L.auto)).toBeUndefined()
    expect(button(L.ask)!.classes()).toContain('el-button--primary')
    await w.find('section').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(body(calls[0])).toEqual({ decision: 'ask' })
  })

  it('keep refining opens the feedback box; Esc goes back, Enter sends the feedback', async () => {
    const calls = mockApi({ 'POST /agent/plans/31': ok(null) })
    w = mount(PlanCard, { props: { item: card() }, global, attachTo: document.body })
    expect(w.find('textarea').exists()).toBe(false)
    await button(L.refine)!.trigger('click')
    await w.find('textarea').trigger('keydown', { key: 'Escape' })
    expect(w.find('textarea').exists()).toBe(false)
    await button(L.refine)!.trigger('click')
    await w.find('textarea').setValue('  Add a backup step ')
    await w.find('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(body(calls[0])).toEqual({ decision: 'refine', feedback: 'Add a backup step' })
    expect(w.emitted('decided')).toEqual([['refine']])
  })

  it('a decided or shared card is read-only with the choice taken', () => {
    w = mount(PlanCard, {
      props: {
        item: card('answered', {
          choice: { decision: 'refine', decidedBy: 1, decidedAt: AT, feedback: 'More detail' },
        }),
        autoReview: true,
      },
      global,
    })
    expect(w.findAll('button')).toHaveLength(0)
    expect(w.text()).toContain('Sent back for changes')
    expect(w.text()).toContain('More detail')
    w.unmount()
    w = mount(PlanCard, { props: { item: card(), readonly: true }, global })
    expect(w.findAll('button')).toHaveLength(0)
    w.unmount()
    w = mount(PlanCard, { props: { item: card('expired') }, global })
    expect(w.text()).toContain('Closed')
  })

  it('the chat row shows a proposal as the plan card and folds the execution message', () => {
    w = mount(ChatItem, { props: { row: { kind: 'item', key: 'i31', item: card() } }, global })
    expect(w.find('.agent-plan-card').exists()).toBe(true)
    expect(w.find('.agent-question').exists()).toBe(false)
    w.unmount()
    const started = {
      id: 40,
      seq: 40,
      turnId: 2,
      kind: 'user',
      status: null,
      payload: { text: 'The approved plan:\nTitle: Rename note 1', fromPlan: 31 },
      createdAt: AT,
    } as Extract<AgentItemVo, { kind: 'user' }>
    w = mount(ChatItem, { props: { row: { kind: 'item', key: 'i40', item: started } }, global })
    expect(w.find('summary').text()).toBe('Running the approved plan')
    expect(w.find('.agent-msg--user').exists()).toBe(false)
  })
})
