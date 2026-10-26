// Chat page logic of the assistant: merging items and live events, the catch-up point after a reconnect,
// tool calls joined with their results, thread groups by day, `$skill` and slash command parsing, and
// the safe Markdown subset (no raw HTML, only http(s)/mailto links, opened with noopener).
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import dayjs from 'dayjs'
import type { AgentItemVo, AgentThreadVo, AgentTurnVo } from '@qiwu/shared'
import { MarkdownText } from '@/views/platform/agent/chat/markdown'
import { i18n } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import {
  applyItemEvent,
  clearHistory,
  loadDelivery,
  saveDelivery,
  catchUpSeq,
  chatRows,
  formFields,
  groupThreads,
  loadHistory,
  mentionedSkill,
  mentionPrefix,
  mergeItems,
  mergeThread,
  pushHistory,
  skillOf,
  skillPrefix,
  slashMatches,
} from '@/views/platform/agent/chat/thread-state'

const AT = '2026-10-22T08:00:00.000Z'
const item = (
  id: number,
  seq: number,
  kind: string,
  payload: object,
  status: string | null = null,
) => ({ id, seq, turnId: 1, kind, status, payload, createdAt: AT }) as AgentItemVo

describe('items and events', () => {
  it('ignores duplicate and stale committed deltas and snapshots without losing newer text', () => {
    const first = { ...item(2, 2, 'assistant', { text: 'Hello' }, 'running'), revision: 1 }
    const delta = {
      threadId: 7,
      type: 'delta' as const,
      itemId: 2,
      revision: 2,
      offset: 5,
      delta: ' world',
    }
    const current = applyItemEvent([first], delta)!
    expect(current[0]!.payload).toEqual({ text: 'Hello world' })
    expect(applyItemEvent(current, delta)![0]!.payload).toEqual({ text: 'Hello world' })
    expect(mergeItems(current, [first])[0]!.payload).toEqual({ text: 'Hello world' })
    expect(mergeItems(current, [{ ...first, revision: undefined }])[0]!.payload).toEqual({
      text: 'Hello world',
    })
    const done = {
      ...first,
      revision: 3,
      status: 'done' as const,
      payload: { text: 'Hello world' },
    } as AgentItemVo
    expect(applyItemEvent([done], delta)![0]).toEqual(done)
  })

  it('asks for a snapshot on offset gaps or mismatching overlap and counts UTF-16 offsets', () => {
    const first = { ...item(2, 2, 'assistant', { text: '🙂' }, 'running'), revision: 1 }
    const delta = {
      threadId: 7,
      type: 'delta' as const,
      itemId: 2,
      revision: 2,
      offset: 2,
      delta: '你好',
    }
    expect(applyItemEvent([first], delta)![0]!.payload).toEqual({ text: '🙂你好' })
    expect(applyItemEvent([first], { ...delta, offset: 4 })).toBeNull()
    expect(applyItemEvent([first], { ...delta, offset: 1 })).toBeNull()
    expect(
      applyItemEvent([first], { threadId: 7, type: 'delta', itemId: 2, delta: 'legacy' }),
    ).toBeNull()
    const snapshot = { ...first, revision: 3, payload: { text: '🙂你好!' } } as AgentItemVo
    expect(applyItemEvent(mergeItems([first], [snapshot]), delta)![0]!.payload).toEqual({
      text: '🙂你好!',
    })
  })

  it('keeps a newer recovery generation when an older thread snapshot arrives', () => {
    const current = { id: 7, recoveryRequired: true, recoveryRevision: 3 } as AgentThreadVo
    const stale = { id: 7, recoveryRequired: false, recoveryRevision: 2 } as AgentThreadVo
    expect(mergeThread(current, stale)).toMatchObject({
      recoveryRequired: true,
      recoveryRevision: 3,
    })
    expect(mergeThread(current, { ...stale, id: 8 })).toMatchObject({
      id: 8,
      recoveryRequired: false,
    })
  })
  it('merges by id in seq order and appends streamed text to an assistant item', () => {
    const a = item(2, 2, 'assistant', { text: 'Hel' }, 'running')
    const u = item(1, 1, 'user', { text: 'hi' })
    const merged = mergeItems([a], [u, { ...a, status: 'done' } as AgentItemVo])
    expect(merged.map((i) => [i.id, i.status])).toEqual([
      [1, null],
      [2, 'done'],
    ])
    const next = applyItemEvent([u, a], { threadId: 7, type: 'delta', itemId: 2, delta: 'lo' })!
    expect(next[1]!.payload).toEqual({ text: 'Hello' })
    // the list is new, the old one untouched (the page keeps it in a shallow ref)
    expect(a.payload).toEqual({ text: 'Hel' })
    // reasoning summaries stream too
    const r = item(3, 3, 'reasoning', { text: 'Che' }, 'running')
    expect(
      applyItemEvent([r], { threadId: 7, type: 'delta', itemId: 3, delta: 'ck' })![0]!.payload,
    ).toEqual({ text: 'Check' })
    // a delta for an item never seen asks for a catch-up
    expect(applyItemEvent([u], { threadId: 7, type: 'delta', itemId: 9, delta: 'x' })).toBeNull()
  })

  it('catches up from before the first open item, else after the last one', () => {
    const done = [item(1, 1, 'user', { text: 'a' }), item(2, 2, 'assistant', { text: 'b' }, 'done')]
    expect(catchUpSeq([])).toBe(0)
    expect(catchUpSeq(done)).toBe(2)
    const waiting = [
      ...done,
      item(3, 4, 'approval', {}, 'pending'),
      item(4, 5, 'assistant', { text: '' }, 'running'),
    ]
    expect(catchUpSeq(waiting)).toBe(3)
  })

  it('joins a tool call with its result; a result without its call stands alone', () => {
    const rows = chatRows([
      item(1, 1, 'tool_call', { callId: 'c1', tool: 'web.search', title: 'Search', args: {} }),
      item(2, 2, 'tool_result', { callId: 'c1', ok: true, preview: 'p', untrusted: true }),
      item(3, 3, 'tool_result', { callId: 'c0', ok: true, preview: 'orphan', untrusted: false }),
    ])
    expect(rows.map((r) => r.kind)).toEqual(['tool', 'item'])
    expect(rows[0]!.kind === 'tool' && rows[0]!.result?.id).toBe(2)
  })

  it('keeps streamed text when a catch-up brings the still-running item empty; the final text wins', () => {
    const local = item(2, 2, 'assistant', { text: 'Acme is a com' }, 'running')
    const empty = item(2, 2, 'assistant', { text: '' }, 'running')
    expect(mergeItems([local], [empty])[0]!.payload).toEqual({ text: 'Acme is a com' })
    const think = item(3, 3, 'reasoning', { text: 'Looking' }, 'running')
    expect(
      mergeItems([think], [{ ...think, payload: { text: '' } } as AgentItemVo])[0]!.payload,
    ).toEqual({ text: 'Looking' })
    const done = item(2, 2, 'assistant', { text: 'Acme' }, 'done')
    expect(mergeItems([local], [done])[0]!.payload).toEqual({ text: 'Acme' })
  })

  it('a tool call without a result stops with its turn and no longer holds the catch-up point', () => {
    const turn = (id: number, status: AgentTurnVo['status']) => ({ id, status }) as AgentTurnVo
    const call = item(
      5,
      3,
      'tool_call',
      { callId: 'c', tool: 't', title: 'T', args: {} },
      'running',
    )
    const items = [item(1, 1, 'user', { text: 'a' }), call, item(6, 4, 'error', {}, null)]
    const stopped = (t: AgentTurnVo | null, i = items) =>
      (chatRows(i, t).find((r) => r.kind === 'tool') as { stopped: boolean }).stopped
    expect(stopped(turn(1, 'running'))).toBe(false)
    expect(stopped(null)).toBe(false)
    expect(stopped(turn(1, 'failed'))).toBe(true)
    expect(stopped(turn(1, 'cancelled'))).toBe(true)
    // an older turn: over even while a newer one runs
    expect(stopped(turn(2, 'running'))).toBe(true)
    expect(stopped(turn(1, 'running'), [{ ...call, status: 'expired' } as AgentItemVo])).toBe(true)
    expect(catchUpSeq(items, turn(1, 'running'))).toBe(2)
    expect(catchUpSeq(items, turn(1, 'cancelled'))).toBe(4)
    expect(catchUpSeq(items, turn(2, 'running'))).toBe(4)
  })
})

