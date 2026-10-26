import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OpenAiChatModel, IMAGE_B64_MAX } from './openai-chat-model.js'
import type { ChatUsage } from './chat-model.js'

let server: Server
let baseUrl: string
let payload: object

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterAll(() => new Promise<void>((done) => server.close(() => done())))

const client = () => new OpenAiChatModel({ baseUrl, apiKey: null, models: [], retries: 0 })
const failure = (call: Promise<unknown>) =>
  call.then(
    () => {
      throw new Error('expected provider failure')
    },
    (error: unknown) => error,
  )

it('keeps reported chat usage when a successful HTTP response has no valid choice, without exposing its body', async () => {
  payload = {
    choices: [],
    usage: {
      prompt_tokens: 40,
      completion_tokens: 12,
      prompt_tokens_details: { cached_tokens: 10 },
    },
    private_body: 'never disclose this provider body',
  }
  let reported: ChatUsage | null = null
  const error = await failure(
    client().complete({
      model: 'test-model',
      messages: [],
      onUsage: (usage) => {
        reported = usage
      },
    }),
  )
  expect(error).toMatchObject({ params: { reason: 'bad_response' } })
  expect(reported).toMatchObject({
    promptTokens: 40,
    completionTokens: 12,
    cacheReadTokens: 10,
    usageReported: true,
  })
  expect(JSON.stringify(error)).not.toContain('prompt_tokens')
  expect(JSON.stringify(error)).not.toContain('never disclose')
})

it('keeps image usage before missing and oversized image validation rejects the content', async () => {
  for (const data of [[], [{ b64_json: 'A'.repeat(IMAGE_B64_MAX + 1) }]]) {
    payload = {
      data,
      usage: {
        input_tokens: 80,
        output_tokens: 60,
        input_tokens_details: { text_tokens: 30, image_tokens: 50 },
      },
    }
    let reported: ChatUsage | null = null
    const error = await failure(
      client().image({
        model: 'test-image',
        prompt: 'a simple shape',
        onUsage: (usage) => {
          reported = usage
        },
      }),
    )
    expect(error).toMatchObject({ params: { reason: data.length ? 'too_large' : 'bad_response' } })
    expect(reported).toMatchObject({
      promptTokens: 80,
      completionTokens: 60,
      inputDetails: { image_tokens: 50 },
      usageReported: true,
    })
    expect(JSON.stringify(error)).not.toContain('input_tokens')
  }
})

it('leaves genuinely missing usage unknown on a malformed response', async () => {
  payload = { choices: [] }
  let reported: ChatUsage | null = null
  await failure(
    client().complete({
      model: 'test-model',
      messages: [],
      onUsage: (usage) => {
        reported = usage
      },
    }),
  )
  expect(reported).toBeNull()
})

it('isolates receipts when concurrent calls and an already aborted call reuse the same cancellation error', async () => {
  const model = client()
  const ctrl = new AbortController()
  const reason = new Error('shared cancellation')
  const sdk = Reflect.get(model, 'client') as {
    chat: { completions: { create: () => Promise<unknown> } }
  }
  let called = 0
  vi.spyOn(sdk.chat.completions, 'create').mockImplementation(async () => {
    if (++called === 1) {
      queueMicrotask(() => ctrl.abort(reason))
      return { choices: [], usage: { prompt_tokens: 123, completion_tokens: 45 } }
    }
    throw new Error('cancelled before response')
  })
  let first: ChatUsage | null = null
  let second: ChatUsage | null = null
  const [a, b] = await Promise.all([
    failure(
      model.complete({
        model: 'model-a',
        messages: [],
        signal: ctrl.signal,
        onUsage: (usage) => {
          first = usage
        },
      }),
    ),
    failure(
      model.complete({
        model: 'model-b',
        messages: [],
        signal: ctrl.signal,
        onUsage: (usage) => {
          second = usage
        },
      }),
    ),
  ])
  expect(a).toBe(reason)
  expect(b).toBe(reason)
  expect(first).toMatchObject({ promptTokens: 123, completionTokens: 45 })
  expect(second).toBeNull()
  const again = await failure(
    model.complete({
      model: 'model-b',
      messages: [],
      signal: ctrl.signal,
      onUsage: (usage) => {
        second = usage
      },
    }),
  )
  expect(again).toBe(reason)
  expect(second).toBeNull()
  expect(first).toMatchObject({ promptTokens: 123, completionTokens: 45 })
})
