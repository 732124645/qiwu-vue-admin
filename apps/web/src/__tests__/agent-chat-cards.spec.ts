// Items of the assistant's conversation: a user bubble, an answer in Markdown, a tool call folded with its
// result (and the external-content tag), a plan checklist, an error; the approval card (field changes,
// sources, approve / reject once while pending, the decided state) and the question card (single and
// multiple choice, the free-text "Other", number keys, one submit, the answered state).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import type { AgentItemVo, AgentTurnVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import ApprovalCard from '@/views/platform/agent/chat/ApprovalCard.vue'
import ChatItem from '@/views/platform/agent/chat/ChatItem.vue'
import QuestionCard from '@/views/platform/agent/chat/QuestionCard.vue'
import { chatRows } from '@/views/platform/agent/chat/thread-state'
import { mockApi, ok, type Route } from './mock-api'

const AT = '2026-10-22T08:00:00.000Z'
const item = <K extends AgentItemVo['kind']>(
  id: number,
  kind: K,
  payload: Extract<AgentItemVo, { kind: K }>['payload'],
  status: AgentItemVo['status'] = null,
) =>
  ({ id, seq: id, turnId: 1, kind, status, payload, createdAt: AT }) as Extract<
    AgentItemVo,
    { kind: K }
  >

let w: VueWrapper
const global = { plugins: [ElementPlus, i18n] }
type Call = { method?: string; url?: string; data?: unknown }
const body = (c: Call | undefined) => JSON.parse(String(c?.data)) as unknown
const button = (text: string) => w.findAll('button').find((b) => b.text() === text)
/** the "don't ask again" button label for the sample tool */
const sessionLabel = () =>
  i18n.global.t('agent.chat.approval.action.approve_session', {
    tool: i18n.global.t('agent.tools.demo_customer_update.title'),
  })

/** a route that answers only when the test lets it */
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

