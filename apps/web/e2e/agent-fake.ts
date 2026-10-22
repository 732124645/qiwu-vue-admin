// A tiny OpenAI-compatible Chat Completions server for the assistant specs (see docs/agent.md): listens on
// 127.0.0.1 on a free port, answers `POST <base>/chat/completions` with what the spec's `reply` returns for
// the request (plain text, or one tool call), streamed as SSE when the request asks for a stream. Root
// registers it as a provider through the API with a dummy key; provider base URLs are not address-checked,
// so the e2e server reaches it.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface WireMessage {
  role: string
  content?: unknown
}
export interface WireBody {
  model: string
  stream?: boolean
  messages: WireMessage[]
  tools?: { function: { name: string } }[]
}
/** One scripted answer: text, or a call of the offered tool whose wire name matches `tool`. */
export type FakeReply = { text: string } | { tool: RegExp; args: object }

const USAGE = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }

const chunk = (model: string, delta: object, finish: string | null = null) => ({
  id: 'chatcmpl-e2e',
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, delta, finish_reason: finish }],
})

/** The answer as SSE `data:` lines up to `[DONE]`, the way the SDK reads a stream. */
function stream(res: ServerResponse, model: string, reply: FakeReply, body: WireBody) {
  const chunks =
    'text' in reply
      ? [
          chunk(model, { role: 'assistant', content: '' }),
          chunk(model, { content: reply.text }),
          chunk(model, {}, 'stop'),
        ]
      : [
          chunk(model, {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_e2e_1',
                type: 'function',
                function: {
                  name: body.tools?.map((t) => t.function.name).find((n) => reply.tool.test(n)),
                  arguments: '',
                },
              },
            ],
          }),
          chunk(model, {
            tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.args) } }],
          }),
          chunk(model, {}, 'tool_calls'),
        ]
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const c of [...chunks, { ...chunk(model, {}), choices: [], usage: USAGE }])
    res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.end('data: [DONE]\n\n')
}

/** Whether the last message of the request is a tool result. */
export const afterTool = (body: WireBody) => body.messages.at(-1)?.role === 'tool'

/** Starts the fake model; `url` is the provider base URL (`…/v1`). */
export async function fakeModel(reply: (body: WireBody) => FakeReply) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d: Buffer) => (raw += d.toString('utf8')))
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end()
        return
      }
      const body = JSON.parse(raw) as WireBody
      const r = reply(body)
      if (body.stream) {
        stream(res, body.model, r, body)
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-e2e',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'text' in r ? r.text : '' },
              finish_reason: 'stop',
            },
          ],
          usage: USAGE,
        }),
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}