describe('threads, skills and commands', () => {
  it('groups threads into today, the last 7 days and older', () => {
    const now = dayjs('2026-10-22T12:00:00')
    const th = (id: number, at: string | null, createdAt = at ?? AT) =>
      ({ id, lastActiveAt: at, createdAt }) as AgentThreadVo
    const groups = groupThreads(
      [
        th(1, '2026-10-22T09:00:00'),
        th(2, '2026-10-20T09:00:00'),
        th(3, '2026-10-01T09:00:00'),
        th(4, null, '2026-10-16T09:00:00'),
        { ...th(5, '2026-10-01T09:00:00'), pinned: true },
      ],
      now,
    )
    expect(groups.map((g) => [g.key, g.threads.map((x) => x.id)])).toEqual([
      ['pinned', [5]],
      ['today', [1]],
      ['week', [2, 4]],
      ['older', [3]],
    ])
  })

  it('finds the skill of a message and the $prefix being typed', () => {
    expect(skillOf('please $fill-customer now', ['fill-customer'])).toBe('fill-customer')
    expect(skillOf('costs $5 and $unknown', ['fill-customer'])).toBeUndefined()
    expect(skillOf('mail a$fill-customer', ['fill-customer'])).toBeUndefined()
    expect(skillPrefix('use $fi')).toBe('fi')
    expect(skillPrefix('$')).toBe('')
    expect(skillPrefix('use $fi now')).toBeNull()
  })

  it('finds the @ mention being typed and the skill a mention names', () => {
    expect(mentionPrefix('ask @')).toBe('')
    expect(mentionPrefix('ask @skill:fi')).toBe('skill:fi')
    expect(mentionPrefix('mail a@b')).toBeNull()
    expect(mentionPrefix('ask @x now')).toBeNull()
    expect(mentionedSkill('use @skill:fill-customer now', 'skill', ['fill-customer'])).toBe(
      'fill-customer',
    )
    expect(mentionedSkill('use @skill:other', 'skill', ['fill-customer'])).toBeUndefined()
    // the label is the page language's word; regex characters in it are literal
    expect(mentionedSkill('use @s.k:fill-customer', 's.k', ['fill-customer'])).toBe('fill-customer')
    expect(mentionedSkill('use @sxk:fill-customer', 's.k', ['fill-customer'])).toBeUndefined()
  })

  it('lists slash commands only while the whole input is a /prefix', () => {
    expect(slashMatches('/')).toHaveLength(10)
    expect(slashMatches('/p')).toEqual(['plan', 'prompts'])
    expect(slashMatches('/st')).toEqual(['status'])
    expect(slashMatches('/c')).toEqual(['compact', 'clear'])
    expect(slashMatches('/new please')).toBeNull()
    expect(slashMatches('a /new')).toBeNull()
  })
})