describe('items', () => {
  it('renders each kind of item', () => {
    const rows = chatRows([
      item(1, 'user', {
        text: 'Fill in Acme',
        skill: 'fill-customer',
        context: {
          route: '/demo/customers',
          title: 'Customers',
          target: 'demo.customer',
          ids: [3, 4],
        },
      }),
      item(2, 'tool_call', {
        callId: 'c1',
        tool: 'web.search',
        title: 'Web search',
        source: 'web',
        kind: 'read',
        args: { q: 'Acme' },
      }),
      item(3, 'tool_result', {
        callId: 'c1',
        ok: true,
        preview: 'Acme Ltd, Hangzhou',
        untrusted: true,
      }),
      item(4, 'assistant', { text: 'Found **two** sources' }, 'done'),
      item(5, 'plan', {
        steps: [
          { text: 'Search', status: 'done' },
          { text: 'Update', status: 'doing' },
        ],
      }),
      item(6, 'error', { code: 'B8003', message: 'Daily limit reached' }),
    ])
    const html = rows.map((row) => mount(ChatItem, { props: { row, canFork: true }, global }))
    const [user, tool, answer, plan, error] = html
    expect(user!.find('.agent-msg--user').text()).toContain('Fill in Acme')
    expect(user!.text()).toContain('$fill-customer')
    expect(user!.text()).toMatch(/Customers\s+· 2 selected/)
    expect(user!.find('button[aria-label="Fork a new conversation from here"]').exists()).toBe(true)

    expect(tool!.find('details').exists()).toBe(true)
    expect(tool!.find('summary').text()).toContain('Search the web')
    expect(tool!.find('summary').text()).toContain('External content')
    expect(tool!.find('summary').text()).toContain('Done')
    expect(tool!.text()).toContain('"q": "Acme"')
    expect(tool!.text()).toContain('Acme Ltd, Hangzhou')

    expect(answer!.find('.qw-md strong').text()).toBe('two')
    expect(plan!.findAll('li').map((l) => l.classes())).toEqual([['is-done'], ['is-doing']])
    expect(plan!.text()).toContain('Search')
    expect(error!.find('.el-alert').text()).toContain('Daily limit reached')
    // the message only, never the raw code
    expect(error!.find('.el-alert').text()).not.toContain('B8003')
    for (const x of html) x.unmount()
  })

  it('translates error codes the page knows, falls back to a generic text, and stops a tool call whose turn ended', () => {
    const rows = chatRows(
      [
        item(1, 'error', { code: 'interrupted', message: 'interrupted' }),
        item(2, 'error', { code: 'X1', message: '' }),
        item(
          3,
          'tool_call',
          {
            callId: 'c1',
            tool: 'web.search',
            title: 'Search',
            source: 'web',
            kind: 'read',
            args: {},
          },
          'running',
        ),
      ],
      { id: 1, status: 'cancelled' } as AgentTurnVo,
    )
    const [known, unknown, tool] = rows.map((row) => mount(ChatItem, { props: { row }, global }))
    expect(known!.text()).toContain('The turn was interrupted')
    expect(unknown!.text()).toContain('Something went wrong')
    expect(unknown!.text()).not.toContain('X1')
    expect(tool!.find('summary').text()).toContain('Stopped')
    expect(tool!.find('summary').text()).not.toContain('Running')
    for (const x of [known, unknown, tool]) x!.unmount()
  })

  it('shows a tool call still running without its result, and no external tag for local content', () => {
    const [row] = chatRows([
      item(2, 'tool_call', {
        callId: 'c1',
        tool: 'demo.customer.get',
        title: '',
        source: 'local',
        kind: 'read',
        args: { id: 3 },
      }),
    ])
    w = mount(ChatItem, { props: { row: row! }, global })
    expect(w.find('summary').text()).toContain('Read a customer')
    expect(w.find('summary').text()).toContain('Running')
    expect(w.text()).not.toContain('External content')
  })

  it('renders thinking, the compaction divider, citations, follow-ups, attachments and a queued message', async () => {
    const rows = chatRows([
      item(1, 'reasoning', { text: 'Look up the registry first' }, 'done'),
      item(2, 'compaction', { upToSeq: 1, auto: true }),
      item(
        3,
        'assistant',
        {
          text: 'Acme is in Hangzhou [1].',
          citations: [
            { title: 'Acme home', url: 'https://acme.example' },
            { title: 'Bad', url: 'javascript:alert(1)' },
          ],
          suggestions: ['Update the city', 'Find the phone'],
        },
        'done',
      ),
      item(
        4,
        'user',
        {
          text: 'And the phone?',
          mode: 'queue',
          attachments: [{ fileId: 9, name: 'card.png', mime: 'image/png', size: 10 }],
        },
        'pending',
      ),
    ])
    const [thought, divider, answer, queued] = rows.map((row) =>
      mount(ChatItem, { props: { row, last: true }, global }),
    )
    expect(thought!.find('details summary').text()).toBe('Thinking')
    expect(thought!.text()).toContain('Look up the registry first')
    expect(divider!.find('[role="separator"]').text()).toBe(
      'Earlier messages were summarized automatically',
    )
    expect(answer!.findAll('.agent-msg__citations li').map((l) => l.text())).toEqual([
      'Acme home',
      'Bad',
    ])
    expect(answer!.findAll('.agent-msg__citations a')).toHaveLength(1)
    await answer!.findAll('.agent-msg__suggest button')[1]!.trigger('click')
    expect(answer!.emitted('suggest')).toEqual([['Find the phone']])
    expect(queued!.text()).toContain('card.png')
    expect(queued!.text()).toContain('Queued for the next turn')
    for (const x of [thought, divider, answer, queued]) x!.unmount()
  })

  it('copies a message, rates an answer once with an optional comment, offers edit and regenerate only when allowed', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
    const prompt = vi.spyOn(ElMessageBox, 'prompt')
    const calls = mockApi({ 'POST /agent/feedback': ok(null) })
    const [answer] = chatRows([item(3, 'assistant', { text: 'Plain **answer**' }, 'done')])
    w = mount(ChatItem, { props: { row: answer!, canFork: true }, global })
    await w.find('button[aria-label="Copy"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('Plain **answer**')

    // one row: copy and fork outside, rating and reading tools behind More
    const actions = w.findAll('.agent-msg__actions')
    expect(actions).toHaveLength(1)
    const more = w.find('button[aria-label="More actions"]')
    const extra = w.find<HTMLElement>(`#${more.attributes('aria-controls')}`)
    expect(more.attributes('aria-expanded')).toBe('false')
    expect(extra.element.style.display).toBe('none')
    expect(extra.find('button[aria-label="Not helpful"]').exists()).toBe(true)
    expect(extra.find('button[aria-label="View Markdown source"]').exists()).toBe(true)
    expect(extra.find('button[aria-label="Copy"]').exists()).toBe(false)
    await more.trigger('click')
    expect(more.attributes('aria-expanded')).toBe('true')
    expect(extra.element.style.display).toBe('')

    // cancelling the comment box sends nothing
    prompt.mockRejectedValueOnce('cancel')
    await w.find('button[aria-label="Not helpful"]').trigger('click')
    await flushPromises()
    expect(calls).toHaveLength(0)
    prompt.mockResolvedValueOnce({ value: ' wrong city ', action: 'confirm' } as never)
    await w.find('button[aria-label="Not helpful"]').trigger('click')
    await flushPromises()
    expect(body(calls[0])).toEqual({ itemId: 3, rating: -1, comment: 'wrong city' })
    expect(w.find('button[aria-label="Helpful"]').attributes('disabled')).toBeDefined()
    expect(w.find('button[aria-label="Not helpful"]').attributes('aria-pressed')).toBe('true')

    // edit from here on any user message the page allows; regenerate only on the answer it names
    const [user] = chatRows([item(1, 'user', { text: 'hi' })])
    const plain = mount(ChatItem, { props: { row: user! }, global })
    expect(plain.find('button[aria-label="Edit from here"]').exists()).toBe(false)
    plain.unmount()
    const editable = mount(ChatItem, { props: { row: user!, canEdit: true }, global })
    await editable.find('button[aria-label="Edit from here"]').trigger('click')
    expect(editable.emitted('edit')).toEqual([[1]])
    editable.unmount()
    expect(w.find('button[aria-label="Regenerate"]').exists()).toBe(false)
    const last = mount(ChatItem, { props: { row: answer!, canRegenerate: true }, global })
    await last.find('button[aria-label="Regenerate"]').trigger('click')
    expect(last.emitted('regenerate')).toEqual([[]])
    last.unmount()
    const viewed = mount(ChatItem, {
      props: { row: answer!, canRegenerate: true, readonly: true },
      global,
    })
    expect(viewed.find('button[aria-label="Regenerate"]').exists()).toBe(false)
    viewed.unmount()
    // the shared read-only view: no actions that change anything
    const shared = mount(ChatItem, {
      props: { row: answer!, canFork: true, readonly: true },
      global,
    })
    expect(shared.find('button[aria-label="Helpful"]').exists()).toBe(false)
    expect(shared.find('button[aria-label="Fork a new conversation from here"]').exists()).toBe(
      false,
    )
    shared.unmount()
  })
})

