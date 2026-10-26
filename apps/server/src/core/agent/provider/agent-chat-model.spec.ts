import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ChatEvent, ChatMessage } from './chat-model.js'
import { FakeChatModel } from './fake-chat-model.js'
import { OpenAiChatModel, toWire, wireNames } from './openai-chat-model.js'

const collect = async (it: AsyncIterable<ChatEvent>) => {
  const out: ChatEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('wireNames', () => {
  it('maps tool names to function names the provider accepts and back, distinct after cleaning', () => {
    const n = wireNames(['demo.customer.search', 'demo_customer.search', 'x'.repeat(80), '$$'])
    expect(n.wire('demo.customer.search')).toBe('demo_customer_search')
    expect(n.wire('demo_customer.search')).toBe('demo_customer_search_2')
    expect(n.wire('x'.repeat(80))).toHaveLength(64)
    expect(n.wire('$$')).toBe('__')
    for (const name of ['demo.customer.search', 'demo_customer.search', 'x'.repeat(80), '$$'])
      expect(n.name(n.wire(name))).toBe(name)
    // a name the model made up stays as it came
    expect(n.name('unknown_tool')).toBe('unknown_tool')
  })
})

describe('toWire', () => {
  it('sends a user message with images as text and image_url parts, plain text as a string', () => {
    const id = (n: string) => n
    expect(toWire({ role: 'user', content: 'hi' }, id)).toEqual({ role: 'user', content: 'hi' })
    expect(
      toWire(
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', dataUrl: 'data:image/png;base64,AA' },
          ],
        },
        id,
      ),
    ).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
      ],
    })
    expect(toWire({ role: 'system', content: 's' }, id)).toEqual({ role: 'system', content: 's' })
  })
})

describe('reasoning sent back', () => {
  // a Chat Completions server that, like DeepSeek's thinking mode, answers 400 to a request with tools
  // whose earlier assistant tool-call message lacks the reasoning_content it streamed
  let server: Server
  let baseUrl = ''
  const bodies: Record<string, any>[] = []
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (d: Buffer) => (raw += d.toString()))
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, any>
        bodies.push(body)
        const prior = (body.messages as any[]).filter((m) => m.role === 'assistant')
        if (body.tools && prior.some((m) => typeof m.reasoning_content !== 'string')) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: 'missing reasoning_content' } }))
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = (delta: object, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'think', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        res.write(chunk({ role: 'assistant', reasoning_content: 'checked' }))
        res.end(`${chunk({ content: 'ok' }, 'stop')}data: [DONE]\n\n`)
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })
  afterAll(() => new Promise((r) => server.close(r)))

  const model = () =>
    new OpenAiChatModel({
      baseUrl,
      apiKey: null,
      models: [
        { id: 'think', reasoning: true },
        { id: 'plain', reasoning: false },
      ],
      retries: 0,
    })
  const history: ChatMessage[] = [
    { role: 'user', content: 'look it up' },
    {
      role: 'assistant',
      content: null,
      reasoning: 'I should search',
      reasoningModel: 'think',
      toolCalls: [{ id: 'c1', name: 'demo.customer.search', arguments: '{}' }],
    },
    { role: 'tool', toolCallId: 'c1', content: '[]' },
  ]
  const tools = [{ name: 'demo.customer.search', description: 'find', parameters: {} }]

  it('a reasoning model gets each earlier step’s reasoning_content back; others never see the field', async () => {
    const out = await collect(model().stream({ model: 'think', messages: history, tools }))
    expect(out.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
    expect(bodies.at(-1)!.messages[1]).toMatchObject({ reasoning_content: 'I should search' })
    // not flagged reasoning: the field stays off (servers may reject unknown fields)
    await expect(
      collect(model().stream({ model: 'plain', messages: history, tools })),
    ).rejects.toMatchObject({ params: { reason: 'http_400' } })
    expect(bodies.at(-1)!.messages[1]).not.toHaveProperty('reasoning_content')
    // an answer without reasoning text carries no field either
    expect(toWire({ role: 'assistant', content: 'hi' }, (n) => n, { reasoning: true })).toEqual({
      role: 'assistant',
      content: 'hi',
    })
  })

  it('applies model defaults, explicit off and the vllm thinking switch separately', async () => {
    const configured = (
      reasoningDefault: 'provider' | 'off' | 'low',
      reasoningStyle: 'standard' | 'vllm' = 'standard',
    ) =>
      new OpenAiChatModel({
        baseUrl,
        apiKey: null,
        retries: 0,
        models: [{ id: 'think', reasoning: true, reasoningDefault, reasoningStyle }],
      })
    await collect(configured('off').stream({ model: 'think', messages: [] }))
    expect(bodies.at(-1)).toMatchObject({ reasoning_effort: 'none' })
    await collect(configured('low').stream({ model: 'think', messages: [] }))
    expect(bodies.at(-1)).toMatchObject({ reasoning_effort: 'low' })
    await collect(configured('low').stream({ model: 'think', messages: [], reasoning: 'off' }))
    expect(bodies.at(-1)).toMatchObject({ reasoning_effort: 'none' })
    await collect(configured('off', 'vllm').stream({ model: 'think', messages: [] }))
    expect(bodies.at(-1)).toMatchObject({ chat_template_kwargs: { enable_thinking: false } })
    expect(bodies.at(-1)).not.toHaveProperty('reasoning_effort')
    await collect(configured('provider').stream({ model: 'think', messages: [] }))
    expect(bodies.at(-1)).not.toHaveProperty('reasoning_effort')
  })

  it('sends a reasoning text back only to the model that produced it', () => {
    const m: ChatMessage = {
      role: 'assistant',
      content: 'hi',
      reasoning: 'thought',
      reasoningModel: 'think',
    }
    expect(toWire(m, (n) => n, { reasoning: true, model: 'think' })).toMatchObject({
      reasoning_content: 'thought',
    })
    // the thread switched to another reasoning model: the earlier model's reasoning stays behind
    expect(toWire(m, (n) => n, { reasoning: true, model: 'think-2' })).not.toHaveProperty(
      'reasoning_content',
    )
    // a reasoning text without its model is never sent
    expect(
      toWire({ ...m, reasoningModel: undefined }, (n) => n, { reasoning: true, model: 'think' }),
    ).not.toHaveProperty('reasoning_content')
  })
})