describe('form schema and input history', () => {
  it('reads the fields of a flat JSON Schema, unknown types as text', () => {
    expect(
      formFields({
        properties: {
          name: { type: 'string', title: 'Name', description: 'Legal name' },
          size: { type: 'integer' },
          ok: { type: 'boolean' },
          tier: { type: 'string', enum: ['a', 'b'] },
          extra: { type: 'array' },
        },
        required: ['name'],
      }).map((f) => [f.key, f.label, f.type, f.required, f.options.length]),
    ).toEqual([
      ['name', 'Name', 'string', true, 0],
      ['size', 'size', 'number', false, 0],
      ['ok', 'ok', 'boolean', false, 0],
      ['tier', 'tier', 'enum', false, 2],
      ['extra', 'extra', 'string', false, 0],
    ])
    expect(formFields({})).toEqual([])
  })

  it("keeps each user's sent messages, newest last, without duplicates, and survives a blocked storage", () => {
    clearHistory()
    sessionStorage.clear()
    localStorage.clear()
    pushHistory(1, 'a')
    pushHistory(1, 'b')
    expect(pushHistory(1, 'a')).toEqual(['b', 'a'])
    expect(loadHistory(1)).toEqual(['b', 'a'])
    expect(loadHistory(2)).toEqual([])
    sessionStorage.setItem('qw.agent.history.3', '{broken')
    expect(loadHistory(3)).toEqual([])
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(pushHistory(1, 'c')).toEqual(['b', 'a', 'c'])
    spy.mockRestore()
  })

  it('keeps the history in this tab only, never from a temporary thread, capped in count and size', () => {
    clearHistory()
    sessionStorage.clear()
    localStorage.clear()
    pushHistory(1, 'kept')
    // per tab: nothing outlives the tab in localStorage
    expect(localStorage.length).toBe(0)
    expect(pushHistory(1, 'off the record', { temporary: true })).toEqual(['kept'])
    expect(loadHistory(1)).toEqual(['kept'])
    // no signed-in user: nothing kept
    expect(pushHistory(0, 'anonymous')).toEqual([])
    expect(loadHistory(0)).toEqual([])
    // a message over 2000 characters is not kept
    pushHistory(1, 'x'.repeat(2001))
    expect(loadHistory(1)).toEqual(['kept'])
    for (let n = 0; n < 120; n++) pushHistory(1, `m${n}`)
    const list = loadHistory(1)
    expect(list).toHaveLength(100)
    expect(list.at(-1)).toBe('m119')
  })

  it('keeps content only in tenant-isolated memory and removes legacy plaintext history', () => {
    clearHistory()
    sessionStorage.clear()
    localStorage.clear()
    sessionStorage.setItem('qw.agent.history.1', JSON.stringify(['legacy private text']))
    clearHistory(0)
    expect(sessionStorage.getItem('qw.agent.history.1')).toBeNull()
    pushHistory(1, 'private tenant one', { tenantId: 1 })
    pushHistory(1, 'private tenant two', { tenantId: 2 })
    expect(loadHistory(1, 1)).toEqual(['private tenant one'])
    expect(loadHistory(1, 2)).toEqual(['private tenant two'])
    expect(sessionStorage.length).toBe(0)
    expect(localStorage.length).toBe(0)
    clearHistory()
    expect(loadHistory(1, 1)).toEqual([])
    expect(loadHistory(1, 2)).toEqual([])
  })

  it('persists only delivery identifiers and isolates them by actor and tenant', () => {
    sessionStorage.clear()
    const pending = {
      clientDraftId: crypto.randomUUID(),
      clientMessageId: crypto.randomUUID(),
      threadId: 7,
    }
    saveDelivery('1:1', { ...pending, text: 'must not persist' } as typeof pending)
    expect(loadDelivery('1:1')).toEqual(pending)
    expect(loadDelivery('1:2')).toBeNull()
    expect(sessionStorage.getItem('qw.agent.delivery.1:1')).not.toContain('must not persist')
    expect(
      Object.keys(JSON.parse(sessionStorage.getItem('qw.agent.delivery.1:1')!)).sort(),
    ).toEqual(['clientDraftId', 'clientMessageId', 'threadId'])
    saveDelivery('1:1', null)
    expect(loadDelivery('1:1')).toBeNull()
    const blocked = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    try {
      expect(saveDelivery('1:1', pending)).toBe(false)
      expect(blocked).toHaveBeenCalledTimes(1)
    } finally {
      blocked.mockRestore()
    }
  })

  it('clears memory history and receipt identifiers on sign-out even without a mounted chat', () => {
    accessToken.value = 'fixture-session'
    pushHistory(1, 'Private in-memory history')
    saveDelivery('1:1', {
      clientDraftId: crypto.randomUUID(),
      clientMessageId: crypto.randomUUID(),
      threadId: 7,
    })
    accessToken.value = ''
    expect(loadHistory(1)).toEqual([])
    expect(loadDelivery('1:1')).toBeNull()
  })
})