const approval = (status: AgentItemVo['status'] = 'pending', extra = {}) =>
  item(
    11,
    'approval',
    {
      callId: 'c2',
      tool: 'demo.customer.update',
      title: 'Update customer',
      args: { id: 3 },
      changes: {
        target: 'Customer #3 Acme',
        fields: [{ field: 'website', from: null, to: 'https://acme.example' }],
      },
      sources: [
        { title: 'Acme home', url: 'https://acme.example' },
        { title: 'Bad', url: 'javascript:alert(1)' },
      ],
      ...extra,
    },
    status,
  )

describe('approval card', () => {
  it('restores the confirmation button when a new preview arrives after a successful response', async () => {
    const calls = mockApi({ 'POST /agent/approvals/11': ok(null) })
    const first = 'c67cbb42-4f40-42a0-a767-870f38404c80'
    const next = '228c73ef-cfc9-4215-a56e-945c62a276de'
    w = mount(ApprovalCard, {
      props: {
        item: approval('pending', {
          perCallConfirmation: true,
          confirmationToken: first,
        }),
      },
      global,
    })
    await button('Allow once')!.trigger('click')
    await flushPromises()
    expect(button('Allow once')).toBeUndefined()
    await w.setProps({
      item: approval('pending', { perCallConfirmation: true, confirmationToken: next }),
    })
    expect(button('Allow once')).toBeDefined()
    expect(button('Allow once')!.attributes('disabled')).toBeUndefined()
    await button('Allow once')!.trigger('click')
    await flushPromises()
    expect(body(calls.filter((c) => c.url === '/agent/approvals/11').at(-1))).toEqual({
      decision: 'approve',
      confirmationToken: next,
    })
  })

  it('requires the current single-card token and resets when the preview changes during submission', async () => {
    const gate = held()
    const calls = mockApi({ 'POST /agent/approvals/11': gate.route })
    const first = '5b81926c-0d55-4b6c-92a2-ed1de60840b7'
    const next = 'eb450db4-ad5e-4d64-b9af-6e368ca8f630'
    w = mount(ApprovalCard, {
      props: {
        item: approval('pending', {
          perCallConfirmation: true,
          confirmationToken: first,
        }),
      },
      global,
    })
    expect(button('Approve for this conversation')).toBeUndefined()
    await button('Allow once')!.trigger('click')
    await flushPromises()
    expect(body(calls.find((c) => c.url === '/agent/approvals/11'))).toEqual({
      decision: 'approve',
      confirmationToken: first,
    })
    await w.setProps({
      item: approval('pending', { perCallConfirmation: true, confirmationToken: next }),
    })
    gate.release()
    await flushPromises()
    expect(button('Allow once')!.attributes('disabled')).toBeUndefined()
    await button('Allow once')!.trigger('click')
    await flushPromises()
    expect(body(calls.filter((c) => c.url === '/agent/approvals/11').at(-1))).toEqual({
      decision: 'approve',
      confirmationToken: next,
    })
  })

  it('allows once: every button disabled while the request is pending, no note is sent', async () => {
    const gate = held()
    const calls = mockApi({ 'POST /agent/approvals/11': gate.route })
    w = mount(ApprovalCard, {
      props: { item: approval('pending', { sessionAllow: true }) },
      global,
    })
    expect(w.find('tbody').text()).toContain('website')
    expect(w.find('tbody').text()).toContain('(empty)')
    expect(w.find('tbody').text()).toContain('https://acme.example')
    const links = w.findAll('.agent-approval__sources a')
    expect(links).toHaveLength(1)
    expect(links[0]!.attributes()).toMatchObject({
      href: 'https://acme.example',
      rel: 'noopener noreferrer',
    })
    // the note box opens only for a rejection
    expect(w.find('input').exists()).toBe(false)

    await button('Allow once')!.trigger('click')
    await flushPromises()
    for (const label of ['Allow once', sessionLabel(), 'Reject'])
      expect(button(label)!.attributes('disabled')).toBeDefined()
    // a second click while pending sends nothing
    await button(sessionLabel())!.trigger('click')
    gate.release()
    await flushPromises()
    const sent = calls.filter((c) => c.url === '/agent/approvals/11')
    expect(sent).toHaveLength(1)
    expect(body(sent[0])).toEqual({ decision: 'approve' })
    expect(w.emitted('decided')).toHaveLength(1)
    expect(button('Allow once')).toBeUndefined()
  })

  it('rejects through the note box ("tell the assistant"), stays open after a failure and shows the decided state', async () => {
    const calls = mockApi({
      'POST /agent/approvals/11': [409, { code: 'B8005', msg: 'closed', data: null }],
    })
    w = mount(ApprovalCard, { props: { item: approval() }, global, attachTo: document.body })
    await button('Reject')!.trigger('click')
    await flushPromises()
    expect(calls).toHaveLength(0)
    const input = w.find('input')
    expect(input.attributes('placeholder')).toBe(i18n.global.t('agent.chat.approval.note'))
    expect(document.activeElement).toBe(input.element)
    expect(button('Allow once')).toBeUndefined()
    await input.setValue('  use the other Acme ')
    await button('Reject')!.trigger('click')
    await flushPromises()
    expect(body(calls[0])).toEqual({ decision: 'reject', note: 'use the other Acme' })
    expect(button('Reject')!.attributes('disabled')).toBeUndefined()
    await w.setProps({ item: approval('rejected', { note: 'wrong company', decidedAt: AT }) })
    expect(w.text()).toContain('Rejected')
    expect(w.text()).toContain('wrong company')
    expect(button('Reject')).toBeUndefined()
  })

  it('offers "don\'t ask again for this tool" only with sessionAllow and never on a per-call confirmation', async () => {
    const calls = mockApi({ 'POST /agent/approvals/11': ok(null) })
    w = mount(ApprovalCard, { props: { item: approval() }, global })
    expect(button('Allow once')).toBeDefined()
    expect(button(sessionLabel())).toBeUndefined()
    // the per-card "cancel the turn" is gone: the composer's stop button ends the turn
    expect(button('Cancel turn')).toBeUndefined()
    w.unmount()
    w = mount(ApprovalCard, {
      props: { item: approval('pending', { sessionAllow: true, perCallConfirmation: true }) },
      global,
    })
    expect(button(sessionLabel())).toBeUndefined()
    w.unmount()
    w = mount(ApprovalCard, {
      props: { item: approval('pending', { sessionAllow: true }) },
      global,
    })
    await button(sessionLabel())!.trigger('click')
    await flushPromises()
    expect(body(calls[0])).toEqual({ decision: 'approve_session' })
    expect(w.text()).toContain('Allowed for this conversation')
  })

  it('Enter allows once and Esc opens the rejection on the focused card; in the note Enter rejects, Esc goes back', async () => {
    const calls = mockApi({ 'POST /agent/approvals/11': ok(null) })
    const decisions = () => calls.map((c) => (body(c) as { decision: string }).decision)
    w = mount(ApprovalCard, { props: { item: approval() }, global, attachTo: document.body })
    await w.find('section').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(decisions()).toEqual(['approve'])
    w.unmount()
    w = mount(ApprovalCard, { props: { item: approval() }, global, attachTo: document.body })
    await w.find('section').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(decisions()).toEqual(['approve'])
    await w.find('input').trigger('keydown', { key: 'Escape' })
    expect(w.find('input').exists()).toBe(false)
    await w.find('section').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    await w.find('input').setValue('not now')
    await w.find('input').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(decisions()).toEqual(['approve', 'reject'])
    expect(body(calls[1])).toEqual({ decision: 'reject', note: 'not now' })
  })

  it('Enter or Esc on a button or link never decides for the card; only the card itself takes them', async () => {
    const calls = mockApi({ 'POST /agent/approvals/11': ok(null) })
    w = mount(ApprovalCard, { props: { item: approval() }, global, attachTo: document.body })
    for (const k of ['Enter', 'Escape']) {
      await button('Reject')!.trigger('keydown', { key: k })
      await w.find('.agent-approval__sources a').trigger('keydown', { key: k })
    }
    await flushPromises()
    expect(calls).toHaveLength(0)
    await w.find('section').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(calls).toHaveLength(1)
  })

  it('says when a card ran because the tool was allowed for the conversation', () => {
    w = mount(ApprovalCard, {
      props: { item: approval('approved', { allowedBy: 'session', decision: 'approve_session' }) },
      global,
    })
    expect(w.text()).toContain('Ran because it is allowed for this conversation')
    expect(button('Allow once')).toBeUndefined()
  })
  it('a blocked approval explains what is missing instead of offering buttons; a shared view never decides', () => {
    w = mount(ApprovalCard, {
      props: {
        item: approval('pending', {
          blocked: { reason: 'permission', perm: 'demo.customer.modify' },
        }),
      },
      global,
    })
    expect(w.find('.el-alert').text()).toContain('Sample customers · Edit')
    expect(button('Allow once')).toBeUndefined()
    w.unmount()
    w = mount(ApprovalCard, { props: { item: approval(), readonly: true }, global })
    expect(button('Allow once')).toBeUndefined()
  })

  it('shows the automatic review: approved or rejected with the reason, or handed over with its note', () => {
    const auto = (verdict: string, reason: string) => ({ auto: { by: 'review', verdict, reason } })
    w = mount(ApprovalCard, {
      props: {
        item: approval('approved', {
          decision: 'approve',
          ...auto('approve', 'The user asked for it.'),
        }),
      },
      global,
    })
    const note = () => w.find('.agent-approval__review')
    expect(note().text()).toContain('Approved by automatic review')
    expect(note().text()).toContain('The user asked for it.')
    expect(note().text()).toContain('What the review model said:')
    expect(note().classes()).toContain('agent-approval__review--approve')
    w.unmount()
    w = mount(ApprovalCard, {
      props: {
        item: approval('rejected', { decision: 'reject', ...auto('reject', 'Wrong record.') }),
      },
      global,
    })
    expect(note().text()).toContain('Rejected by automatic review')
    expect(note().text()).toContain('Wrong record.')
    w.unmount()
    // a review rejection leaves the card to the person, with the reviewer's reason above the buttons
    w = mount(ApprovalCard, {
      props: { item: approval('pending', auto('reject', 'Looks like the wrong Acme.')) },
      global,
    })
    expect(note().text()).toContain('Automatic review suggests rejecting')
    expect(note().text()).toContain('Looks like the wrong Acme.')
    expect(note().classes()).toContain('agent-approval__review--reject')
    expect(button('Allow once')).toBeDefined()
    expect(button('Reject')).toBeDefined()
    w.unmount()
    // handed over: the note shows and the owner still decides
    w = mount(ApprovalCard, {
      props: { item: approval('pending', auto('escalate', 'Not sure.')) },
      global,
    })
    expect(note().text()).toContain('Automatic review left it to you')
    expect(note().text()).toContain('Not sure.')
    expect(button('Allow once')).toBeDefined()
    w.unmount()
    w = mount(ApprovalCard, { props: { item: approval() }, global })
    expect(note().exists()).toBe(false)
  })

  it('says why a call in the auto-review mode was not reviewed', () => {
    w = mount(ApprovalCard, {
      props: { item: approval('pending', { unreviewed: 'policy' }) },
      global,
    })
    const note = w.find('.agent-approval__review')
    expect(note.text()).toContain('Not reviewed automatically')
    expect(note.text()).toContain('"People only"')
    expect(button('Allow once')).toBeDefined()
    w.unmount()
    w = mount(ApprovalCard, {
      props: { item: approval('pending', { unreviewed: 'personal' }) },
      global,
    })
    expect(w.find('.agent-approval__review').text()).toContain('confirmed by you in person')
    w.unmount()
    w = mount(ApprovalCard, {
      props: { item: approval('pending', { unreviewed: 'read' }) },
      global,
    })
    expect(w.find('.agent-approval__review').text()).toContain('reads are never sent')
    w.unmount()
    // a reason code this page does not know yet still gets a sentence, never the bare code
    w = mount(ApprovalCard, {
      props: {
        item: approval('pending', { unreviewed: 'later_code' as 'policy' }),
      },
      global,
    })
    expect(w.find('.agent-approval__review').text()).toContain(
      'not sent to automatic review and needs your confirmation',
    )
  })
  it("says why the card asks in every mode, and a tenant's people-only restriction without review", () => {
    const whys = {
      personal: 'You confirm this action in person every time.',
      tenant: 'Your tenant administrator set this tool to "People only".',
      human: 'The platform set this tool to "People only"',
      read: 'An administrator set this read tool to ask every time.',
      ask: 'This call changes data and needs a confirmation first.',
    } as const
    for (const [why, text] of Object.entries(whys)) {
      w = mount(ApprovalCard, {
        props: { item: approval('pending', { why: why as keyof typeof whys }) },
        global,
      })
      const line = w.find('.agent-approval__why')
      expect(line.text()).toContain('Why you are asked:')
      expect(line.text()).toContain(text)
      w.unmount()
    }
    // no reason, or one this page does not know: no line rather than a bare code
    w = mount(ApprovalCard, {
      props: { item: approval('pending', { why: 'later' as 'ask' }) },
      global,
    })
    expect(w.find('.agent-approval__why').exists()).toBe(false)
    w.unmount()
    w = mount(ApprovalCard, {
      props: { item: approval('pending', { why: 'tenant', unreviewed: 'tenant' }) },
      global,
    })
    expect(w.find('.agent-approval__review').text()).toContain(
      'Your tenant set this tool to "People only"',
    )
  })

  it('does not say why you are asked on a card that never waited for you', () => {
    const decidedBy = {
      session: { allowedBy: 'session', decision: 'approve_session' },
      review: {
        decision: 'approve',
        auto: { by: 'review', verdict: 'approve', reason: 'Asked for.' },
      },
      preApproved: {
        decision: 'approve',
        auto: { by: 'pre_approved', verdict: 'approve', reason: 'Listed.' },
      },
    } as const
    for (const payload of Object.values(decidedBy)) {
      w = mount(ApprovalCard, {
        props: { item: approval('approved', { why: 'ask', ...payload }) },
        global,
      })
      expect(w.find('.agent-approval__why').exists()).toBe(false)
      w.unmount()
    }
    // the review handed it to you or advised against it: you are still asked
    w = mount(ApprovalCard, {
      props: {
        item: approval('pending', {
          why: 'ask',
          auto: { by: 'review', verdict: 'escalate', reason: 'Unclear.' },
        }),
      },
      global,
    })
    expect(w.find('.agent-approval__why').exists()).toBe(true)
  })

  it('tells a tool the tenant or the tool list keeps away from one the platform does', () => {
    const blockedText = (reason: 'policy' | 'tenant' | 'list') => {
      w?.unmount()
      w = mount(ApprovalCard, {
        props: { item: approval('pending', { why: 'ask', blocked: { reason } }) },
        global,
      })
      expect(w.find('.agent-approval__why').exists()).toBe(false)
      expect(button('Allow once')).toBeUndefined()
      return w.find('.el-alert').text()
    }
    expect(blockedText('policy')).toContain('The platform does not allow')
    expect(blockedText('tenant')).toContain('Your tenant does not allow')
    expect(blockedText('list')).toContain('tool list of the current skill or profile')
  })
})

