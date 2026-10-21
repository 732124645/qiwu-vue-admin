import type { AgentItemVo } from '@qiwu/shared'
import type { AgentItem } from '../entities/agent-thread.entity.js'
import { itemVo, sharedItems, sharedTurn } from './thread-vo.js'

// 条目列表、导出与分享都经同一个映射：运行时的内部字段（工具完整输出等）绝不出现在接口里
it('itemVo leaves the runtime-only internal part out', () => {
  const row = {
    id: '7',
    seq: 3,
    turnId: '2',
    kind: 'tool_result',
    status: 'done',
    payload: {
      callId: 'c1',
      ok: true,
      preview: 'p',
      untrusted: false,
      internal: { content: 'secret rows' },
    },
    createdAt: new Date('2026-10-22T00:00:00Z'),
  } as unknown as AgentItem
  const vo = itemVo(row)
  expect(vo.payload).toEqual({ callId: 'c1', ok: true, preview: 'p', untrusted: false })
  expect(JSON.stringify(vo)).not.toContain('secret rows')
})

// 分享给别人看时只留对话文字、工具标题与状态
it('sharedItems keeps text, tool titles and statuses only; sharedTurn keeps the error code', () => {
  let id = 0
  const vo = (kind: string, payload: object, status: string | null = null) =>
    ({ id: ++id, seq: id, turnId: 1, kind, status, payload, createdAt: '' }) as AgentItemVo
  const out = sharedItems([
    vo('user', {
      text: 'hello',
      context: { route: 'demo-customer', ids: [9] },
      attachments: [{ fileId: 3, name: 'salary.csv', mime: 'text/csv', size: 9 }],
    }),
    vo('reasoning', { text: 'private thoughts' }, 'done'),
    vo(
      'approval',
      {
        callId: 'c',
        tool: 't.a.b',
        title: 'Change',
        args: { id: 1 },
        sources: [{ title: 'S', url: 'https://secret.example' }],
        note: 'secret note',
        blocked: { reason: 'permission', perm: 'iam.user.modify' },
      },
      'rejected',
    ),
    vo(
      'question',
      {
        callId: 'q',
        from: 'agent',
        questions: [{ header: 'H', question: 'secret question', options: [], multiSelect: false }],
        form: { schema: { secret: true } },
        answers: [{ header: 'H', selected: ['secret answer'] }],
      },
      'answered',
    ),
    vo('error', { code: 'E1', message: 'secret error' }),
    vo('assistant', { text: 'answer' }, 'done'),
  ])
  expect(out.map((i) => i.kind)).toEqual(['user', 'approval', 'question', 'error', 'assistant'])
  expect(out[0]!.payload).toEqual({ text: 'hello' })
  expect(out[1]!.payload).toMatchObject({
    title: 'Change',
    sources: [],
    blocked: { reason: 'permission' },
  })
  expect(out[2]!.payload).toEqual({ callId: 'q', from: 'agent', questions: [] })
  expect(out[3]!.payload).toEqual({ code: 'E1', message: '' })
  expect(out[4]!.payload).toEqual({ text: 'answer' })
  expect(JSON.stringify(out)).not.toMatch(/secret|salary|private|iam\.user|demo-customer/)
  const turn = {
    id: 1,
    threadId: 1,
    status: 'failed',
    steps: 1,
    promptTokens: 0,
    completionTokens: 0,
    error: { code: 'E1', message: 'secret error' },
    startedAt: '',
    endedAt: null,
  } as const
  expect(sharedTurn(turn).error).toEqual({ code: 'E1', message: '' })
})