describe('markdown', () => {
  const html = (text: string) =>
    mount(MarkdownText, { props: { text }, global: { plugins: [i18n] } })

  it('renders paragraphs, lists, code, tables and links', () => {
    const w = html(
      [
        '# Title',
        'Some **bold** and `code`, see [docs](https://example.com/a).',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '',
        '| Name | City |',
        '| --- | --- |',
        '| Acme | Hangzhou |',
        '',
        '```',
        '<b>kept as text</b>',
        '```',
      ].join('\n'),
    )
    expect(w.find('h3').text()).toBe('Title')
    expect(w.findAll('ul li').map((l) => l.text())).toEqual(['one', 'two'])
    expect(w.findAll('ol li').map((l) => l.text())).toEqual(['first'])
    expect(w.findAll('td').map((c) => c.text())).toEqual(['Acme', 'Hangzhou'])
    expect(w.find('pre code').text()).toBe('<b>kept as text</b>')
    expect(w.find('pre b').exists()).toBe(false)
    const a = w.find('a')
    expect(a.attributes()).toMatchObject({
      href: 'https://example.com/a',
      target: '_blank',
      rel: 'noopener noreferrer',
    })
  })

  it('renders headings as heading elements and a table right after a paragraph', () => {
    const w = html('## Totals\nBy city:\n| City | Count |\n| --- | --- |\n| Hangzhou | 2 |')
    expect(w.find('h4').text()).toBe('Totals')
    expect(w.find('p').text()).toBe('By city:')
    expect(w.findAll('th').map((c) => c.text())).toEqual(['City', 'Count'])
    expect(w.findAll('td').map((c) => c.text())).toEqual(['Hangzhou', '2'])
  })

  it('never renders raw HTML or script links; an unclosed fence stays code while streaming', () => {
    const w = html('<img src=x onerror=alert(1)> [x](javascript:alert(1))\n\n```js\nlet a = 1')
    expect(w.find('img').exists()).toBe(false)
    expect(w.find('a').exists()).toBe(false)
    expect(w.text()).toContain('<img src=x onerror=alert(1)>')
    expect(w.find('pre code').text()).toBe('let a = 1')
  })
})