const question = (status: AgentItemVo['status'] = 'pending', answers?: object[]) =>
  item(
    21,
    'question',
    {
      callId: 'c3',
      from: 'agent',
      questions: [
        {
          header: 'Company',
          question: 'Which Acme?',
          multiSelect: false,
          options: [{ label: 'Acme Ltd', description: 'Hangzhou' }, { label: 'Acme Inc' }],
        },
        {
          header: 'Fields',
          question: 'Fill which fields?',
          multiSelect: true,
          options: [{ label: 'Website' }, { label: 'Phone' }, { label: 'Address' }],
        },
      ],
      ...(answers ? { answers } : {}),
    } as Extract<AgentItemVo, { kind: 'question' }>['payload'],
    status,
  )

describe('question card', () => {
  const choose = async (label: string) => {
    const el = w.findAll('.el-radio, .el-checkbox').find((r) => r.text().includes(label))!
    await el.find('input').setValue(true)
    await flushPromises()
  }

  it('answers single and multiple choice plus Other text in one submit', async () => {
    const gate = held()
    const calls = mockApi({ 'POST /agent/questions/21': gate.route })
    w = mount(QuestionCard, { props: { item: question() }, global, attachTo: document.body })
    expect(w.findAll('fieldset')).toHaveLength(2)
    expect(w.text()).toContain('Hangzhou')
    // the agent's own question: no external-server warning
    expect(w.find('.agent-question__external').exists()).toBe(false)
    // nothing chosen yet: no submit
    expect(button('Submit answers')!.attributes('disabled')).toBeDefined()

    await choose('Acme Inc')
    await choose('Website')
    await choose('Address')
    expect(button('Submit answers')!.attributes('disabled')).toBeUndefined()
    // Other on the second question opens its text box; empty text alone does not count
    const others = w.findAll('.el-checkbox').filter((c) => c.text().includes('Other'))
    await others[0]!.find('input').setValue(true)
    await flushPromises()
    await w.find('input[data-other="1"]').setValue('  Founded year ')

    await button('Submit answers')!.trigger('click')
    await flushPromises()
    expect(button('Submit answers')!.attributes('disabled')).toBeDefined()
    gate.release()
    await flushPromises()
    expect(body(calls[0])).toEqual({
      answers: [
        { header: 'Company', selected: ['Acme Inc'] },
        { header: 'Fields', selected: ['Website', 'Address'], other: 'Founded year' },
      ],
    })
    expect(w.emitted('answered')).toHaveLength(1)
    // until the push arrives the card shows what was sent, read-only
    expect(w.find('fieldset').exists()).toBe(false)
    expect(w.text()).toContain('Website, Address, Founded year')
  })

  it('number keys pick options of the focused question, but not while typing Other', async () => {
    mockApi({})
    w = mount(QuestionCard, { props: { item: question() }, global, attachTo: document.body })
    const card = w.find('section')
    await card.trigger('keydown', { key: '1' })
    expect((w.findAll('.el-radio')[0]!.find('input').element as HTMLInputElement).checked).toBe(
      true,
    )
    await w.findAll('fieldset')[1]!.trigger('focusin')
    await card.trigger('keydown', { key: '2' })
    await card.trigger('keydown', { key: '3' })
    await card.trigger('keydown', { key: '2' })
    const checked = w
      .findAll('fieldset')[1]!
      .findAll('.el-checkbox')
      .filter((c) => (c.find('input').element as HTMLInputElement).checked)
      .map((c) => c.text())
    expect(checked).toEqual(['3. Address'])
    // 4 = Other: its text box opens and digits typed there stay text
    await card.trigger('keydown', { key: '4' })
    await flushPromises()
    const other = w.find('input[data-other="1"]')
    expect(other.exists()).toBe(true)
    await other.trigger('keydown', { key: '1' })
    expect(
      w
        .findAll('fieldset')[1]!
        .findAll('.el-checkbox input')
        .map((i) => (i.element as HTMLInputElement).checked),
    ).toEqual([false, false, true, true])
  })

  it('shows the answers read-only once answered', () => {
    w = mount(QuestionCard, {
      props: {
        item: question('answered', [
          { header: 'Company', selected: ['Acme Ltd'] },
          { header: 'Fields', selected: [], other: 'Everything' },
        ]),
      },
      global,
    })
    expect(w.find('fieldset').exists()).toBe(false)
    expect(w.text()).toContain('Answered')
    expect(w.find('dl').text()).toContain('CompanyAcme Ltd')
    expect(w.find('dl').text()).toContain('FieldsEverything')
    expect(button('Submit answers')).toBeUndefined()
  })

  it("renders an external server's form and submits its filled values; Decline sends a refusal", async () => {
    const calls = mockApi({ 'POST /agent/questions/22': ok(null) })
    const formItem = (status: AgentItemVo['status'] = 'pending') =>
      item(
        22,
        'question',
        {
          callId: 'c4',
          from: 'crm-server',
          questions: [],
          form: {
            title: 'Sign in to CRM',
            schema: {
              type: 'object',
              properties: {
                account: { type: 'string', title: 'Account' },
                region: { type: 'string', enum: ['east', 'west'] },
                seats: { type: 'integer', title: 'Seats' },
                remember: { type: 'boolean', title: 'Remember me' },
              },
              required: ['account'],
            },
          },
        },
        status,
      )
    w = mount(QuestionCard, { props: { item: formItem() }, global, attachTo: document.body })
    expect(w.text()).toContain('Sign in to CRM')
    expect(w.text()).toContain('From crm-server')
    // the answers leave the system: said plainly before any field
    expect(w.find('.agent-question__external').text()).toContain(
      'external server "crm-server": your answers are sent to it',
    )
    expect(w.findAll('.el-form-item__label').map((l) => l.text())).toEqual([
      'Account',
      'region',
      'Seats',
      'Remember me',
    ])
    // the required field is empty: no submit yet
    expect(button('Submit answers')!.attributes('disabled')).toBeDefined()
    await w.find('input[aria-label="Account"]').setValue(' acme ')
    await w.find('.el-switch input').setValue(true)
    await flushPromises()
    await button('Submit answers')!.trigger('click')
    await flushPromises()
    expect(body(calls[0])).toEqual({ answers: [], form: { account: 'acme', remember: true } })
    w.unmount()

    w = mount(QuestionCard, { props: { item: formItem() }, global })
    await button('Decline')!.trigger('click')
    await flushPromises()
    expect(body(calls[1])).toEqual({ decline: true })
    expect(w.text()).toContain('Declined')
    expect(button('Decline')).toBeUndefined()
  })
})