describe('FakeChatModel', () => {
  it('replays the script in order and records every request', async () => {
    const fake = new FakeChatModel([
      {
        text: 'Looking it up',
        toolCalls: [{ name: 'demo.customer.search', args: { kw: 'acme' } }],
      },
      { text: 'done', usage: { promptTokens: 1, completionTokens: 2 } },
    ])
    expect(
      await collect(fake.stream({ model: 'm', messages: [{ role: 'user', content: 'q' }] })),
    ).toEqual([
      { type: 'text', delta: 'Looking ' },
      { type: 'text', delta: 'it ' },
      { type: 'text', delta: 'up' },
      {
        type: 'tool_call',
        call: { id: 'call_1_0', name: 'demo.customer.search', arguments: '{"kw":"acme"}' },
      },
      {
        type: 'usage',
        usage: expect.objectContaining({
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          usageReported: true,
        }),
      },
      { type: 'finish', reason: 'tool_calls' },
    ])
    expect(await fake.complete({ model: 'm', messages: [] })).toEqual({
      text: 'done',
      toolCalls: [],
      usage: expect.objectContaining({
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
        usageReported: true,
      }),
      finishReason: 'stop',
    })
    expect(fake.requests).toHaveLength(2)
    await expect(fake.complete({ model: 'm', messages: [] })).rejects.toThrow(/no scripted turn 3/)
  })

  it('streams a scripted reasoning summary before the text', async () => {
    const fake = new FakeChatModel([{ reasoning: 'thinking it over', text: 'ok' }])
    expect(await collect(fake.stream({ model: 'm', messages: [] }))).toEqual([
      { type: 'reasoning', delta: 'thinking it over' },
      { type: 'text', delta: 'ok' },
      {
        type: 'usage',
        usage: expect.objectContaining({
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          usageReported: true,
        }),
      },
      { type: 'finish', reason: 'stop' },
    ])
  })

  it('throws the scripted error and honours an abort while waiting', async () => {
    const boom = new Error('boom')
    const ctrl = new AbortController()
    const stop = new Error('stop')
    const fake = new FakeChatModel([{ error: boom }, { text: 'late', delayMs: 10_000 }])
    await expect(fake.complete({ model: 'm', messages: [] })).rejects.toBe(boom)
    setTimeout(() => ctrl.abort(stop), 10)
    await expect(
      collect(fake.stream({ model: 'm', messages: [], signal: ctrl.signal })),
    ).rejects.toBe(stop)
  })
})
